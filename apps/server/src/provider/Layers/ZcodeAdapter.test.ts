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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ZcodeSettings,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import {
  extractUnseenZcodeAssistantMessages,
  makeZcodeAdapter,
  normalizeZcodeUserInputQuestions,
  parseZcodeResume,
  resolveZcodeMode,
  resolveZcodeModelRef,
  selectZcodePermissionOptionId,
} from "./ZcodeAdapter.ts";

const decodeZcodeSettings = Schema.decodeSync(ZcodeSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/zcode-mock-app-server.mjs");

async function makeMockZcodeWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zcode-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-zcode.sh");
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

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeZcodeAdapter>[1]) =>
  makeZcodeAdapter(decodeZcodeSettings({ binaryPath }), options).pipe(Effect.orDie);

const threadId = ThreadId.make("thread-zcode-test-1");

it("parses resume cursors with schema versioning", () => {
  assert.deepEqual(parseZcodeResume({ schemaVersion: 1, sessionId: "sess_abc" }), {
    sessionId: "sess_abc",
  });
  assert.isUndefined(parseZcodeResume({ schemaVersion: 2, sessionId: "sess_abc" }));
  assert.isUndefined(parseZcodeResume({ sessionId: "sess_abc" }));
  assert.isUndefined(parseZcodeResume(null));
});

it("resolves model refs with an implicit zai provider", () => {
  assert.deepEqual(resolveZcodeModelRef("glm-5.2"), { providerId: "zai", modelId: "glm-5.2" });
  assert.deepEqual(resolveZcodeModelRef("custom/glm-5.2"), {
    providerId: "custom",
    modelId: "glm-5.2",
  });
});

it("maps runtime modes onto ZCode session modes", () => {
  assert.equal(resolveZcodeMode({ runtimeMode: "full-access" }), "yolo");
  assert.equal(resolveZcodeMode({ runtimeMode: "approval-required" }), "build");
  assert.equal(resolveZcodeMode({ runtimeMode: "auto" }), "build");
  assert.equal(resolveZcodeMode({ runtimeMode: "auto-accept-edits" }), "edit");
});

it("selects permission option ids per approval decision", () => {
  const options = [
    { optionId: "allow_once", kind: "allow_once" },
    { optionId: "allow_project", kind: "allow_always" },
    { optionId: "deny", kind: "deny" },
  ];
  assert.equal(selectZcodePermissionOptionId(options, "accept"), "allow_once");
  assert.equal(selectZcodePermissionOptionId(options, "acceptForSession"), "allow_project");
  assert.equal(selectZcodePermissionOptionId(options, "acceptAlways"), "allow_project");
  assert.equal(selectZcodePermissionOptionId(options, "decline"), "deny");
  assert.equal(selectZcodePermissionOptionId(options, "cancel"), "deny");
});

it("normalizes user-input questions with a free-text fallback", () => {
  const questions = normalizeZcodeUserInputQuestions({
    prompt: "Pick one",
    questions: [
      {
        id: "q1",
        header: "Deploy",
        question: "Deploy now?",
        options: [{ label: "Yes", description: "Ship it" }],
      },
    ],
  });
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.id, "q1");
  assert.equal(questions[0]?.options[0]?.label, "Yes");

  const fallback = normalizeZcodeUserInputQuestions({ prompt: "Say something" });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0]?.question, "Say something");
  assert.isTrue(fallback[0]?.allowCustomAnswer);
});

it("extracts unseen assistant text while skipping seen and non-text parts", () => {
  const seen = new Set(["msg_seen"]);
  const messages = extractUnseenZcodeAssistantMessages(
    {
      messages: [
        { info: { role: "user", messageId: "msg_user" }, parts: [{ type: "text", text: "hi" }] },
        {
          info: { role: "assistant", messageId: "msg_seen" },
          parts: [{ type: "text", text: "old" }],
        },
        {
          info: { role: "assistant", messageId: "msg_new" },
          parts: [
            { type: "text", text: "MOCK-REPLY" },
            { type: "tool", foo: 1 },
          ],
        },
      ],
    },
    seen,
  );
  assert.deepEqual(messages, [{ id: "msg_new", textParts: ["MOCK-REPLY"] }]);
});

it.effect("rejects startSession for the wrong provider or a missing cwd", () =>
  Effect.gen(function* () {
    const adapter = yield* makeTestAdapter("/bin/true");
    const wrongProvider = yield* adapter
      .startSession({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        cwd: "/tmp",
        runtimeMode: "full-access",
      })
      .pipe(Effect.flip);
    assert.equal(wrongProvider._tag, "ProviderAdapterValidationError");

    const missingCwd = yield* adapter
      .startSession({ threadId, cwd: "   ", runtimeMode: "full-access" })
      .pipe(Effect.flip);
    assert.equal(missingCwd._tag, "ProviderAdapterValidationError");
    yield* adapter.stopAll();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("runs a full turn against the mock app-server", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.tryPromise(() => makeMockZcodeWrapper());
    const adapter = yield* makeTestAdapter(binaryPath);
    const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
    const consumer = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Ref.update(eventsRef, (events) => [...events, event])),
      Effect.forkScoped,
    );

    const session = yield* adapter.startSession({
      threadId,
      cwd: "/tmp",
      runtimeMode: "full-access",
    });
    assert.equal(session.provider, "zcode");
    assert.deepEqual(session.resumeCursor, {
      schemaVersion: 1,
      sessionId: "sess_mock-0001",
    });

    const turn = yield* adapter.sendTurn({ threadId, input: "Say hello" });
    assert.equal(turn.threadId, threadId);
    assert.isTrue(yield* adapter.hasSession(threadId));

    const events = yield* Ref.get(eventsRef);
    const types = events.map((event) => event.type);
    assert.include(types, "turn.started");
    assert.include(types, "content.delta");
    assert.include(types, "turn.completed");
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(
      (completed as Extract<ProviderRuntimeEvent, { type: "turn.completed" }>).payload.state,
      "completed",
    );
    const delta = events.find((event) => event.type === "content.delta");
    assert.equal(
      (delta as Extract<ProviderRuntimeEvent, { type: "content.delta" }>).payload.delta,
      "MOCK-REPLY",
    );

    const sessions = yield* adapter.listSessions();
    assert.equal(sessions.length, 1);
    const snapshot = yield* adapter.readThread(threadId);
    assert.equal(snapshot.threadId, threadId);

    yield* adapter.stopSession(threadId);
    assert.isFalse(yield* adapter.hasSession(threadId));
    yield* Fiber.interrupt(consumer);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails sendTurn visibly when the server rejects the prompt", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.tryPromise(() =>
      makeMockZcodeWrapper({ T3_ZCODE_MOCK_FAIL_SEND: "1" }),
    );
    const adapter = yield* makeTestAdapter(binaryPath, { turnTimeoutMs: 5_000 });
    const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
    const consumer = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Ref.update(eventsRef, (events) => [...events, event])),
      Effect.forkScoped,
    );

    yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });
    const failure = yield* adapter.sendTurn({ threadId, input: "boom" }).pipe(Effect.flip);
    assert.equal(failure._tag, "ProviderAdapterRequestError");

    const events = yield* Ref.get(eventsRef);
    const completed = events.find((event) => event.type === "turn.completed");
    assert.equal(
      (completed as Extract<ProviderRuntimeEvent, { type: "turn.completed" }> | undefined)?.payload
        .state,
      "failed",
    );
    yield* adapter.stopAll();
    yield* Fiber.interrupt(consumer);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("bridges approval round-trips through the mock permission request", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.tryPromise(() =>
      makeMockZcodeWrapper({ T3_ZCODE_MOCK_EMIT_PERMISSION: "1" }),
    );
    const adapter = yield* makeTestAdapter(binaryPath);
    const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
    const consumer = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Ref.update(eventsRef, (events) => [...events, event])),
      Effect.forkScoped,
    );

    yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "approval-required" });

    // Complete the approval as soon as the adapter surfaces it — no sleeps:
    // the suite runs on a TestClock, so waiting must be event-driven.
    const approvalSeen = yield* Deferred.make<string>();
    const watcher = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => {
        if (event.type !== "request.opened" || typeof event.requestId !== "string") {
          return Effect.void;
        }
        return Deferred.succeed(approvalSeen, event.requestId).pipe(Effect.ignore);
      }),
      Effect.forkScoped,
    );
    const turnFiber = yield* adapter
      .sendTurn({ threadId, input: "rm something" })
      .pipe(Effect.forkChild);

    const requestId = yield* Deferred.await(approvalSeen);
    yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(requestId), "accept");
    yield* Fiber.join(turnFiber);

    const events = yield* Ref.get(eventsRef);
    assert.include(
      events.map((event) => event.type),
      "request.resolved",
    );
    yield* adapter.stopAll();
    yield* Fiber.interrupt(consumer);
    yield* Fiber.interrupt(watcher);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects unknown approval and user-input responses", () =>
  Effect.gen(function* () {
    const binaryPath = yield* Effect.tryPromise(() => makeMockZcodeWrapper());
    const adapter = yield* makeTestAdapter(binaryPath);
    yield* adapter.startSession({ threadId, cwd: "/tmp", runtimeMode: "full-access" });

    const unknownApproval = yield* adapter
      .respondToRequest(threadId, ApprovalRequestId.make("nope"), "accept")
      .pipe(Effect.flip);
    assert.equal(unknownApproval._tag, "ProviderAdapterRequestError");

    const unknownInput = yield* adapter
      .respondToUserInput(threadId, ApprovalRequestId.make("nope"), {})
      .pipe(Effect.flip);
    assert.equal(unknownInput._tag, "ProviderAdapterRequestError");

    const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
    assert.equal(rollback._tag, "ProviderAdapterRequestError");
    yield* adapter.stopAll();
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("keeps the instance binding on the legacy zcode id", () => {
  assert.equal(ProviderInstanceId.make("zcode"), "zcode");
});
