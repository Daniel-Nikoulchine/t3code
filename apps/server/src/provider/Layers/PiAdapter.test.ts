// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-rpc-mock-agent.ts");

async function makeMockPiWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-adapter-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-pi.sh");
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

const piAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (
  binaryPath: string,
  extraEnv?: Record<string, string>,
  options?: Parameters<typeof makePiAdapter>[1],
) =>
  makePiAdapter(decodePiSettings({ binaryPath, enabled: true }), {
    environment: { ...process.env, ...extraEnv },
    instanceId: ProviderInstanceId.make("pi"),
    ...options,
  }).pipe(Effect.orDie);

/**
 * Fork a collector and hand the scheduler over so the subscriber attaches
 * before the test publishes: `Stream.fromPubSub` subscribes when the
 * consumer fiber first runs, and without a yield the parent can broadcast
 * `turn.started` before the child is live. The child runs until it blocks
 * awaiting events (i.e. subscribed) before the parent resumes.
 */
const forkCollector = (
  adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> },
  done: (event: ProviderRuntimeEvent) => boolean,
): Effect.Effect<
  { readonly events: ProviderRuntimeEvent[]; readonly join: Effect.Effect<ProviderRuntimeEvent[]> },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const completed = yield* Deferred.make<void>();
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(Effect.andThen(done(event) ? Deferred.succeed(completed, undefined) : Effect.void)),
    ).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    return {
      events,
      join: Deferred.await(completed).pipe(
        Effect.andThen(Fiber.interrupt(fiber).pipe(Effect.ignore)),
        Effect.as(events),
      ),
    };
  });

it.layer(piAdapterTestLayer)("PiAdapterLive", (it) => {
  it.effect("starts a session and streams a turn to completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-mock-thread");
        const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
        const adapter = yield* makeTestAdapter(binaryPath);
        const collector = yield* forkCollector(
          adapter,
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );

        const session = yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
        });
        assert.equal(session.provider, "pi");
        assert.equal(session.model, "default");
        assert.isTrue(yield* adapter.hasSession(threadId));

        const turn = yield* adapter.sendTurn({ threadId, input: "hello pi", attachments: [] });
        const events = yield* collector.join;

        const types = events.map((event) => event.type);
        assert.includeMembers(types, ["turn.started", "content.delta", "turn.completed"]);
        const completed = events.find((event) => event.type === "turn.completed");
        assert.equal(
          completed?.type === "turn.completed" ? completed.turnId : undefined,
          turn.turnId,
        );
        assert.equal(
          completed?.type === "turn.completed" ? completed.payload.state : undefined,
          "completed",
        );
        const delta = events.find((event) => event.type === "content.delta");
        assert.isDefined(delta);

        const read = yield* adapter.readThread(threadId);
        assert.equal(read.turns.length, 1);

        yield* adapter.stopSession(threadId);
        assert.isFalse(yield* adapter.hasSession(threadId));
      }),
    ),
  );

  it.effect("surfaces tool executions as lifecycle items", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-mock-tools");
        const binaryPath = yield* Effect.promise(() => makeMockPiWrapper({ PI_MOCK_TOOLS: "1" }));
        const adapter = yield* makeTestAdapter(binaryPath);
        const collector = yield* forkCollector(
          adapter,
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({ threadId, input: "run a tool", attachments: [] });
        const events = yield* collector.join;
        const types = events.map((event) => event.type);
        assert.includeMembers(types, ["item.started", "item.completed"]);
        const started = events.find((event) => event.type === "item.started");
        assert.equal(
          started?.type === "item.started" ? started.payload.itemType : undefined,
          "command_execution",
        );
        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("interrupts a running turn as cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-mock-interrupt");
        const binaryPath = yield* Effect.promise(() =>
          makeMockPiWrapper({ PI_MOCK_TURN_DELAY_MS: "800" }),
        );
        const adapter = yield* makeTestAdapter(binaryPath);
        const collector = yield* forkCollector(
          adapter,
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({ threadId, input: "take your time", attachments: [] });
        yield* adapter.interruptTurn(threadId);
        const events = yield* collector.join;

        const types = events.map((event) => event.type);
        assert.includeMembers(types, ["turn.aborted", "turn.completed"]);
        const completed = events.find((event) => event.type === "turn.completed");
        assert.equal(
          completed?.type === "turn.completed" ? completed.payload.state : undefined,
          "cancelled",
        );
        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("relays extension dialogs as user input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-mock-dialog");
        const binaryPath = yield* Effect.promise(() =>
          makeMockPiWrapper({ PI_MOCK_DIALOG: "select" }),
        );
        const adapter = yield* makeTestAdapter(binaryPath);
        const completed = yield* forkCollector(
          adapter,
          (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
        const requestedCollector = yield* forkCollector(
          adapter,
          (event) => event.type === "user-input.requested",
        );

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input: "ask me", attachments: [] });

        const requestedEvents = yield* requestedCollector.join;
        const requested = requestedEvents.find((event) => event.type === "user-input.requested");
        assert.isDefined(requested?.requestId);
        yield* adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.make(String(requested?.requestId)),
          { value: "Allow" },
        );

        const events = yield* completed.join;
        const types = events.map((event) => event.type);
        assert.includeMembers(types, ["user-input.resolved", "turn.completed"]);
        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("fails sendTurn when pi rejects the prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-mock-reject");
        const binaryPath = yield* Effect.promise(() =>
          makeMockPiWrapper({ PI_MOCK_PROMPT_FAIL: "No API key found for mock-provider." }),
        );
        const adapter = yield* makeTestAdapter(binaryPath);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        const exit = yield* adapter
          .sendTurn({ threadId, input: "hello", attachments: [] })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        yield* adapter.stopAll();
      }),
    ),
  );

  it.effect("advertises in-session model switching without rollback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
        const adapter = yield* makeTestAdapter(binaryPath);
        assert.equal(adapter.capabilities.sessionModelSwitch, "in-session");
        assert.equal(adapter.capabilities.supportsConversationRollback, false);

        const threadId = ThreadId.make("pi-mock-caps");
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(rollback));
        assert.deepStrictEqual(yield* adapter.listSessions().pipe(Effect.map((s) => s.length)), 1);
        yield* adapter.stopAll();
        assert.deepStrictEqual(yield* adapter.listSessions().pipe(Effect.map((s) => s.length)), 0);
      }),
    ),
  );

  it.effect("rejects unknown attachments before touching pi", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-mock-attachment");
        const binaryPath = yield* Effect.promise(() => makeMockPiWrapper());
        const adapter = yield* makeTestAdapter(binaryPath);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("pi"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const exit = yield* adapter
          .sendTurn({
            threadId,
            input: "look",
            attachments: [
              {
                type: "file",
                id: "../evil",
                name: "evil.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        yield* adapter.stopAll();
      }),
    ),
  );
});
