/**
 * ZcodeSessionRuntime — JSON-RPC NDJSON client for `zcode app-server`.
 *
 * The ZCode CLI exposes the ZCode Protocol over stdio: the client sends
 * `{id, method, params}` lines and reads `{id, result} | {id, error}`
 * responses plus `{method, params}` notifications and `{id, method, params}`
 * server-initiated requests on the same stream. Server requests must be
 * answered or the originating call hangs:
 *
 *   - `session/requestRuntimePreferences` → `{nativeSearchEnhancementsEnabled}`
 *   - `interaction/requestOfficialMcpAuthHeaders` /
 *     `interaction/requestProviderRuntimeHeaders` → `{headers: {}}`
 *   - `interaction/requestPermission` → `{optionId}` picked from the
 *     request's own `options[]` (resolved through the caller-supplied
 *     permission handler, e.g. the adapter's approval bridge)
 *   - `interaction/requestUserInput` → `{action, content?}` (caller-supplied
 *     handler, defaults to decline)
 *   - anything else → JSON-RPC `-32601 Method not found`
 *
 * One runtime owns one `zcode app-server` process. `makeZcodeAppServer`
 * spawns the process in a Scope; closing the scope kills it and fails every
 * pending request. `requestZcodeAppServerOnce` covers single-shot probes
 * (`workspace/readState`, `session/list`, …) with default handlers.
 *
 * @module provider/Layers/ZcodeSessionRuntime
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

export const ZCODE_RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
} as const;

export interface ZcodeNotification {
  readonly method: string;
  readonly params: unknown;
}

export interface ZcodeServerRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

export interface ZcodeRequestError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

class ZcodeRuntimeError extends Error {
  readonly _tag = "ZcodeRuntimeError";
  readonly method: string;
  readonly detail: unknown;
  constructor(method: string, message: string, detail?: unknown) {
    super(message);
    this.name = "ZcodeRuntimeError";
    this.method = method;
    this.detail = detail;
  }
}

export interface ZcodeServerRequestHandlers {
  /**
   * Resolve `interaction/requestPermission`. Receives the raw params
   * (including the server-built `options[]` with `optionId` + `response`
   * pairs) and returns the `optionId` to answer with. Failures fall back to
   * the default deny option.
   */
  readonly onPermissionRequest?: (params: unknown) => Effect.Effect<string, Error>;
  /**
   * Resolve `interaction/requestUserInput`. Returns the full result payload
   * (`{action: "accept", content}` / `{action: "decline"}` / …). Failures
   * fall back to decline.
   */
  readonly onUserInputRequest?: (params: unknown) => Effect.Effect<unknown, Error>;
  readonly onHeadersRequest?: (params: unknown) => Effect.Effect<Record<string, string>, Error>;
}

export interface ZcodeAppServerOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly handlers?: ZcodeServerRequestHandlers;
}

export interface ZcodeAppServer {
  /** Send a request and await its result (fails when the process dies). */
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, ZcodeRuntimeError>;
  /** Server push notifications (`state.updated`, `computer-use/…`, …). */
  readonly notifications: Stream.Stream<ZcodeNotification>;
  /** Server-initiated requests that no handler answered (diagnostics). */
  readonly unhandledServerRequests: Stream.Stream<ZcodeServerRequest>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function permissionOptionsFromParams(params: unknown): Array<{ optionId: string; kind: string }> {
  if (!isRecord(params) || !Array.isArray(params.options)) {
    return [];
  }
  const options: Array<{ optionId: string; kind: string }> = [];
  for (const entry of params.options) {
    if (!isRecord(entry) || typeof entry.optionId !== "string") {
      continue;
    }
    options.push({
      optionId: entry.optionId,
      kind: typeof entry.kind === "string" ? entry.kind : "",
    });
  }
  return options;
}

/** Default `optionId` choice without user interaction: deny, else first option. */
export function defaultZcodePermissionOptionId(params: unknown): string {
  const options = permissionOptionsFromParams(params);
  const deny = options.find((option) => option.kind === "deny" || option.optionId === "deny");
  return deny?.optionId ?? options[0]?.optionId ?? "deny";
}

function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Best-effort NDJSON line parse. Non-JSON lines yield `undefined`. */
function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export const makeZcodeAppServer = Effect.fn("makeZcodeAppServer")(function* (
  options: ZcodeAppServerOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(options.command, options.args ?? ["app-server"], {
    env: options.env ?? process.env,
  }).pipe(
    Effect.mapError(
      (cause) => new ZcodeRuntimeError("spawn", `Failed to resolve ZCode command.`, cause),
    ),
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.env ?? process.env,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new ZcodeRuntimeError("spawn", `Failed to spawn ZCode app-server.`, cause),
      ),
    );

  const nextId = yield* Ref.make(1);
  const pending = new Map<number, Deferred.Deferred<unknown, ZcodeRuntimeError>>();
  const writeQueue = yield* Queue.unbounded<string>();
  const notificationQueue = yield* Queue.unbounded<ZcodeNotification>();
  const unhandledQueue = yield* Queue.unbounded<ZcodeServerRequest>();
  const closed = yield* Deferred.make<void>();
  const handlers = options.handlers ?? {};

  const failAllPending = (error: ZcodeRuntimeError) =>
    Effect.forEach(Array.from(pending.values()), (deferred) => Deferred.fail(deferred, error), {
      discard: true,
    });

  // Outgoing pump: queue → child stdin.
  const writerFiber = yield* Stream.fromQueue(writeQueue).pipe(
    Stream.encodeText,
    (stream) => Stream.run(stream, child.stdin),
    Effect.ignore,
    Effect.forkScoped,
  );

  const sendRaw = (value: unknown) =>
    Queue.offer(writeQueue, encodeLine(value)).pipe(Effect.asVoid);

  const answerServerRequest = (id: string | number, result: unknown) => sendRaw({ id, result });

  const answerServerError = (id: string | number, code: number, message: string) =>
    sendRaw({ id, error: { code, message } });

  const handleServerRequest = (id: string | number, method: string, params: unknown) =>
    Effect.gen(function* () {
      switch (method) {
        case "session/requestRuntimePreferences": {
          return yield* answerServerRequest(id, { ...ZCODE_RUNTIME_PREFERENCES });
        }
        case "interaction/requestOfficialMcpAuthHeaders":
        case "interaction/requestProviderRuntimeHeaders": {
          const headers = handlers.onHeadersRequest
            ? yield* handlers
                .onHeadersRequest(params)
                .pipe(Effect.orElseSucceed(() => ({}) as Record<string, string>))
            : ({} as Record<string, string>);
          return yield* answerServerRequest(id, { headers });
        }
        case "interaction/requestPermission": {
          if (!handlers.onPermissionRequest) {
            return yield* answerServerRequest(id, {
              optionId: defaultZcodePermissionOptionId(params),
            });
          }
          const optionId = yield* handlers
            .onPermissionRequest(params)
            .pipe(Effect.orElseSucceed(() => defaultZcodePermissionOptionId(params)));
          return yield* answerServerRequest(id, { optionId });
        }
        case "interaction/requestUserInput": {
          if (!handlers.onUserInputRequest) {
            return yield* answerServerRequest(id, { action: "decline" });
          }
          const result = yield* handlers
            .onUserInputRequest(params)
            .pipe(Effect.orElseSucceed(() => ({ action: "decline" }) as const));
          return yield* answerServerRequest(id, result);
        }
        default: {
          yield* Queue.offer(unhandledQueue, { id, method, params });
          return yield* answerServerError(id, -32601, `Method not found: ${method}`);
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.andThen(
          Effect.logWarning("ZCode server-request handler failed.", { method, cause }),
          answerServerError(id, -32603, `Handler failed for ${method}`).pipe(Effect.ignore),
        ),
      ),
    );

  const handleLine = (line: string) =>
    Effect.gen(function* () {
      const parsed = parseJsonLine(line);
      if (!isRecord(parsed)) {
        return;
      }
      // Client response: `{id: number, result} | {id: number, error}`.
      if (typeof parsed.id === "number" && ("result" in parsed || "error" in parsed)) {
        const deferred = pending.get(parsed.id);
        if (!deferred) {
          return;
        }
        pending.delete(parsed.id);
        if ("error" in parsed) {
          const error = (parsed.error ?? {}) as Record<string, unknown>;
          yield* Deferred.fail(
            deferred,
            new ZcodeRuntimeError(
              "request",
              typeof error.message === "string" ? error.message : "ZCode request failed.",
              error,
            ),
          );
        } else {
          yield* Deferred.succeed(deferred, parsed.result);
        }
        return;
      }
      // Server-initiated request: `{id: string, method, params}`.
      if (parsed.id !== undefined && typeof parsed.method === "string") {
        yield* handleServerRequest(parsed.id as string | number, parsed.method, parsed.params);
        return;
      }
      // Plain notification: `{method, params}`.
      if (parsed.id === undefined && typeof parsed.method === "string") {
        yield* Queue.offer(notificationQueue, { method: parsed.method, params: parsed.params });
      }
    });

  // Incoming pump: child stdout → line handler.
  const readerFiber = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => handleLine(line)),
    Effect.ignore,
    Effect.forkScoped,
  );

  // Drain stderr so a chatty server can never block on a full pipe.
  const stderrFiber = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runDrain,
    Effect.ignore,
    Effect.forkScoped,
  );

  // Process supervision: closing the scope kills the child; a dead child
  // fails every pending request so callers never hang.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Fiber.interrupt(writerFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(readerFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);
      yield* Effect.ignore(child.kill());
      const exitCode = yield* child.exitCode.pipe(Effect.ignore);
      void exitCode;
      yield* failAllPending(new ZcodeRuntimeError("app-server", "ZCode app-server exited.")).pipe(
        Effect.ignore,
      );
      yield* Deferred.succeed(closed, undefined).pipe(Effect.ignore);
    }),
  );

  // Watch for unexpected exits while the scope is still open.
  yield* child.exitCode.pipe(
    Effect.andThen((code) =>
      Effect.andThen(
        failAllPending(
          new ZcodeRuntimeError("app-server", `ZCode app-server exited with code ${code}.`),
        ),
        Deferred.succeed(closed, undefined),
      ),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  const request = (method: string, params: unknown) =>
    Effect.gen(function* () {
      const id = yield* Ref.getAndUpdate(nextId, (current) => current + 1);
      const deferred = yield* Deferred.make<unknown, ZcodeRuntimeError>();
      pending.set(id, deferred);
      yield* sendRaw({ id, method, params });
      return yield* Deferred.await(deferred).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      );
    });

  // `Stream.fromQueue` never ends on its own; the scope finalizer interrupts
  // consumers when the process is torn down.
  const server: ZcodeAppServer = {
    request,
    notifications: Stream.fromQueue(notificationQueue),
    unhandledServerRequests: Stream.fromQueue(unhandledQueue),
  };
  return server;
});

/**
 * Single-shot probe helper: spawns `zcode app-server`, answers server
 * requests with defaults, awaits one `{method, params}` call, tears down.
 */
export const requestZcodeAppServerOnce = Effect.fn("requestZcodeAppServerOnce")(function* (input: {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly method: string;
  readonly params: unknown;
  readonly timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? 30_000;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const server = yield* makeZcodeAppServer({
        command: input.command,
        ...(input.args ? { args: input.args } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
      const result = yield* server.request(input.method, input.params);
      return result;
    }).pipe(Effect.timeoutOption(timeoutMs)),
  ).pipe(
    Effect.flatMap((option) =>
      Option.isSome(option)
        ? Effect.succeed(option.value)
        : Effect.fail(
            new ZcodeRuntimeError(input.method, `ZCode request timed out after ${timeoutMs}ms.`),
          ),
    ),
  );
});
