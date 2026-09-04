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
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ApprovalRequestId,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  getHermesReasoningEffort,
  makeHermesAdapter,
  resolveHermesRuntimeMode,
  selectHermesAutoApprovedPermissionOption,
  selectHermesPermissionOptionId,
} from "./HermesAdapter.ts";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const permissionRequest = {
  sessionId: "hermes-session",
  toolCall: { toolCallId: "tool-1", title: "Run command" },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("Hermes adapter policy mapping", () => {
  it("maps T3 runtime modes to Hermes ACP modes", () => {
    expect(resolveHermesRuntimeMode("approval-required")).toBe("default");
    expect(resolveHermesRuntimeMode("auto")).toBe("default");
    expect(resolveHermesRuntimeMode("auto-accept-edits")).toBe("accept_edits");
    expect(resolveHermesRuntimeMode("full-access")).toBe("dont_ask");
  });

  it("uses exact Hermes option ids and avoids permanent auto-approval", () => {
    expect(selectHermesPermissionOptionId(permissionRequest, "accept")).toBe("allow_once");
    expect(selectHermesPermissionOptionId(permissionRequest, "acceptForSession")).toBe(
      "allow_session",
    );
    expect(selectHermesPermissionOptionId(permissionRequest, "decline")).toBe("deny");
    expect(selectHermesAutoApprovedPermissionOption(permissionRequest)).toBe("allow_session");
  });

  it("falls back to ACP option kinds and only auto-approves once", () => {
    const genericRequest = {
      ...permissionRequest,
      options: [
        { optionId: "temporary", kind: "allow_once", name: "Temporarily allow" },
        { optionId: "permanent", kind: "allow_always", name: "Always allow" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    } satisfies EffectAcpSchema.RequestPermissionRequest;

    expect(selectHermesPermissionOptionId(genericRequest, "accept")).toBe("temporary");
    expect(selectHermesPermissionOptionId(genericRequest, "decline")).toBe("reject");
    expect(selectHermesAutoApprovedPermissionOption(genericRequest)).toBe("temporary");
  });

  it("reads the reasoning effort from the model selection options", () => {
    expect(getHermesReasoningEffort(undefined)).toBeUndefined();
    expect(getHermesReasoningEffort({ options: [] })).toBeUndefined();
    expect(
      getHermesReasoningEffort({ options: [{ id: "reasoningEffort", value: "  high " }] }),
    ).toBe("high");
    expect(
      getHermesReasoningEffort({ options: [{ id: "reasoningEffort", value: "" }] }),
    ).toBeUndefined();
    expect(
      getHermesReasoningEffort({ options: [{ id: "reasoningEffort", value: true }] }),
    ).toBeUndefined();
    expect(getHermesReasoningEffort({ options: [{ id: "other", value: "high" }] })).toBeUndefined();
  });
});

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockHermesWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-hermes.sh");
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

const hermesAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeHermesAdapter>[1]) =>
  makeHermesAdapter(decodeHermesSettings({ binaryPath }), options).pipe(Effect.orDie);

effectIt.layer(hermesAdapterTestLayer)("HermesAdapterLive", (it) => {
  it.effect("fails a hung turn after the turn timeout and settles it cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-turn-timeout");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
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

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "default" },
      });

      const exit = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "hello hermes", attachments: [] }),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.match(String(exit.cause), /timed out after 200ms/);
      }

      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.interrupt(runtimeEventsFiber);
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.isDefined(completed, "no turn.completed was projected after the timeout");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "cancelled");
      }

      yield* adapter.stopSession(threadId);
      // Live clock so the 200ms deadline above is real: under the default
      // test clock it would wait on virtual time that never advances.
    }).pipe(TestClock.withLive),
  );

  it.effect("rewrites known $skill mentions to native slash form", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-skill-mention");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-skill-mention-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const skillDir = NodePath.join(tempDir, "skills", "ask-matt");
      yield* Effect.promise(() => NodeFSP.mkdir(skillDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(skillDir, "SKILL.md"),
          "---\nname: ask-matt\ndescription: Ask which skill fits.\n---\n",
          "utf8",
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          HERMES_HOME: tempDir,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        environment: { ...process.env, HERMES_HOME: tempDir },
      });

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "default" },
      });
      yield* adapter.sendTurn({ threadId, input: "ask $ask-matt now" });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests
        .filter((request) => request.method === "session/prompt")
        .map(
          (request) => (request.params as { prompt: Array<{ type: string; text: string }> }).prompt,
        );
      assert.equal(prompts.length, 1);
      assert.include(prompts[0]?.[0]?.text, "ask /ask-matt now");
    }),
  );

  it.effect("sends runtime context with the current model", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-runtime-context");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-runtime-context-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "default" },
      });
      yield* adapter.sendTurn({ threadId, input: "First prompt" });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests
        .filter((request) => request.method === "session/prompt")
        .map(
          (request) => (request.params as { prompt: Array<{ type: string; text: string }> }).prompt,
        );
      assert.equal(prompts.length, 1);
      assert.deepEqual(prompts[0]?.[0], { type: "text", text: "First prompt" });
      assert.include(prompts[0]?.[1]?.text, "Hermes harness");
    }),
  );

  it.effect("rejects user-input answers because Hermes sends none", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-no-user-input");
      const wrapperPath = yield* Effect.promise(() => makeMockHermesWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("hermes"), model: "default" },
      });

      const error = yield* Effect.flip(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make("req-1"), {}),
      );
      assert.match(String(error), /does not emit user-input requests/);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("re-sends reasoning effort on change and skips identical re-applies", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-reasoning-dedup");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-reasoning-dedup-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_HERMES: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const selection = (effort: string) => ({
        instanceId: ProviderInstanceId.make("hermes"),
        model: "default",
        options: [{ id: "reasoningEffort", value: effort }],
      });

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: selection("high"),
      });
      // Same effort on the turn must not re-send the RPC.
      yield* adapter.sendTurn({ threadId, input: "stay sharp", modelSelection: selection("high") });
      // Changed effort must re-send exactly once.
      yield* adapter.sendTurn({
        threadId,
        input: "think harder",
        modelSelection: selection("low"),
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const effortValues = requests
        .filter(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "reasoning_effort",
        )
        .map((entry) => (entry.params as Record<string, unknown>)?.value);
      assert.deepEqual(effortValues, ["high", "low"]);
    }),
  );

  it.effect("tolerates unknown reasoning effort and keeps the previous level", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-reasoning-unknown");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-reasoning-unknown-")),
      );
      const stateLogPath = NodePath.join(tempDir, "hermes-state.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_HERMES: "1",
          T3_ACP_HERMES_STATE_LOG_PATH: stateLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      // Unknown levels must not fail the turn; the session keeps its effort.
      yield* adapter.sendTurn({
        threadId,
        input: "carry on",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
          options: [{ id: "reasoningEffort", value: "bogus-level" }],
        },
      });
      yield* adapter.stopSession(threadId);

      const states = yield* Effect.promise(() => readJsonLines(stateLogPath));
      assert.isAbove(states.length, 0, "no hermes state was logged");
      assert.equal((states[states.length - 1] as Record<string, unknown>)?.reasoningEffort, "high");
    }),
  );

  it.effect("retains reasoning effort across model switches", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("hermes-reasoning-switch");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-reasoning-switch-")),
      );
      const stateLogPath = NodePath.join(tempDir, "hermes-state.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_HERMES: "1",
          T3_ACP_HERMES_STATE_LOG_PATH: stateLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "default",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "switch model",
        modelSelection: {
          instanceId: ProviderInstanceId.make("hermes"),
          model: "hermes-test-alt",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      yield* adapter.stopSession(threadId);

      const states = yield* Effect.promise(() => readJsonLines(stateLogPath));
      const switched = states.filter(
        (state) => (state as Record<string, unknown>)?.event === "model-switched",
      );
      assert.equal(switched.length, 1, "expected exactly one model switch");
      assert.equal((switched[0] as Record<string, unknown>)?.reasoningEffort, "high");
    }),
  );
});
