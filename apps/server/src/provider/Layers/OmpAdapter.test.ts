import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  buildOmpRpcSpawnArgs,
  getOmpReasoningEffort,
  makeOmpAdapter,
  resolveOmpAgentDir,
  resolveOmpSessionModel,
} from "./OmpAdapter.ts";
import type { OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { hasOmpSkillMention, rewriteOmpSkillMentions } from "../Drivers/OmpSkills.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const OMP = ProviderDriverKind.make("omp");
const OMP_INSTANCE = ProviderInstanceId.make("omp");

describe("OmpAdapter pure helpers", () => {
  it("builds RPC spawn args", () => {
    expect(buildOmpRpcSpawnArgs({})).toEqual(["--mode", "rpc"]);
    expect(buildOmpRpcSpawnArgs({ noSession: true })).toEqual(["--mode", "rpc", "--no-session"]);
    expect(
      buildOmpRpcSpawnArgs({
        provider: "anthropic",
        model: "anthropic/opus",
        thinking: "high",
        resumeSessionId: "abc",
      }),
    ).toEqual([
      "--mode",
      "rpc",
      "--provider",
      "anthropic",
      "--model",
      "anthropic/opus",
      "--thinking",
      "high",
      "--session",
      "abc",
    ]);
  });

  it("resolves session models against the catalog", () => {
    const catalog = [
      { id: "opus", provider: "anthropic" },
      { id: "opus", provider: "other" },
      { id: "gpt-4o", provider: "openai" },
    ];
    expect(resolveOmpSessionModel(undefined, catalog, null)).toBeUndefined();
    expect(resolveOmpSessionModel("default", catalog, null)).toBeUndefined();
    expect(resolveOmpSessionModel("anthropic/opus", catalog, null)).toEqual({
      provider: "anthropic",
      modelId: "opus",
    });
    // Explicit provider outside the catalog cannot satisfy set_model.
    expect(resolveOmpSessionModel("custom/sonnet", catalog, null)).toBeUndefined();
    // Bare id matching the running model stays on its provider.
    expect(resolveOmpSessionModel("gpt-4o", catalog, { id: "gpt-4o", provider: "openai" })).toEqual(
      { provider: "openai", modelId: "gpt-4o" },
    );
    // Bare id with no match and no current model cannot be sent.
    expect(resolveOmpSessionModel("unknown", catalog, null)).toBeUndefined();
  });

  it("reads reasoning effort from model selections", () => {
    expect(getOmpReasoningEffort(undefined)).toBeUndefined();
    expect(getOmpReasoningEffort({ options: [{ id: "reasoningEffort", value: " high " }] })).toBe(
      "high",
    );
    expect(getOmpReasoningEffort({ options: [{ id: "effort", value: "low" }] })).toBe("low");
    expect(
      getOmpReasoningEffort({ options: [{ id: "reasoningEffort", value: "ultra" }] }),
    ).toBeUndefined();
    expect(
      getOmpReasoningEffort({ options: [{ id: "reasoningEffort", value: true }] }),
    ).toBeUndefined();
  });

  it("folds the agent dir into PI_AGENT_DIR", () => {
    expect(resolveOmpAgentDir({ agentDir: "" }, { PATH: "x" })).toEqual({ PATH: "x" });
    const withDir = resolveOmpAgentDir({ agentDir: "~/custom-pi" }, {});
    expect(withDir.PI_AGENT_DIR).toContain("custom-pi");
  });

  it("rewrites known $skill mentions to /skill: form", () => {
    expect(hasOmpSkillMention("use $brave-search now")).toBe(true);
    expect(hasOmpSkillMention("no mentions")).toBe(false);
    expect(rewriteOmpSkillMentions("use $brave-search now", new Set(["brave-search"]))).toBe(
      "use /skill:brave-search now",
    );
    expect(rewriteOmpSkillMentions("use $unknown now", new Set(["brave-search"]))).toBe(
      "use $unknown now",
    );
  });
});

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-mock-agent.ts");

async function makeMockOmpWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-rpc-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-omp.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ompAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeOmpAdapter>[1]) =>
  makeOmpAdapter(decodeOmpSettings({ binaryPath }), options).pipe(Effect.orDie);

const startTestSession = (
  adapter: Pick<OmpAdapterShape, "startSession">,
  threadId: ThreadId,
  modelSelection?: { readonly instanceId: typeof OMP_INSTANCE; readonly model: string },
) =>
  adapter.startSession({
    threadId,
    provider: OMP,
    cwd: process.cwd(),
    runtimeMode: "full-access",
    ...(modelSelection ? { modelSelection } : {}),
  });

effectIt.layer(ompAdapterTestLayer)("OmpAdapterLive", (it) => {
  it.effect("runs a turn and projects deltas plus completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-happy-path");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-happy-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_PI_LOG_PATH: requestLogPath }),
      );
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

      const session = yield* startTestSession(adapter, threadId);
      expect(session.model).toBe("test-model");
      expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "mock-session-1" });

      const result = yield* adapter.sendTurn({ threadId, input: "hello omp", attachments: [] });
      expect(result.turnId).toBeTruthy();
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));

      const deltas = runtimeEvents.filter((event) => event.type === "content.delta");
      expect(deltas.length).toBeGreaterThan(0);
      if (deltas[0]?.type === "content.delta") {
        expect(deltas[0].payload.delta).toContain("mock reply");
      }
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.isDefined(completed);
      if (completed?.type === "turn.completed") {
        expect(completed.payload.state).toBe("completed");
      }

      const thread = yield* adapter.readThread(threadId);
      expect(thread.turns).toHaveLength(1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests.filter((request) => request.type === "prompt");
      expect(prompts).toHaveLength(1);
      const promptText = prompts[0]?.message as string;
      expect(promptText).toContain("hello omp");
      expect(promptText).toContain("Oh My Pi harness");
    }).pipe(TestClock.withLive),
  );

  it.effect("rewrites known $skill mentions to /skill: form", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-skill-mention");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-skill-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_PI_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* startTestSession(adapter, threadId);
      yield* adapter.sendTurn({ threadId, input: "search $brave-search now" });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests.filter((request) => request.type === "prompt");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.message as string).toContain("search /skill:brave-search now");
    }).pipe(TestClock.withLive),
  );

  it.effect("applies a catalog model and keeps the session model for unknown ids", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const knownThread = ThreadId.make("omp-known-model");
      const known = yield* startTestSession(adapter, knownThread, {
        instanceId: OMP_INSTANCE,
        model: "test-provider/test-model-mini",
      });
      expect(known.model).toBe("test-provider/test-model-mini");
      yield* adapter.stopSession(knownThread);

      const unknownThread = ThreadId.make("omp-unknown-model");
      const unknown = yield* startTestSession(adapter, unknownThread, {
        instanceId: OMP_INSTANCE,
        model: "nope/nonexistent",
      });
      expect(unknown.model).toBe("test-model");
      yield* adapter.stopSession(unknownThread);
    }).pipe(TestClock.withLive),
  );

  it.effect("fails a hung turn after the turn timeout and settles it cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-turn-timeout");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_PI_HANG_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, { turnTimeoutMs: 200 });

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

      yield* startTestSession(adapter, threadId);
      const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "hang please" }));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.match(String(exit.cause), /timed out after 200ms/);
      }

      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(runtimeEventsFiber);
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.isDefined(completed);
      if (completed?.type === "turn.completed") {
        expect(completed.payload.state).toBe("cancelled");
      }
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("interrupts a running turn as cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-interrupt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_PI_HANG_PROMPT: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, { turnTimeoutMs: 30_000 });

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

      yield* startTestSession(adapter, threadId);
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId, input: "long task" }).pipe(Effect.exit),
      );
      yield* Effect.sleep("100 millis");
      yield* adapter.interruptTurn(threadId);
      const exit = yield* Fiber.join(turnFiber);
      assert.isTrue(Exit.isSuccess(exit));

      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(runtimeEventsFiber);
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.isDefined(completed);
      if (completed?.type === "turn.completed") {
        expect(completed.payload.state).toBe("cancelled");
      }
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("routes extension dialogs through user-input and back", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-dialog");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "omp-dialog-")),
      );
      const dialogLogPath = NodePath.join(tempDir, "dialogs.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockOmpWrapper({ T3_PI_DIALOG: "select", T3_PI_DIALOG_LOG_PATH: dialogLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const userInputRequested = yield* Deferred.make<ProviderRuntimeEvent>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "user-input.requested"
              ? Deferred.succeed(userInputRequested, event)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* startTestSession(adapter, threadId);
      const turnFiber = yield* Effect.forkChild(
        adapter.sendTurn({ threadId, input: "needs input" }),
      );
      const requested = yield* Deferred.await(userInputRequested).pipe(
        Effect.timeout("10 seconds"),
      );
      assert.isDefined(requested.requestId);
      if (requested.type === "user-input.requested") {
        expect(requested.payload.questions[0]?.header).toBe("Pick one");
      }
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(requested.requestId!), {
        choice: "Beta",
      });
      yield* Fiber.join(turnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);

      const resolved = runtimeEvents.find((event) => event.type === "user-input.resolved");
      assert.isDefined(resolved);
      const dialogs = yield* Effect.promise(() => readJsonLines(dialogLogPath));
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0]).toMatchObject({
        type: "extension_ui_response",
        value: "Beta",
      });
    }).pipe(TestClock.withLive),
  );

  it.effect("rejects tool approvals and validates rollback input", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("omp-approvals");
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* startTestSession(adapter, threadId);
      const approvalExit = yield* Effect.exit(
        adapter.respondToRequest(threadId, ApprovalRequestId.make("req-1"), "accept"),
      );
      assert.isTrue(Exit.isFailure(approvalExit));

      const userInputExit = yield* Effect.exit(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make("req-1"), { choice: "x" }),
      );
      assert.isTrue(Exit.isFailure(userInputExit));

      const rollbackExit = yield* Effect.exit(adapter.rollbackThread(threadId, 0));
      assert.isTrue(Exit.isFailure(rollbackExit));

      yield* adapter.sendTurn({ threadId, input: "one turn" });
      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      expect(rolledBack.turns).toHaveLength(0);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      expect((yield* adapter.listSessions()).length).toBe(1);
      yield* adapter.stopSession(threadId);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(TestClock.withLive),
  );

  it.effect("fails startSession without a cwd", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockOmpWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const exit = yield* Effect.exit(
        adapter.startSession({
          threadId: ThreadId.make("omp-no-cwd"),
          provider: OMP,
          cwd: "   ",
          runtimeMode: "full-access",
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      yield* adapter.stopAll();
    }).pipe(TestClock.withLive),
  );
});
