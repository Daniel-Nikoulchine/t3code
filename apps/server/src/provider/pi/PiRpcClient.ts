/**
 * PiRpcClient — Effect transport for the Pi / Oh-My-Pi `--mode rpc` JSONL
 * protocol.
 *
 * One client owns one harness subprocess (`pi --mode rpc` / `omp --mode rpc`):
 * commands are written as single JSON lines to stdin and correlated with
 * `{"type":"response"}` replies by `id`, while all other lines are published
 * as agent events. Malformed lines are logged and skipped so a single bad
 * frame can never kill the reader.
 *
 * The transport is an interface (`PiRpcTransport`) so tests inject an
 * in-memory duplex instead of spawning a process; production uses
 * `makePiRpcProcessTransport`.
 *
 * @module provider/pi/PiRpcClient
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  isPiRpcEvent,
  isPiRpcResponse,
  parseRpcLine,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcResponse,
} from "./PiRpcProtocol.ts";

export class PiRpcTransportError extends Schema.TaggedError<PiRpcTransportError>()(
  "PiRpcTransportError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC transport failed: ${this.detail}`;
  }
}

export class PiRpcCommandError extends Schema.TaggedError<PiRpcCommandError>()(
  "PiRpcCommandError",
  {
    command: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Pi RPC command '${this.command}' was rejected: ${this.detail}`;
  }
}

export class PiRpcTimeoutError extends Schema.TaggedError<PiRpcTimeoutError>()(
  "PiRpcTimeoutError",
  {
    command: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Pi RPC command '${this.command}' timed out after ${this.timeoutMs}ms.`;
  }
}

export class PiRpcClosedError extends Schema.TaggedError<PiRpcClosedError>()("PiRpcClosedError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return `Pi RPC client is closed: ${this.detail}`;
  }
}

export type PiRpcClientError =
  | PiRpcTransportError
  | PiRpcCommandError
  | PiRpcTimeoutError
  | PiRpcClosedError;

const encodeRpcLine = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

/** Line-oriented duplex to one harness process. */
export interface PiRpcTransport {
  readonly writeLine: (line: string) => Effect.Effect<void, PiRpcTransportError>;
  readonly lines: Stream.Stream<string, PiRpcTransportError>;
  readonly close: Effect.Effect<void>;
}

export interface PiRpcProcessTransportInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Forward stderr to the Effect logger instead of draining silently. */
  readonly logStderr?: boolean;
}

/**
 * Spawn the harness process and expose it as a `PiRpcTransport`. Runs in the
 * caller's scope: closing the scope kills the child; `close` kills it
 * without closing the scope.
 */
export const makePiRpcProcessTransport = Effect.fn("makePiRpcProcessTransport")(function* (
  input: PiRpcProcessTransportInput,
): Effect.fn.Return<
  PiRpcTransport,
  PiRpcTransportError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(input.command, [...input.args], {
    ...(input.env ? { env: input.env } : {}),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new PiRpcTransportError({
          detail: `Failed to resolve Pi command '${input.command}'.`,
          cause,
        }),
    ),
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
        extendEnv: true,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcTransportError({
            detail: `Failed to spawn Pi command '${input.command}'.`,
            cause,
          }),
      ),
    );

  // Stderr is never protocol data; drain it so a chatty child cannot block
  // on a full pipe buffer, optionally surfacing it for diagnostics.
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      input.logStderr === true
        ? Effect.logDebug("Pi RPC stderr.", { chunk: chunk.slice(-2000) })
        : Effect.void,
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  // The child stdin sink is single-use: one `Stream.run` owns it for the
  // transport's lifetime, fed by an unbounded queue. Individual `Stream.run`
  // calls per write would hang after the first line (verified). Queue.offer
  // never blocks, so concurrent requests serialize without head-of-line
  // blocking; shutdown ends the pump.
  const stdinQueue = yield* Queue.unbounded<string>();
  yield* Stream.fromQueue(stdinQueue).pipe(
    Stream.encodeText,
    (lines) => Stream.run(lines, child.stdin),
    Effect.catchCause((cause) => Effect.logWarning("Pi RPC stdin pump failed.", { cause })),
    Effect.forkScoped,
  );

  const writeLine = (line: string) =>
    Queue.offer(stdinQueue, `${line}\n`).pipe(
      Effect.flatMap((offered) =>
        offered
          ? Effect.void
          : Effect.fail(new PiRpcTransportError({ detail: "Pi RPC stdin is closed." })),
      ),
      Effect.mapError((cause) =>
        cause._tag === "PiRpcTransportError"
          ? cause
          : new PiRpcTransportError({ detail: "Failed to write Pi RPC stdin.", cause }),
      ),
    );
  const lines: Stream.Stream<string, PiRpcTransportError> = child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapError(
      (cause) => new PiRpcTransportError({ detail: "Failed to read Pi RPC stdout.", cause }),
    ),
  );
  const close = Effect.gen(function* () {
    yield* Queue.shutdown(stdinQueue).pipe(Effect.ignore);
    yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
  }).pipe(Effect.asVoid);
  return { writeLine, lines, close };
});

export interface PiRpcClient {
  /** Send a command and await its correlated response data. */
  readonly request: (
    command: PiRpcCommand,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, PiRpcClientError>;
  /**
   * Fire-and-forget write: no `id` is attached, so the harness emits no
   * response. Used for `extension_ui_response` frames, which the harness
   * consumes without replying.
   */
  readonly notify: (
    message: Record<string, unknown>,
  ) => Effect.Effect<void, PiRpcTransportError | PiRpcClosedError>;
  /** Async agent events (never responses). */
  readonly events: Stream.Stream<PiRpcEvent>;
  /** Resolve pending requests as closed and kill the transport. Idempotent. */
  readonly close: Effect.Effect<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Multiplex one transport into id-correlated requests plus an event stream.
 * Runs in the caller's scope: the reader fiber is scoped, and `close` is
 * registered as a scope finalizer.
 */
export const makePiRpcClient = Effect.fn("makePiRpcClient")(function* (
  transport: PiRpcTransport,
): Effect.fn.Return<PiRpcClient, never, Scope.Scope> {
  const pending = yield* Ref.make(
    new Map<string, Deferred.Deferred<PiRpcResponse, PiRpcClosedError>>(),
  );
  const idCounter = yield* Ref.make(0);
  const closed = yield* Ref.make(false);
  // A queue, not a PubSub: agent events must survive the gap between client
  // creation and the adapter's first subscription. PubSub drops publishes
  // without subscribers; the queue buffers them.
  const runtimeEvents = yield* Queue.unbounded<PiRpcEvent>();

  const handleLine = (line: string) =>
    Effect.gen(function* () {
      let parsed: PiRpcResponse | PiRpcEvent | undefined;
      try {
        parsed = parseRpcLine(line);
      } catch (cause) {
        yield* Effect.logWarning("Pi RPC line was not valid protocol; skipping.", {
          line: line.slice(0, 500),
          cause: cause instanceof Error ? cause.message : String(cause),
        });
        return;
      }
      if (parsed === undefined) return;
      if (isPiRpcResponse(parsed)) {
        const responseId = parsed.id;
        if (!responseId) {
          yield* Effect.logDebug("Pi RPC response without id; dropping.", {
            command: parsed.command,
          });
          return;
        }
        const deferred = (yield* Ref.get(pending)).get(responseId);
        if (!deferred) {
          yield* Effect.logDebug("Pi RPC response for unknown request; dropping.", {
            id: responseId,
          });
          return;
        }
        yield* Ref.update(pending, (current) => {
          const next = new Map(current);
          next.delete(responseId);
          return next;
        });
        yield* Deferred.succeed(deferred, parsed).pipe(Effect.ignore);
        return;
      }
      if (isPiRpcEvent(parsed)) {
        yield* Queue.offer(runtimeEvents, parsed).pipe(Effect.ignore);
      }
    });

  yield* transport.lines.pipe(
    Stream.runForEach(handleLine),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) return;
        yield* Effect.logWarning("Pi RPC reader failed.", { cause: String(cause) });
        yield* Queue.shutdown(runtimeEvents).pipe(Effect.ignore);
      }),
    ),
    Effect.forkScoped,
  );

  const close = Effect.gen(function* () {
    const alreadyClosed = yield* Ref.getAndSet(closed, true);
    if (alreadyClosed) return;
    const outstanding = yield* Ref.getAndSet(pending, new Map());
    yield* Effect.forEach(
      Array.from(outstanding.values()),
      (deferred) =>
        Deferred.fail(
          deferred,
          new PiRpcClosedError({ detail: "The Pi RPC client was closed." }),
        ).pipe(Effect.ignore),
      { discard: true },
    );
    yield* transport.close.pipe(Effect.ignore);
    yield* Queue.shutdown(runtimeEvents).pipe(Effect.ignore);
  });
  yield* Effect.addFinalizer(() => close);

  const request: PiRpcClient["request"] = (command, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) =>
    Effect.gen(function* () {
      if (yield* Ref.get(closed)) {
        return yield* new PiRpcClosedError({ detail: "request on a closed client." });
      }
      const id = `t3-${yield* Ref.updateAndGet(idCounter, (count) => count + 1)}`;
      const deferred = yield* Deferred.make<PiRpcResponse, PiRpcClosedError>();
      yield* Ref.update(pending, (current) => new Map(current).set(id, deferred));
      yield* transport.writeLine(encodeRpcLine({ ...command, id })).pipe(
        Effect.mapError((cause) => cause as PiRpcClientError),
        Effect.onError(() =>
          Ref.update(pending, (current) => {
            const next = new Map(current);
            next.delete(id);
            return next;
          }),
        ),
      );
      const response = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Ref.update(pending, (current) => {
                const next = new Map(current);
                next.delete(id);
                return next;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new PiRpcTimeoutError({ command: command.type, timeoutMs }) as PiRpcClientError,
                  ),
                ),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );
      if (!response.success) {
        return yield* new PiRpcCommandError({
          command: response.command || command.type,
          detail: response.error?.trim() || "The harness rejected the command.",
        });
      }
      return response.data;
    });

  return {
    request,
    notify: (message) =>
      Effect.gen(function* () {
        if (yield* Ref.get(closed)) {
          return yield* new PiRpcClosedError({ detail: "notify on a closed client." });
        }
        yield* transport.writeLine(encodeRpcLine(message));
      }),
    events: Stream.fromQueue(runtimeEvents),
    close,
  };
});

/** In-memory transport for tests: scripted lines in, captured writes out. */
export const makeTestPiRpcTransport = Effect.fn("makeTestPiRpcTransport")(function* (input?: {
  readonly lines?: ReadonlyArray<string> | Stream.Stream<string, PiRpcTransportError>;
  readonly onWrite?: (line: string) => Effect.Effect<void>;
}): Effect.fn.Return<
  PiRpcTransport & { readonly written: ReadonlyArray<string> },
  never,
  Scope.Scope
> {
  const written: string[] = [];
  const closed = yield* Ref.make(false);
  const onWrite = input?.onWrite ?? (() => Effect.void);
  const source =
    input?.lines && Stream.isStream(input.lines)
      ? input.lines
      : Stream.fromIterable((input?.lines ?? []) as ReadonlyArray<string>);
  const transport: PiRpcTransport = {
    writeLine: (line) =>
      Ref.get(closed).pipe(
        Effect.flatMap((isClosed) =>
          isClosed
            ? Effect.fail(new PiRpcTransportError({ detail: "Test transport is closed." }))
            : Effect.suspend(() => {
                written.push(line);
                return onWrite(line);
              }),
        ),
      ),
    lines: source,
    close: Ref.set(closed, true).pipe(Effect.asVoid),
  };
  return { ...transport, written };
});
