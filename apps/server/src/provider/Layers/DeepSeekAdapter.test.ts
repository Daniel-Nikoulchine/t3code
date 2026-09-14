// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  DeepSeekSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  deepseekPromptSettlementBelongsToContext,
  makeDeepSeekAdapter,
  selectDeepSeekPermissionOptionId,
} from "./DeepSeekAdapter.ts";
const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockDeepSeekWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-acp-mock-"));
  extraEnv = { T3_ACP_DEEPSEEK: "1", ...extraEnv };
  const wrapperPath = NodePath.join(dir, "fake-deepseek.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const deepseekAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-deepseek-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDeepSeekAdapter>[1]) =>
  makeDeepSeekAdapter(decodeDeepSeekSettings({ binaryPath }), options).pipe(Effect.orDie);

function deepseekPermissionRequest(
  options: ReadonlyArray<{
    readonly optionId: string;
    readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>,
) {
  return {
    sessionId: "mock-session-1",
    toolCall: {
      toolCallId: "tool-call-1",
      title: "cat package.json",
      kind: "execute" as const,
      status: "pending" as const,
    },
    options: options.map((option) => ({
      optionId: option.optionId,
      name: option.kind,
      kind: option.kind,
    })),
  };
}

it("maps Always allow to allow_once when DeepSeek omits allow_always", () => {
  const request = deepseekPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);

  assert.equal(selectDeepSeekPermissionOptionId(request, "acceptForSession"), "allow-once");
  assert.equal(selectDeepSeekPermissionOptionId(request, "accept"), "allow-once");
  assert.equal(selectDeepSeekPermissionOptionId(request, "decline"), "reject-once");
});

it("prefers allow_always when DeepSeek offers it", () => {
  const request = deepseekPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);

  assert.equal(selectDeepSeekPermissionOptionId(request, "acceptForSession"), "allow-always");
  assert.equal(selectDeepSeekPermissionOptionId(request, "accept"), "allow-once");
});

it("requires a settlement to match the live DeepSeek turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    deepseekPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    deepseekPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    deepseekPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it.layer(deepseekAdapterTestLayer)("DeepSeekAdapterLive", (it) => {
  it.effect("sends runtime context with the current model without changing saved prompts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-runtime-context");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-runtime-context-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-pro",
        },
      });
      yield* adapter.sendTurn({ threadId, input: "First prompt" });
      yield* adapter.sendTurn({
        threadId,
        input: "Second prompt",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });
      const snapshot = yield* adapter.readThread(threadId);
      assert.deepEqual(
        snapshot.turns.map((turn) => turn.items),
        [
          [
            {
              prompt: [{ type: "text", text: "First prompt" }],
              result: { stopReason: "end_turn" },
            },
          ],
          [
            {
              prompt: [{ type: "text", text: "Second prompt" }],
              result: { stopReason: "end_turn" },
            },
          ],
        ],
      );
      yield* adapter.stopSession(threadId);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests
        .filter((request) => request.method === "session/prompt")
        .map(
          (request) => (request.params as { prompt: Array<{ type: string; text: string }> }).prompt,
        );
      assert.equal(prompts.length, 2);
      assert.deepEqual(prompts[0]?.[0], { type: "text", text: "First prompt" });
      assert.include(prompts[0]?.[1]?.text, "DeepSeek harness, as deepseek-v4-pro");
      assert.deepEqual(prompts[1]?.[0], { type: "text", text: "Second prompt" });
      assert.include(prompts[1]?.[1]?.text, "DeepSeek harness, as deepseek-v4-flash");
      assert.include(prompts[1]?.[1]?.text, "with low reasoning effort");
      assert.include(prompts[1]?.[1]?.text, "embed images and videos");
    }),
  );

  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockDeepSeekWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-pro",
        },
      });

      assert.equal(session.provider, "deepseek");
      assert.equal(session.model, "deepseek-v4-pro");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello deepseek",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("reports a DeepSeek session running only while the prompt is in flight", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-session-ready-after-prompt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "check lifecycle", attachments: [] })
        .pipe(Effect.forkChild);
      const requestOpenedEvent = yield* Deferred.await(requestOpened);

      const runningSessions = yield* adapter.listSessions();
      const runningSession = runningSessions.find((session) => session.threadId === threadId);
      assert.equal(runningSession?.status, "running");
      assert.isDefined(runningSession?.activeTurnId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores ready without completing an unstarted turn when preparation fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-preparation-failure-while-connecting");
      const wrapperPath = yield* Effect.promise(() => makeMockDeepSeekWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "prepare invalid attachment",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.isUndefined(turnCompletedEvent);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not time out a DeepSeek turn before ACP emits progress", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-watchdog-silent-turn");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "turn.started") {
            yield* Deferred.succeed(turnStarted, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "silence forever", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnStarted);

      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;
      const steerSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "keep reasoning", attachments: [] })
        .pipe(Effect.forkChild);
      for (let yieldAttempt = 0; yieldAttempt < 12; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow;
      assert.lengthOf(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ),
        0,
      );

      yield* adapter.interruptTurn(threadId);
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(steerSendTurnFiber);

      assert.equal(completed.payload.state, "cancelled");
      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails a DeepSeek turn that stalls after ACP content begins", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-watchdog-content-stall");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_EMIT_CONTENT_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const contentDelta = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "content.delta") {
            yield* Deferred.succeed(contentDelta, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "start then stall", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(contentDelta).pipe(Effect.timeout("2 seconds"), TestClock.withLive);

      yield* TestClock.adjust("999 millis");
      yield* Effect.yieldNow;
      assert.lengthOf(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ),
        0,
      );

      yield* TestClock.adjust("1 millis");
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(sendTurnFiber);

      assert.equal(completed.payload.state, "failed");
      assert.equal(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ).length,
        1,
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("refreshes DeepSeek liveness when a turn is steered", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-watchdog-steer");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_EMIT_CONTENT_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const contentDelta = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "content.delta") {
            yield* Deferred.succeed(contentDelta, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "start then steer", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(contentDelta).pipe(Effect.timeout("2 seconds"), TestClock.withLive);

      yield* TestClock.adjust("999 millis");
      const steerSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "continue working", attachments: [] })
        .pipe(Effect.forkChild);
      for (let yieldAttempt = 0; yieldAttempt < 12; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      yield* TestClock.adjust("1 millis");
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      assert.lengthOf(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ),
        0,
      );

      yield* adapter.interruptTurn(threadId);
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(firstSendTurnFiber);
      yield* Fiber.interrupt(steerSendTurnFiber);
      assert.equal(completed.payload.state, "cancelled");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("refreshes DeepSeek liveness when ACP updates its plan", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-watchdog-plan-stall");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_EMIT_PLAN_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
      });
      const planUpdated = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.plan.updated") {
            yield* Deferred.succeed(planUpdated, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "update plan then stall", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(planUpdated).pipe(Effect.timeout("2 seconds"), TestClock.withLive);

      yield* TestClock.adjust("1 second");
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(sendTurnFiber);

      assert.equal(completed.payload.state, "failed");
      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("settles a stalled DeepSeek turn after the active-tool deadline", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-watchdog-active-tool");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        turnInactivityTimeoutMs: 1_000,
        activeToolInactivityTimeoutMs: 5_000,
      });
      const activeTool = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          runtimeEvents.push(event);
          if (event.type === "item.updated") {
            yield* Deferred.succeed(activeTool, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "run a long tool", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(activeTool).pipe(Effect.timeout("2 seconds"), TestClock.withLive);
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      yield* TestClock.adjust("4999 millis");
      yield* Effect.yieldNow;
      assert.lengthOf(
        runtimeEvents.filter(
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        ),
        0,
      );
      assert.equal(
        (yield* adapter.listSessions()).find((candidate) => candidate.threadId === threadId)
          ?.status,
        "running",
      );

      yield* TestClock.adjust("1 millis");
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const completed = yield* Deferred.await(turnCompleted).pipe(
        Effect.timeout("2 seconds"),
        TestClock.withLive,
      );
      yield* Fiber.join(sendTurnFiber);
      assert.equal(completed.payload.state, "failed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("retains turn transcript when interrupt arrives after prompt success", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-send-turn-interrupt-after-prompt");
      const wrapperPath = yield* Effect.promise(() => makeMockDeepSeekWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
      });

      const completed = yield* adapter.sendTurn({
        threadId,
        input: "interrupt after prompt",
        attachments: [],
      });

      // Interrupting a settled turn is a no-op and must not wipe the transcript.
      yield* adapter.interruptTurn(threadId, completed.turnId);

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.items.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("lets Stop unblock a fully silent DeepSeek prompt and accept a follow-up turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-stop-after-full-silence");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter.sendTurn({
        threadId,
        input: "continue after stop",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const followUpCompletedEvents = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(followUpCompletedEvents, 1);
      assert.equal(followUpCompletedEvents[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not let a cancelled prompt settlement consume the follow-up prompt slot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-cancelled-settlement-before-follow-up");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-acp-cancel-race-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const twoTurnsCompleted = yield* Deferred.make<void>();
      const completedCountRef = yield* Ref.make(0);
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type !== "turn.completed") {
            return;
          }
          const completedCount = yield* Ref.updateAndGet(completedCountRef, (count) => count + 1);
          if (completedCount === 2) {
            yield* Deferred.succeed(twoTurnsCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel this prompt", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      const followUp = yield* adapter
        .sendTurn({ threadId, input: "complete the follow-up", attachments: [] })
        .pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(twoTurnsCompleted).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.notEqual(String(followUp.turnId), String(firstTurnId));
      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(firstTurnId), "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("cancels an in-flight prompt when a mid-turn sendTurn steers", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-steer-cancels-in-flight");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-acp-steer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hang until steered", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      const steered = yield* adapter
        .sendTurn({ threadId, input: "take this instead", attachments: [] })
        .pipe(Effect.timeout("3 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

      const requestLog = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requestLog.flatMap((entry) =>
        typeof entry.method === "string" ? [entry.method] : [],
      );
      const turnStartedEvents = runtimeEvents.filter(
        (event) => event.type === "turn.started" && String(event.threadId) === String(threadId),
      );
      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(String(steered.turnId), String(firstTurnId));
      assert.isTrue(methods.includes("session/cancel"));
      assert.isAtLeast(methods.filter((method) => method === "session/prompt").length, 2);
      assert.lengthOf(turnStartedEvents, 1);
      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(turnCompletedEvents[0]?.payload.state, "completed");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect(
    "steers a prompt that has not started ACP yet instead of letting it start after cancel",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("deepseek-steer-during-prep");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-acp-steer-prep-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockDeepSeekWrapper({
            T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const firstTurnStarted = yield* Deferred.make<TurnId>();
        const turnCompleted = yield* Deferred.make<void>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (event.type === "turn.started" && event.turnId !== undefined) {
              yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
              return;
            }
            if (event.type === "turn.completed") {
              yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("deepseek"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const firstSendTurnFiber = yield* adapter
          .sendTurn({ threadId, input: "still preparing", attachments: [] })
          .pipe(Effect.forkChild);
        const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(
          Effect.timeout("2 seconds"),
        );

        const steered = yield* adapter
          .sendTurn({ threadId, input: "steer before first prompt starts", attachments: [] })
          .pipe(Effect.timeout("3 seconds"));
        yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
        yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

        const turnCompletedEvents = runtimeEvents.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
        const readySessions = yield* adapter.listSessions();
        const readySession = readySessions.find((session) => session.threadId === threadId);

        assert.equal(String(steered.turnId), String(firstTurnId));
        assert.lengthOf(turnCompletedEvents, 1);
        assert.equal(turnCompletedEvents[0]?.payload.state, "completed");
        assert.equal(readySession?.status, "ready");
        assert.isUndefined(readySession?.activeTurnId);

        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(threadId);
      }).pipe(TestClock.withLive),
  );

  it.effect("keeps the original prompt running when a steer fails during preparation", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-failed-steer-keeps-original-prompt");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-acp-failed-steer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hang until a failed steer", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));

      const steerError = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const sessionsAfterFailedSteer = yield* adapter.listSessions();
      const sessionAfterFailedSteer = sessionsAfterFailedSteer.find(
        (session) => session.threadId === threadId,
      );
      const completedBeforeInterrupt = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(steerError._tag, "ProviderAdapterValidationError");
      assert.equal(sessionAfterFailedSteer?.status, "running");
      assert.equal(String(sessionAfterFailedSteer?.activeTurnId), String(firstTurnId));
      assert.lengthOf(completedBeforeInterrupt, 0);
      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(firstTurnId));
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not double-complete when interrupt wins before a prompt starts ACP", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-interrupt-before-prompt-start");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "interrupt before prompt starts", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("3 seconds"));
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("3 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(firstTurnId));
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("drops late ACP notifications after a turn is cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-drop-late-cancelled-notifications");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
        }),
      );
      const lateNativeUpdate = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://deepseek-cancelled-native-events",
          write: (record: unknown) =>
            JSON.stringify(record).includes("late after cancel")
              ? Deferred.succeed(lateNativeUpdate, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before the late update", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(lateNativeUpdate).pipe(Effect.timeout("2 seconds"));
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "turn.completed" &&
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === "cancelled",
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterCancellation = runtimeEvents
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );

      assert.isAtLeast(cancelledIndex, 0);
      assert.deepEqual(outputAfterCancellation, []);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("settles the in-flight prompt before emitting completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-completion-before-next-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockDeepSeekWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const completedCountRef = yield* Ref.make(0);
      const secondTurnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type !== "turn.completed" || String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }

        return Ref.modify(completedCountRef, (count) => {
          const nextCount = count + 1;
          return [nextCount, nextCount] as const;
        }).pipe(
          Effect.flatMap((count) => {
            if (count === 1) {
              return adapter
                .sendTurn({
                  threadId,
                  input: "second turn after completion",
                  attachments: [],
                })
                .pipe(Effect.forkChild, Effect.asVoid);
            }
            if (count === 2) {
              return Deferred.succeed(secondTurnCompleted, undefined).pipe(Effect.asVoid);
            }
            return Effect.void;
          }),
        );
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* Deferred.await(secondTurnCompleted);

      const completedCount = yield* Ref.get(completedCountRef);
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(completedCount, 2);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores a DeepSeek session to ready when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-prompt-failure-ready");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_FAIL_PROMPT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "fail prompt",
          attachments: [],
        }),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      assert.equal(failedTurnCompleted?.type, "turn.completed");
      if (failedTurnCompleted?.type === "turn.completed") {
        assert.equal(failedTurnCompleted.payload.state, "failed");
        assert.isString(failedTurnCompleted.payload.errorMessage);
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("switches models through session/set_config_option, never session/set_model", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-model-switch");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-acp-model-switch-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "switch to the reasoner",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-pro",
        },
      });

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.model, "deepseek-v4-pro");

      const requestLog = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const methods = requestLog.flatMap((entry) =>
        typeof entry.method === "string" ? [entry.method] : [],
      );
      // The official harness does not implement session/set_model; the mock
      // rejects it, so its absence proves the adapter honors the contract.
      assert.notInclude(methods, "session/set_model");
      const modelUpdates = requestLog.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          typeof entry.params === "object" &&
          entry.params !== null &&
          (entry.params as Record<string, unknown>).configId === "model",
      );
      assert.isAtLeast(modelUpdates.length, 1);
      const modelValues = modelUpdates.map(
        (entry) => (entry.params as { value?: unknown } | undefined)?.value,
      );
      assert.include(modelValues, '["deepseek-official","deepseek-v4-pro"]');

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores replayed session/load updates when resuming a DeepSeek session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_EMIT_LOAD_REPLAY: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockDeepSeekWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("deepseek-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("deepseek"),
            model: "deepseek-v4-flash",
          },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-empty-turn");

      const wrapperPath = yield* Effect.promise(() => makeMockDeepSeekWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("deepseek"),
          model: "deepseek-v4-flash",
        },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-custom-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "agent-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "agent-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps a DeepSeek turn running when Always allow has no allow_always option", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-always-allow-without-allow-always");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "deepseek-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_OMIT_ALLOW_ALWAYS: "1",
          T3_ACP_PERMISSION_REQUEST_COUNT: "2",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const openedCount = yield* Ref.make(0);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Effect.gen(function* () {
              yield* Ref.update(openedCount, (count) => count + 1);
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "acceptForSession",
              );
            })
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "approve this session",
        attachments: [],
      });

      assert.equal(yield* Ref.get(openedCount), 1);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const permissionResults = requests.filter(
        (entry) =>
          !("method" in entry) &&
          typeof entry.result === "object" &&
          entry.result !== null &&
          "outcome" in entry.result &&
          typeof entry.result.outcome === "object" &&
          entry.result.outcome !== null &&
          "optionId" in entry.result.outcome,
      );
      assert.equal(permissionResults.length, 2);
      assert.isTrue(
        permissionResults.every(
          (entry) =>
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "allow-once",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("asks before a different command after Always allow this session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-session-approval-scope");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDeepSeekWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_OMIT_ALLOW_ALWAYS: "1",
          T3_ACP_PERMISSION_REQUEST_COUNT: "2",
          T3_ACP_PERMISSION_TITLE: "Terminal",
          T3_ACP_SECOND_PERMISSION_COMMAND: "rm server/package.json",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const openedCount = yield* Ref.make(0);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(openedCount, (value) => value + 1);
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                count === 1 ? "acceptForSession" : "decline",
              );
            })
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "check approval scope", attachments: [] });
      assert.equal(yield* Ref.get(openedCount), 2);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("continues streaming events when native notification logging fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-native-log-failure");
      const wrapperPath = yield* Effect.promise(() => makeMockDeepSeekWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://deepseek-native-events",
          write: (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            typeof record.event === "object" &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const contentDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("deepseek"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* Deferred.await(contentDelta);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the notification consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every later session/update
  // was dropped: the thread sat on "Working" forever while the provider
  // streamed its whole turn. Every other test here calls startSession directly
  // from the test fiber, which never completes, so the consumer survived and
  // the bug stayed invisible. Running it in a fiber that finishes is what
  // reproduces production.
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("deepseek-consumer-outlives-start-session");
      const wrapperPath = yield* Effect.promise(() => makeMockDeepSeekWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("deepseek"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting it
      // directly would hang until the suite timeout instead of failing here.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello deepseek", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      const delta = runtimeEvents.find(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );
      assert.isDefined(
        delta,
        "no content.delta was projected after the startSession fiber completed",
      );
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test clock
      // they wait on virtual time that never advances, and a regression would
      // hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );
});
