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
  DroidSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  makeDroidAdapter,
  selectDroidAutoApprovedPermissionOption,
  selectDroidPermissionOptionId,
} from "./DroidAdapter.ts";
const decodeDroidSettings = Schema.decodeSync(DroidSettings);

const permissionRequest = {
  sessionId: "droid-session",
  toolCall: { toolCallId: "tool-1", title: "Run command" },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("Droid adapter policy mapping", () => {
  it("uses exact Droid option ids and avoids permanent auto-approval", () => {
    expect(selectDroidPermissionOptionId(permissionRequest, "accept")).toBe("allow_once");
    expect(selectDroidPermissionOptionId(permissionRequest, "acceptForSession")).toBe(
      "allow_session",
    );
    expect(selectDroidPermissionOptionId(permissionRequest, "decline")).toBe("deny");
    expect(selectDroidAutoApprovedPermissionOption(permissionRequest)).toBe("allow_session");
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

    expect(selectDroidPermissionOptionId(genericRequest, "accept")).toBe("temporary");
    expect(selectDroidPermissionOptionId(genericRequest, "decline")).toBe("reject");
    expect(selectDroidAutoApprovedPermissionOption(genericRequest)).toBe("temporary");
  });
});

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockDroidWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-droid.sh");
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

const droidAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-droid-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeDroidAdapter>[1]) =>
  makeDroidAdapter(decodeDroidSettings({ binaryPath }), options).pipe(Effect.orDie);

effectIt.layer(droidAdapterTestLayer)("DroidAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
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
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "droid");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello droid",
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

      assert.isTrue(yield* adapter.hasSession(threadId));
      assert.equal((yield* adapter.listSessions()).length, 1);
      const read = yield* adapter.readThread(threadId);
      assert.equal(read.turns.length, 1);

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }),
  );

  it.effect("keeps stale model picks on the session default instead of failing set_model", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-stale-model");
      const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "auto",
        modelSelection: {
          instanceId: ProviderInstanceId.make("droid"),
          model: "stale-provider-9/does-not-exist",
        },
      });

      // The unknown id resolves against the mock catalog to nothing, so the
      // session keeps the mock's current model instead of failing.
      assert.equal(session.model, "grok-4.6");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rewrites known $skill mentions to native slash form", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-skill-mention");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-skill-mention-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const skillDir = NodePath.join(tempDir, ".factory", "skills", "summarize-diff");
      yield* Effect.promise(() => NodeFSP.mkdir(skillDir, { recursive: true }));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(skillDir, "SKILL.md"),
          "---\nname: summarize-diff\ndescription: Summarize the staged diff.\n---\n",
          "utf8",
        ),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: tempDir,
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "auto" },
      });
      yield* adapter.sendTurn({ threadId, input: "run $summarize-diff now" });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const prompts = requests
        .filter((request) => request.method === "session/prompt")
        .map(
          (request) => (request.params as { prompt: Array<{ type: string; text: string }> }).prompt,
        );
      assert.equal(prompts.length, 1);
      assert.include(prompts[0]?.[0]?.text, "run /summarize-diff now");
    }),
  );

  it.effect("sends runtime context with the current model", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-runtime-context");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-runtime-context-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "auto" },
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
      assert.include(prompts[0]?.[1]?.text, "Droid harness");
    }),
  );

  it.effect("rejects user-input answers because Droid sends none", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-no-user-input");
      const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "auto" },
      });

      const error = yield* Effect.flip(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make("req-1"), {}),
      );
      assert.match(String(error), /does not emit user-input requests/);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails a hung turn after the turn timeout and settles it cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-turn-timeout");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
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
        provider: ProviderDriverKind.make("droid"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "auto" },
      });

      const exit = yield* Effect.exit(
        adapter.sendTurn({ threadId, input: "hello droid", attachments: [] }),
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

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-custom-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDroidWrapper({
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
        provider: ProviderDriverKind.make("droid"),
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

  it.effect("fails session start after the start timeout when ACP never answers", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-start-timeout");
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-hang-")),
      );
      const wrapperPath = NodePath.join(dir, "hanging-droid.sh");
      yield* Effect.promise(() => NodeFSP.writeFile(wrapperPath, "#!/bin/sh\nsleep 120\n", "utf8"));
      yield* Effect.promise(() => NodeFSP.chmod(wrapperPath, 0o755));
      const adapter = yield* makeTestAdapter(wrapperPath, { startTimeoutMs: 200 });

      const exit = yield* Effect.exit(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("droid"),
          cwd: process.cwd(),
          runtimeMode: "auto",
          modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "auto" },
        }),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.match(String(exit.cause), /timed out after 200ms/);
        assert.match(String(exit.cause), /not logged in/);
      }
      assert.isFalse(yield* adapter.hasSession(threadId));
      // Live clock so the 200ms deadline above is real: under the default
      // test clock it would wait on virtual time that never advances.
    }).pipe(TestClock.withLive),
  );

  it.effect("rolls back local turns and rejects invalid counts", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("droid-rollback");
      const wrapperPath = yield* Effect.promise(() => makeMockDroidWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "auto",
        modelSelection: { instanceId: ProviderInstanceId.make("droid"), model: "auto" },
      });
      yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      yield* adapter.sendTurn({ threadId, input: "second", attachments: [] });
      assert.equal((yield* adapter.readThread(threadId)).turns.length, 2);

      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      assert.equal(rolledBack.turns.length, 1);

      const invalid = yield* Effect.flip(adapter.rollbackThread(threadId, 0));
      assert.match(String(invalid), /numTurns must be an integer/);

      yield* adapter.stopSession(threadId);
    }),
  );
});
