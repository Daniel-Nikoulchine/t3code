// @effect-diagnostics preferSchemaOverJson:off -- Pi RPC fixtures are raw JSONL frames.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makePiRpcClient, makeTestPiRpcTransport } from "./PiRpcClient.ts";

/** Await the next written command line without touching the clock. */
const awaitWrittenCommand = (writes: Queue.Queue<string>) =>
  Queue.take(writes).pipe(Effect.map((line) => JSON.parse(line) as Record<string, unknown>));

const makeObservedTransport = Effect.gen(function* () {
  const writes = yield* Queue.unbounded<string>();
  const lines = yield* Queue.unbounded<string>();
  const transport = yield* makeTestPiRpcTransport({
    lines: Stream.fromQueue(lines),
    onWrite: (line) => Queue.offer(writes, line).pipe(Effect.asVoid),
  });
  return { writes, lines, transport };
});

describe("PiRpcClient", () => {
  it.effect("correlates requests with responses by id", () =>
    Effect.gen(function* () {
      const { writes, lines, transport } = yield* makeObservedTransport;
      const client = yield* makePiRpcClient(transport);
      const fiber = yield* Effect.forkScoped(
        Effect.exit(client.request({ type: "get_state" }, 5_000)),
      );
      const written = yield* awaitWrittenCommand(writes);
      expect(written.type).toBe("get_state");
      const id = written.id as string;
      expect(typeof id).toBe("string");
      yield* Queue.offer(
        lines,
        JSON.stringify({
          type: "response",
          command: "get_state",
          success: true,
          id,
          data: { ok: true },
        }),
      );
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toEqual({ ok: true });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("surfaces command rejections as PiRpcCommandError", () =>
    Effect.gen(function* () {
      const { writes, lines, transport } = yield* makeObservedTransport;
      const client = yield* makePiRpcClient(transport);
      const fiber = yield* Effect.forkScoped(
        Effect.exit(client.request({ type: "prompt", message: "hi" }, 5_000)),
      );
      const written = yield* awaitWrittenCommand(writes);
      yield* Queue.offer(
        lines,
        JSON.stringify({
          type: "response",
          command: "prompt",
          success: false,
          id: written.id,
          error: "No API key",
        }),
      );
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toMatch(/PiRpcCommandError/);
        expect(String(exit.cause)).toContain("No API key");
      }
    }).pipe(Effect.scoped),
  );

  it.effect("times out requests without a response", () =>
    Effect.gen(function* () {
      const { transport } = yield* makeObservedTransport;
      const client = yield* makePiRpcClient(transport);
      const fiber = yield* Effect.forkScoped(
        Effect.exit(client.request({ type: "get_state" }, 20)),
      );
      yield* TestClock.adjust(100);
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toMatch(/timed out after 20ms/);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("skips malformed lines and routes events to the event stream", () =>
    Effect.gen(function* () {
      const { lines, transport } = yield* makeObservedTransport;
      const client = yield* makePiRpcClient(transport);
      const eventsFiber = yield* Effect.forkScoped(
        Stream.runCollect(client.events.pipe(Stream.take(2))),
      );
      yield* Queue.offer(lines, "{not json");
      yield* Queue.offer(lines, JSON.stringify({ type: "nope" }));
      yield* Queue.offer(lines, JSON.stringify({ type: "turn_start" }));
      // Response for an unknown request id is dropped, not routed to events.
      yield* Queue.offer(
        lines,
        JSON.stringify({ type: "response", command: "abort", success: true, id: "ghost" }),
      );
      yield* Queue.offer(lines, JSON.stringify({ type: "agent_end", messages: [] }));
      const events = Array.from(yield* Fiber.join(eventsFiber));
      expect(events.map((event) => event.type)).toEqual(["turn_start", "agent_end"]);
      yield* client.close;
    }).pipe(Effect.scoped),
  );

  it.effect("close fails outstanding requests and is idempotent", () =>
    Effect.gen(function* () {
      const { writes, transport } = yield* makeObservedTransport;
      const client = yield* makePiRpcClient(transport);
      const fiber = yield* Effect.forkScoped(
        Effect.exit(client.request({ type: "get_state" }, 5_000)),
      );
      yield* awaitWrittenCommand(writes);
      yield* client.close;
      yield* client.close;
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toMatch(/PiRpcClosedError/);
      }
      const afterClose = yield* Effect.exit(client.request({ type: "get_state" }, 50));
      expect(Exit.isFailure(afterClose)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("fails writes after the transport is closed", () =>
    Effect.gen(function* () {
      const { transport } = yield* makeObservedTransport;
      const client = yield* makePiRpcClient(transport);
      yield* transport.close;
      const exit = yield* Effect.exit(client.request({ type: "abort" }, 50));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(String(exit.cause)).toMatch(/PiRpcTransportError/);
      }
    }).pipe(Effect.scoped),
  );
});
