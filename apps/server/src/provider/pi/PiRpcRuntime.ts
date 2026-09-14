/**
 * PiRpcRuntime — live JSONL client for `pi --mode rpc`.
 *
 * One runtime owns one `pi --mode rpc` child process (one pi session).
 * Commands are written as `{ type, id, ... }` lines; responses
 * (`{ type: "response", id?, command, success, data?, error? }`) resolve the
 * matching pending request by `id`; everything else is published as an event.
 *
 * Lifecycle: `makePiRpcRuntime` must run in a `Scope` (the adapter's session
 * scope). Closing the scope kills the child and resolves pending requests
 * with a synthetic failure. Two runtimes never share mutable state.
 *
 * @module provider/pi/PiRpcRuntime
 */
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import type { PiThinkingLevel } from "./PiRpcProtocol.ts";

export class PiRpcError extends Schema.TaggedError<PiRpcError>()("PiRpcError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}

export interface PiRpcCommand {
  readonly type: string;
  readonly id?: string | undefined;
  readonly [key: string]: unknown;
}

export interface PiRpcResponse {
  readonly type: "response";
  readonly id?: string | undefined;
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string | undefined;
}

export interface PiRpcEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPiRpcResponse(value: unknown): value is PiRpcResponse {
  return isRecord(value) && value.type === "response" && typeof value.command === "string";
}

export interface PiRpcModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

function toPiRpcModelInfo(value: unknown): PiRpcModelInfo | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  if (!id || !provider) return undefined;
  return {
    id,
    name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : id,
    provider,
    reasoning: value.reasoning === true,
    contextWindow:
      typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow)
        ? Math.floor(value.contextWindow)
        : 128_000,
    maxTokens:
      typeof value.maxTokens === "number" && Number.isFinite(value.maxTokens)
        ? Math.floor(value.maxTokens)
        : 16_384,
  };
}

export interface PiRpcRuntimeOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Persist sessions under this dir (`--session-dir`). Omit for pi default. */
  readonly sessionDir?: string | undefined;
  /** Start ephemeral (`--no-session`): no session file is written. */
  readonly ephemeral?: boolean | undefined;
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  readonly appendSystemPrompts?: ReadonlyArray<string> | undefined;
}

export interface PiRpcRuntime {
  readonly events: Stream.Stream<PiRpcEvent>;
  readonly send: (command: PiRpcCommand) => Effect.Effect<PiRpcResponse, PiRpcError>;
  /**
   * Fire-and-forget write (e.g. `extension_ui_response`, which pi does not
   * acknowledge with a `response`). Never waits for a reply.
   */
  readonly notify: (command: PiRpcCommand) => Effect.Effect<void, PiRpcError>;
  readonly prompt: (
    message: string,
    images?: ReadonlyArray<{ data: string; mimeType: string }>,
  ) => Effect.Effect<PiRpcResponse, PiRpcError>;
  readonly abort: () => Effect.Effect<PiRpcResponse, PiRpcError>;
  readonly getAvailableModels: () => Effect.Effect<ReadonlyArray<PiRpcModelInfo>, PiRpcError>;
  readonly getState: () => Effect.Effect<Record<string, unknown>, PiRpcError>;
  readonly getMessages: () => Effect.Effect<ReadonlyArray<Record<string, unknown>>, PiRpcError>;
  readonly getSessionStats: () => Effect.Effect<Record<string, unknown>, PiRpcError>;
  readonly setModel: (
    provider?: string,
    modelId?: string,
  ) => Effect.Effect<PiRpcResponse, PiRpcError>;
  readonly setThinkingLevel: (level: PiThinkingLevel) => Effect.Effect<PiRpcResponse, PiRpcError>;
  readonly newSession: () => Effect.Effect<PiRpcResponse, PiRpcError>;
  readonly getCommands: () => Effect.Effect<ReadonlyArray<Record<string, unknown>>, PiRpcError>;
  readonly compact: (customInstructions?: string) => Effect.Effect<PiRpcResponse, PiRpcError>;
}

export function buildPiRpcSpawnArgs(options: {
  readonly sessionDir?: string | undefined;
  readonly ephemeral?: boolean | undefined;
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  readonly appendSystemPrompts?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const args = ["--mode", "rpc"];
  if (options.ephemeral) {
    args.push("--no-session");
  } else if (options.sessionDir?.trim()) {
    args.push("--session-dir", options.sessionDir.trim());
  }
  if (options.provider?.trim()) args.push("--provider", options.provider.trim());
  if (options.modelId?.trim()) args.push("--model", options.modelId.trim());
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  for (const prompt of options.appendSystemPrompts ?? []) {
    if (prompt.trim()) args.push("--append-system-prompt", prompt);
  }
  return args;
}

interface PendingRequest {
  readonly command: string;
  readonly deferred: Deferred.Deferred<PiRpcResponse>;
}

const PiRpcCommandJsonSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const encodeCommandLineJson = Schema.encodeSync(PiRpcCommandJsonSchema);

function encodeCommandLine(command: PiRpcCommand): string {
  return `${encodeCommandLineJson(command)}\n`;
}

export function makePiRpcRuntime(
  options: PiRpcRuntimeOptions,
): Effect.Effect<
  PiRpcRuntime,
  PiRpcError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const command = options.binaryPath.trim() || "pi";
    const args = buildPiRpcSpawnArgs(options);
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      args,
      options.environment ? { env: options.environment } : {},
    ).pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcError({ operation: "spawn", detail: `Failed to resolve pi command.`, cause }),
      ),
    );
    const child = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: options.cwd,
      ...(options.environment ? { env: options.environment } : {}),
      shell: spawnCommand.shell,
      stdin: { stream: "pipe", endOnDone: false },
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: Duration.seconds(2),
    });
    const handle = yield* Effect.acquireRelease(
      spawner
        .spawn(child)
        .pipe(
          Effect.mapError(
            (cause) => new PiRpcError({ operation: "spawn", detail: `Failed to spawn pi.`, cause }),
          ),
        ),
      (childHandle) => childHandle.kill().pipe(Effect.ignore),
    );

    const pending = new Map<string, PendingRequest>();
    const pendingByCommand = new Map<string, Array<PendingRequest & { readonly id: string }>>();
    const events = yield* PubSub.unbounded<PiRpcEvent>();
    const writeLock = yield* Semaphore.make(1);
    const closed = yield* Ref.make(false);

    const failAllPending = (detail: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const all: PendingRequest[] = [
          ...pending.values(),
          ...[...pendingByCommand.values()].flat(),
        ];
        pending.clear();
        pendingByCommand.clear();
        yield* Effect.forEach(
          all,
          (entry) =>
            Deferred.succeed(entry.deferred, {
              type: "response",
              command: entry.command,
              success: false,
              error: detail,
            }),
          { discard: true },
        );
      });

    const resolveResponse = (response: PiRpcResponse): Effect.Effect<void> =>
      Effect.gen(function* () {
        const id = response.id?.trim();
        if (id) {
          const entry = pending.get(id);
          if (entry) {
            pending.delete(id);
            const queue = pendingByCommand.get(entry.command);
            if (queue) {
              const next = queue.filter((candidate) => candidate.id !== id);
              if (next.length === 0) pendingByCommand.delete(entry.command);
              else pendingByCommand.set(entry.command, next);
            }
            yield* Deferred.succeed(entry.deferred, response);
            return;
          }
        }
        // Tolerate id-less responses by resolving the oldest pending request
        // for the same command.
        const queue = pendingByCommand.get(response.command);
        const fallback = queue?.shift();
        if (fallback) {
          if (queue?.length === 0) pendingByCommand.delete(response.command);
          pending.delete(fallback.id);
          yield* Deferred.succeed(fallback.deferred, response);
        }
        // Unmatched responses (late duplicates after a timeout) are dropped.
      });

    // Drain stderr so a chatty child can never block on a full pipe.
    yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

    const readerFiber = yield* handle.stdout.pipe(
      Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
      Stream.runForEach((value) =>
        isPiRpcResponse(value)
          ? resolveResponse(value)
          : PubSub.publish(events, value as PiRpcEvent).pipe(Effect.asVoid),
      ),
      Effect.catchCause((cause) =>
        failAllPending(`Pi RPC stream closed.`).pipe(
          Effect.andThen(Effect.logDebug("Pi RPC reader failed.", { cause })),
        ),
      ),
      Effect.forkScoped,
    );

    // A dead child must not leave turns hanging: resolve pending requests
    // with a failure and publish a terminal marker the adapter maps to
    // `turn.completed`.
    yield* handle.exitCode.pipe(
      Effect.flatMap((code) =>
        failAllPending(`Pi exited with code ${Number(code)}.`).pipe(
          Effect.andThen(PubSub.publish(events, { type: "pi_process_exited", code: Number(code) })),
          Effect.asVoid,
        ),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Ref.set(closed, true);
        yield* Fiber.interrupt(readerFiber).pipe(Effect.ignore);
        yield* failAllPending(`Pi RPC runtime closed.`).pipe(Effect.ignore);
      }),
    );

    const writeLine = (line: string, operation: string): Effect.Effect<void, PiRpcError> =>
      writeLock.withPermits(1)(
        Stream.run(Stream.encodeText(Stream.make(line)), handle.stdin).pipe(
          Effect.mapError(
            (cause) =>
              new PiRpcError({
                operation,
                detail: `Failed to write pi stdin.`,
                cause,
              }),
          ),
        ),
      );

    const send = (command: PiRpcCommand): Effect.Effect<PiRpcResponse, PiRpcError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) {
          return yield* new PiRpcError({ operation: command.type, detail: `Runtime is closed.` });
        }
        const id =
          command.id?.trim() ||
          (yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(
              (cause) =>
                new PiRpcError({ operation: command.type, detail: `No request id.`, cause }),
            ),
          ));
        const deferred = yield* Deferred.make<PiRpcResponse>();
        const entry: PendingRequest = { command: command.type, deferred };
        pending.set(id, entry);
        const queue = pendingByCommand.get(command.type) ?? [];
        queue.push({ ...entry, id });
        pendingByCommand.set(command.type, queue);
        yield* writeLine(encodeCommandLine({ ...command, id }), command.type).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              pending.delete(id);
              const current = pendingByCommand.get(command.type);
              if (current) {
                const next = current.filter((candidate) => candidate.id !== id);
                if (next.length === 0) pendingByCommand.delete(command.type);
                else pendingByCommand.set(command.type, next);
              }
            }),
          ),
        );
        return yield* Deferred.await(deferred);
      });

    const notify = (command: PiRpcCommand): Effect.Effect<void, PiRpcError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) {
          return yield* new PiRpcError({ operation: command.type, detail: `Runtime is closed.` });
        }
        yield* writeLine(encodeCommandLine(command), command.type);
      });

    const requireSuccess = (
      command: string,
      response: PiRpcResponse,
    ): Effect.Effect<PiRpcResponse, PiRpcError> =>
      response.success
        ? Effect.succeed(response)
        : Effect.fail(
            new PiRpcError({
              operation: command,
              detail: response.error?.trim() || `Pi rejected the ${command} command.`,
            }),
          );

    return {
      events: Stream.fromPubSub(events),
      send,
      notify,
      prompt: (message, images) =>
        send({
          type: "prompt",
          message,
          ...(images && images.length > 0
            ? {
                images: images.map((image) => ({
                  type: "image",
                  data: image.data,
                  mimeType: image.mimeType,
                })),
              }
            : {}),
        }).pipe(Effect.flatMap((response) => requireSuccess("prompt", response))),
      abort: () => send({ type: "abort" }),
      getMessages: () =>
        send({ type: "get_messages" }).pipe(
          Effect.flatMap((response) => requireSuccess("get_messages", response)),
          Effect.map((response) => {
            const data = isRecord(response.data) ? response.data : {};
            const messages = Array.isArray((data as Record<string, unknown>).messages)
              ? ((data as Record<string, unknown>).messages as unknown[])
              : [];
            return messages.flatMap((entry) =>
              isRecord(entry) ? [entry as Record<string, unknown>] : [],
            );
          }),
        ),
      getSessionStats: () =>
        send({ type: "get_session_stats" }).pipe(
          Effect.flatMap((response) => requireSuccess("get_session_stats", response)),
          Effect.map((response) =>
            isRecord(response.data) ? (response.data as Record<string, unknown>) : {},
          ),
        ),
      getAvailableModels: () =>
        send({ type: "get_available_models" }).pipe(
          Effect.flatMap((response) => requireSuccess("get_available_models", response)),
          Effect.map((response) => {
            const data = isRecord(response.data) ? response.data : {};
            const models = Array.isArray((data as Record<string, unknown>).models)
              ? ((data as Record<string, unknown>).models as unknown[])
              : [];
            return models.flatMap((entry) => {
              const info = toPiRpcModelInfo(entry);
              return info ? [info] : [];
            });
          }),
        ),
      getState: () =>
        send({ type: "get_state" }).pipe(
          Effect.flatMap((response) => requireSuccess("get_state", response)),
          Effect.map((response) =>
            isRecord(response.data) ? (response.data as Record<string, unknown>) : {},
          ),
        ),
      setModel: (provider, modelId) =>
        send({
          type: "set_model",
          ...(provider?.trim() ? { provider: provider.trim() } : {}),
          ...(modelId?.trim() ? { modelId: modelId.trim() } : {}),
        }).pipe(Effect.flatMap((response) => requireSuccess("set_model", response))),
      setThinkingLevel: (level) =>
        send({ type: "set_thinking_level", level }).pipe(
          Effect.flatMap((response) => requireSuccess("set_thinking_level", response)),
        ),
      newSession: () =>
        send({ type: "new_session" }).pipe(
          Effect.flatMap((response) => requireSuccess("new_session", response)),
        ),
      getCommands: () =>
        send({ type: "get_commands" }).pipe(
          Effect.flatMap((response) => requireSuccess("get_commands", response)),
          Effect.map((response) => {
            const data = isRecord(response.data) ? response.data : {};
            const commands = Array.isArray((data as Record<string, unknown>).commands)
              ? ((data as Record<string, unknown>).commands as unknown[])
              : [];
            return commands.flatMap((entry) =>
              isRecord(entry) ? [entry as Record<string, unknown>] : [],
            );
          }),
        ),
      compact: (customInstructions) =>
        send({
          type: "compact",
          ...(customInstructions?.trim() ? { customInstructions: customInstructions.trim() } : {}),
        }).pipe(Effect.flatMap((response) => requireSuccess("compact", response))),
    } satisfies PiRpcRuntime;
  });
}
