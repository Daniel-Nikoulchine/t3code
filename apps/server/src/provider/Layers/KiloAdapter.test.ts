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
  KiloSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  makeKiloAdapter,
  selectKiloAutoApprovedPermissionOption,
  selectKiloPermissionOptionId,
} from "./KiloAdapter.ts";
const decodeKiloSettings = Schema.decodeSync(KiloSettings);

const permissionRequest = {
  sessionId: "kilo-session",
  toolCall: { toolCallId: "tool-1", title: "Run command" },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("Kilo adapter policy mapping", () => {
  it("uses exact Kilo option ids and avoids permanent auto-approval", () => {
    expect(selectKiloPermissionOptionId(permissionRequest, "accept")).toBe("allow_once");
    expect(selectKiloPermissionOptionId(permissionRequest, "acceptForSession")).toBe(
      "allow_session",
    );
    expect(selectKiloPermissionOptionId(permissionRequest, "decline")).toBe("deny");
    expect(selectKiloAutoApprovedPermissionOption(permissionRequest)).toBe("allow_session");
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

    expect(selectKiloPermissionOptionId(genericRequest, "accept")).toBe("temporary");
    expect(selectKiloPermissionOptionId(genericRequest, "decline")).toBe("reject");
    expect(selectKiloAutoApprovedPermissionOption(genericRequest)).toBe("temporary");
  });
});

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockKiloWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kilo-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kilo.sh");
  const envExports = Object.entries({ T3_ACP_KILO: "1", ...extraEnv })
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

const kiloAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kilo-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeKiloAdapter>[1]) =>
  makeKiloAdapter(decodeKiloSettings({ binaryPath }), options).pipe(Effect.orDie);

effectIt.layer(kiloAdapterTestLayer)("KiloAdapterLive", (it) => {
  it.effect("starts a session, keeps auto on the agent model, and completes a turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilo-happy-path");
      const wrapperPath = yield* Effect.promise(() => makeMockKiloWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kilo"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kilo"), model: "auto" },
      });
      assert.equal(session.model, "anthropic/kilo-test-model");

      const result = yield* adapter.sendTurn({ threadId, input: "hello kilo", attachments: [] });
      assert.equal(result.threadId, threadId);

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("switches models once and skips identical re-applies", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilo-model-switch");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kilo-model-switch-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("kilo"),
          model: "anthropic/kilo-test-model",
        },
      });
      // Same model on the turn must not re-send the RPC.
      yield* adapter.sendTurn({
        threadId,
        input: "stay here",
        modelSelection: {
          instanceId: ProviderInstanceId.make("kilo"),
          model: "anthropic/kilo-test-model",
        },
      });
      // Changed model must send exactly one more RPC.
      yield* adapter.sendTurn({
        threadId,
        input: "switch model",
        modelSelection: {
          instanceId: ProviderInstanceId.make("kilo"),
          model: "openai/kilo-test-alt",
        },
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modelValues = requests
        .filter((entry) => entry.method === "session/set_model")
        .map((entry) => (entry.params as Record<string, unknown>)?.modelId);
      assert.deepEqual(modelValues, ["anthropic/kilo-test-model", "openai/kilo-test-alt"]);
    }),
  );

  it.effect("rejects an unknown Kilo model id on session start", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilo-unknown-model");
      const wrapperPath = yield* Effect.promise(() => makeMockKiloWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const exit = yield* Effect.exit(
        adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("kilo"),
            model: "bogus/unknown-model",
          },
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("fails a hung turn after the turn timeout and settles it cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilo-turn-timeout");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
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
        provider: ProviderDriverKind.make("kilo"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kilo"), model: "auto" },
      });

      const exit = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "hello kilo", attachments: [] }),
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
      const threadId = ThreadId.make("kilo-skill-mention");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kilo-skill-mention-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const skillDir = NodePath.join(tempDir, ".kilo", "skills", "ask-matt");
      yield* Effect.promise(() => NodeFSP.mkdir(skillDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(skillDir, "SKILL.md"),
          "---\nname: ask-matt\ndescription: Ask which skill fits.\n---\n",
          "utf8",
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: tempDir,
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kilo"), model: "auto" },
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
      const threadId = ThreadId.make("kilo-runtime-context");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kilo-runtime-context-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockKiloWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kilo"), model: "auto" },
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
      assert.include(prompts[0]?.[1]?.text, "Kilo harness");
    }),
  );

  it.effect("rejects user-input answers because Kilo sends none", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kilo-no-user-input");
      const wrapperPath = yield* Effect.promise(() => makeMockKiloWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("kilo"), model: "auto" },
      });

      const error = yield* Effect.flip(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make("req-1"), {}),
      );
      assert.match(String(error), /does not emit user-input requests/);

      yield* adapter.stopSession(threadId);
    }),
  );
});
