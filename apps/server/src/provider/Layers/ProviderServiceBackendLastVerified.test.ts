// @effect-diagnostics nodeBuiltinImport:off
import type {
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  ServerProvider,
} from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { assert, describe, it, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as BackendLastVerified from "../backendLastVerified.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();
const serverConfigTestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);

function makeFakeAdapter(provider: ProviderDriverKind) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(provider),
            method: "sendTurn",
            detail: "no session",
          }),
        );
      }
      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const stopAll = vi.fn((): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      sessions.clear();
    }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: (threadId) =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.succeed(Array.from(sessions.values())),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) =>
      Effect.succeed({ threadId, turns: [{ id: TurnId.make("turn-1"), items: [] }] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  return { adapter, startSession, sendTurn };
}

const makeSnapshot = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
): ServerProvider => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const buildServices = Effect.gen(function* () {
  const codex = makeFakeAdapter(CODEX_DRIVER);
  const claude = makeFakeAdapter(CLAUDE_AGENT_DRIVER);
  const registry = makeAdapterRegistryMock({
    [CODEX_DRIVER]: codex.adapter,
    [CLAUDE_AGENT_DRIVER]: claude.adapter,
  });
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  // One shared layer value: `Layer.build` memoizes by reference, so the
  // closure-internal lookup and the test's outer lookup see the same table.
  const trackerLayer = BackendLastVerified.layer;
  const providerLayer = Layer.mergeAll(
    makeProviderServiceLive().pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(serverConfigTestLayer),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provide(trackerLayer),
    ),
    directoryLayer,
    runtimeRepositoryLayer,
    NodeServices.layer,
    trackerLayer,
  );
  const scope = yield* Scope.make();
  const services = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));
  const provider = yield* ProviderService.ProviderService.pipe(Effect.provide(services));
  const tracker = yield* BackendLastVerified.BackendLastVerified.pipe(Effect.provide(services));
  return { codex, claude, provider, tracker, scope };
});

describe("sendTurn backend verification marker", () => {
  it.effect("records a verification after a successful single turn", () =>
    Effect.gen(function* () {
      const { provider, tracker, scope } = yield* buildServices;
      const threadId = asThreadId("thread-verify-single");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "auto",
      });

      yield* provider.sendTurn({ threadId, input: "hello" });

      const stamped = yield* tracker.stamp(makeSnapshot(codexInstanceId, CODEX_DRIVER));
      assert.isDefined(stamped.backendLastVerifiedAt);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the executed combo target after a fallback turn", () =>
    Effect.gen(function* () {
      const { codex, claude, provider, tracker, scope } = yield* buildServices;
      const threadId = asThreadId("thread-verify-combo");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "auto",
      });
      yield* claude.adapter.startSession({
        threadId,
        runtimeMode: "auto",
        providerInstanceId: claudeAgentInstanceId,
      });
      codex.sendTurn.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "sendTurn",
            detail: "429 Too Many Requests: rate limit exceeded, retry later",
          }),
        ),
      );

      yield* provider.sendTurn({
        threadId,
        input: "combo hello",
        combo: {
          targets: [
            createModelSelection(codexInstanceId, "model-a"),
            createModelSelection(claudeAgentInstanceId, "model-b"),
          ],
          strategy: "priority",
          fallbackOn: ["rate-limit", "provider-error"],
        },
      });

      const fallbackStamped = yield* tracker.stamp(
        makeSnapshot(claudeAgentInstanceId, CLAUDE_AGENT_DRIVER),
      );
      assert.isDefined(fallbackStamped.backendLastVerifiedAt);
      const primaryStamped = yield* tracker.stamp(makeSnapshot(codexInstanceId, CODEX_DRIVER));
      assert.notProperty(primaryStamped, "backendLastVerifiedAt");
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records nothing when the turn fails", () =>
    Effect.gen(function* () {
      const { codex, provider, tracker, scope } = yield* buildServices;
      const threadId = asThreadId("thread-verify-failure");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "auto",
      });
      codex.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "sendTurn",
            detail: "boom",
          }),
        ),
      );

      const error = yield* provider.sendTurn({ threadId, input: "hello" }).pipe(Effect.flip);
      assert.strictEqual((error as { readonly _tag?: string })._tag, "ProviderAdapterRequestError");

      const stamped = yield* tracker.stamp(makeSnapshot(codexInstanceId, CODEX_DRIVER));
      assert.notProperty(stamped, "backendLastVerifiedAt");
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
