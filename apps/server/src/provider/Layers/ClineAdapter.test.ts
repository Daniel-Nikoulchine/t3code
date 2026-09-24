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
  ClineSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  makeClineAdapter,
  selectClineAutoApprovedPermissionOption,
  selectClinePermissionOptionId,
} from "./ClineAdapter.ts";
const decodeClineSettings = Schema.decodeSync(ClineSettings);

const permissionRequest = {
  sessionId: "cline-session",
  toolCall: { toolCallId: "tool-1", title: "Run command" },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("Cline adapter policy mapping", () => {
  it("uses exact Cline option ids and avoids permanent auto-approval", () => {
    expect(selectClinePermissionOptionId(permissionRequest, "accept")).toBe("allow_once");
    expect(selectClinePermissionOptionId(permissionRequest, "acceptForSession")).toBe(
      "allow_session",
    );
    expect(selectClinePermissionOptionId(permissionRequest, "decline")).toBe("deny");
    expect(selectClineAutoApprovedPermissionOption(permissionRequest)).toBe("allow_session");
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

    expect(selectClinePermissionOptionId(genericRequest, "accept")).toBe("temporary");
    expect(selectClinePermissionOptionId(genericRequest, "decline")).toBe("reject");
    expect(selectClineAutoApprovedPermissionOption(genericRequest)).toBe("temporary");
  });
});

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockClineWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-cline.sh");
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

const clineAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-cline-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeClineAdapter>[1]) =>
  makeClineAdapter(decodeClineSettings({ binaryPath }), options).pipe(Effect.orDie);

effectIt.layer(clineAdapterTestLayer)("ClineAdapterLive", (it) => {
  it.effect("starts a session, sends a turn, and stops it", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-basic-turn");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-basic-turn-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("cline"), model: "default" },
      });
      assert.isTrue(yield* adapter.hasSession(threadId));

      yield* adapter.sendTurn({ threadId, input: "First prompt" });
      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.threadId, threadId);

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests
        .filter((request) => request.method === "session/prompt")
        .map(
          (request) => (request.params as { prompt: Array<{ type: string; text: string }> }).prompt,
        );
      assert.equal(prompts.length, 1);
      assert.deepEqual(prompts[0]?.[0], { type: "text", text: "First prompt" });
      assert.include(prompts[0]?.[1]?.text, "Cline harness");
    }),
  );

  it.effect("mirrors Full access into the auto_approve session option", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-auto-approve");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-auto-approve-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cline"), model: "default" },
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const autoApproveWrites = requests.filter(
        (request) =>
          request.method === "session/set_config_option" &&
          (request.params as { configId?: string }).configId === "auto_approve",
      );
      // String form: the real Cline CLI rejects a JSON boolean here.
      assert.isAtLeast(autoApproveWrites.length, 1);
      for (const write of autoApproveWrites) {
        assert.equal((write.params as { value?: unknown }).value, "true");
      }
    }),
  );

  it.effect("always applies act mode through setMode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-plan-mode");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-plan-mode-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("cline"), model: "default" },
      });
      yield* adapter.sendTurn({ threadId, input: "Explore only" });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeWrites = requests.filter(
        (request) =>
          request.method === "session/set_config_option" &&
          (request.params as { configId?: string }).configId === "mode",
      );
      assert.deepEqual(
        modeWrites.map((write) => (write.params as { value?: unknown }).value),
        ["act"],
      );
    }),
  );

  it.effect("rewrites known $skill mentions to native slash form", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-skill-mention");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cline-skill-mention-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const skillDir = NodePath.join(tempDir, ".cline", "skills", "ask-matt");
      yield* Effect.promise(() => NodeFSP.mkdir(skillDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(skillDir, "SKILL.md"),
          "---\nname: ask-matt\ndescription: Ask which skill fits.\n---\n",
          "utf8",
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        environment: { ...process.env, HOME: tempDir },
      });

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("cline"), model: "default" },
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

  it.effect("fails a hung turn after the turn timeout and settles it cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("cline-turn-timeout");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockClineWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
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
        provider: ProviderDriverKind.make("cline"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("cline"), model: "default" },
      });

      const exit = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "hello cline", attachments: [] }),
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
});
