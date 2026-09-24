/**
 * CopilotAdapterLive — GitHub Copilot CLI (`copilot --acp`) via ACP.
 *
 * @module CopilotAdapterLive
 */

import {
  ApprovalRequestId,
  type CopilotSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeEventStamper,
  makeThreadLockRegistry,
  requireScaffoldSession,
  settlePendingApprovalsAsCancelled,
  stopScaffoldSession,
  makeExtensionFailureMapper,
  parseAcpResumeCursor,
} from "../acp/AcpAdapterScaffold.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  makeCopilotAcpRuntime,
  normalizeCopilotEffort,
  resolveCopilotAcpBaseModelId,
} from "../acp/CopilotAcpSupport.ts";
import { type CopilotAdapterShape } from "../Services/CopilotAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  selectSessionFirstAutoApprovedPermissionOption,
  selectSessionFirstPermissionOptionId,
} from "./permissionOptionSelection.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_RESUME_VERSION = 1 as const;
// ACP has no per-turn progress deadline; without one a stalled Copilot turn
// leaves the thread on "Working" forever. This is an absolute backstop, not
// activity-based like Grok's watchdog — a turn that runs longer is cancelled.
const DEFAULT_COPILOT_TURN_TIMEOUT_MS = 30 * 60 * 1_000;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface CopilotAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`copilot`).
   */
  readonly instanceId?: ProviderInstanceId;
  /** Override the absolute per-turn prompt deadline in focused tests. */
  readonly turnTimeoutMs?: number;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `copilotSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<CopilotSettings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface CopilotSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  copilotSkillNames: ReadonlySet<string> | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; a sendTurn preparing or awaiting settlement after a stop must not resurrect them. */
  readonly interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  readonly promptSettlements: Set<Deferred.Deferred<void>>;
  stopped: boolean;
  /**
   * Model selection already applied to the live ACP session via
   * `session/set_model`. Re-sending the same id re-runs Hermes' provider
   * resolution, which can silently reroute an explicit `provider:model`
   * pick through model-name detection; skipping identical re-applies keeps
   * the session on the endpoint the user selected.
   */
  appliedModel: string | undefined;
  appliedReasoningEffort: string | undefined;
  /**
   * Model ids Hermes advertised for this session (`availableModels` plus
   * `currentModelId`). Selections are resolved against it before
   * `session/set_model` so stale or cross-provider ids fall back to the
   * session model instead of failing every turn with `401 ... not supported`.
   * `undefined` when Hermes reported no catalog (legacy pass-through).
   */
  readonly advertisedModels: ReadonlySet<string> | undefined;
}

function parseCopilotResume(raw: unknown): { sessionId: string } | undefined {
  return parseAcpResumeCursor(raw, COPILOT_RESUME_VERSION);
}

export function resolveCopilotAllowAllValue(runtimeMode: RuntimeMode): "on" | "off" {
  switch (runtimeMode) {
    case "full-access":
    case "auto":
      return "on";
    case "auto-accept-edits":
    case "approval-required":
      return "off";
  }
}

function findCopilotModeId(
  modes: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): string | undefined {
  const normalized = modes.map((mode) => ({
    id: mode.id,
    haystack: `${mode.id} ${mode.name}`.toLowerCase(),
  }));
  return (
    normalized.find((mode) => mode.haystack.includes("agent"))?.id ??
    normalized.find((mode) => !mode.haystack.includes("plan"))?.id ??
    normalized[0]?.id
  );
}

export function getCopilotReasoningEffort(
  modelSelection:
    | {
        readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
      }
    | undefined,
): string | undefined {
  const raw =
    modelSelection?.options?.find((option) => option.id === "effort")?.value ??
    modelSelection?.options?.find((option) => option.id === "reasoningEffort")?.value;
  if (typeof raw !== "string") return undefined;
  return normalizeCopilotEffort(raw);
}

function applyCopilotReasoningEffort<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setConfigOption">;
  readonly reasoningEffort: string | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option";
  }) => E;
}): Effect.Effect<void, E> {
  // Copilot reasoning effort (`--effort`) is fixed when the ACP server
  // spawns — `session/new` carries no effort field and there is no
  // `session/set_config_option` for it. The selection is honored at session
  // start via spawn args; in-session re-applies are intentionally no-ops so
  // turns never fail on an unsupported config option.
  void input;
  return Effect.void;
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly modelSelection:
    | {
        readonly model: string;
      }
    | undefined;
  readonly advertisedModels?: ReadonlySet<string> | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    // Copilot models are fixed at spawn via `--model`; there is no
    // `session/set_model` over ACP. Return the requested slug so the session
    // records it, without any RPC.
    const appliedModel = input.modelSelection
      ? resolveCopilotAcpBaseModelId(input.modelSelection.model)
      : undefined;

    // Permissions: `allow_all` on/off mirrors runtimeMode. Best-effort — a
    // session without it still works, it just prompts.
    const allowAll = resolveCopilotAllowAllValue(input.runtimeMode);
    yield* input.runtime.setConfigOption("allow_all", allowAll).pipe(
      Effect.mapError((cause) => input.mapError({ cause, method: "session/set_config_option" })),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to apply Copilot allow_all; continuing.", { cause }),
      ),
    );

    const modeState = yield* input.runtime.getModeState.pipe(
      Effect.mapError((cause) => input.mapError({ cause, method: "session/set_mode" })),
      Effect.option,
    );
    const availableModes = Option.match(modeState, {
      onNone: () => [] as ReadonlyArray<{ readonly id: string; readonly name: string }>,
      onSome: (state) => state?.availableModes ?? [],
    });
    const requestedModeId = findCopilotModeId(availableModes);
    if (requestedModeId) {
      yield* input.runtime.setMode(requestedModeId).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            method: "session/set_mode",
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to apply Copilot mode; continuing.", { cause }),
        ),
      );
    }
    return appliedModel;
  });
}

export function selectCopilotAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return selectSessionFirstAutoApprovedPermissionOption(request);
}

export function selectCopilotPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  return selectSessionFirstPermissionOptionId(request, decision);
}

function permissionOutcome(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): EffectAcpSchema.RequestPermissionResponse {
  if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
  const optionId = selectCopilotPermissionOptionId(request, decision);
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function makeCopilotAdapter(
  copilotSettings: CopilotSettings,
  options?: CopilotAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("copilot");
    const requestedTurnTimeoutMs = options?.turnTimeoutMs;
    const turnTimeoutMs =
      typeof requestedTurnTimeoutMs === "number" && Number.isFinite(requestedTurnTimeoutMs)
        ? Math.max(1, Math.floor(requestedTurnTimeoutMs))
        : DEFAULT_COPILOT_TURN_TIMEOUT_MS;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, CopilotSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const locks = yield* makeThreadLockRegistry;
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      locks.withThreadLock(threadId, effect);
    const stamper = yield* makeEventStamper({
      provider: PROVIDER,
      detail: "Failed to generate Copilot runtime identifier.",
    });
    const nowIso = stamper.nowIso;
    const randomUUIDv4 = stamper.randomUUIDv4;
    const makeEventStamp = stamper.makeEventStamp;
    const mapExtensionFailure = makeExtensionFailureMapper(
      "Failed to process Copilot ACP extension event.",
    );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.copilot.extension",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: CopilotSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.copilot.extension",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = requireScaffoldSession(sessions, PROVIDER);

    const stopSessionInternal = (ctx: CopilotSessionContext) =>
      stopScaffoldSession({
        ctx,
        sessions,
        releaseThreadLock: locks.releaseThreadLock,
        offerRuntimeEvent,
        makeEventStamp,
        provider: PROVIDER,
      });

    const startSession: CopilotAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const copilotModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: CopilotSessionContext;

          const resumeSessionId = parseCopilotResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          // Resolve the CopilotSettings used to spawn the ACP child. Production
          // leaves `options.resolveSettings` undefined so we use the value
          // captured at adapter construction — per-instance isolation is
          // enforced by the hydration layer rebuilding this adapter whenever
          // its config changes. Tests set `resolveSettings` to pull the latest
          // snapshot from `ServerSettingsService` so that mid-suite
          // `updateSettings({ providers: { copilot: { binaryPath } } })` calls
          // actually take effect when the next session spawns.
          const effectiveCopilotSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : copilotSettings;
          const interactiveEnvironment = {
            ...(options?.environment ?? process.env),
          };
          // Copilot models and reasoning effort are fixed at server spawn
          // (`--model` / `--effort`) — `session/new` carries neither. Resolve
          // them before spawning so the session starts on the selected model.
          const initialModel = copilotModelSelection
            ? resolveCopilotAcpBaseModelId(copilotModelSelection.model)
            : undefined;
          const initialEffort = getCopilotReasoningEffort(copilotModelSelection);

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeCopilotAcpRuntime({
            copilotSettings: effectiveCopilotSettings,
            environment: interactiveEnvironment,
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(initialModel ? { model: initialModel } : {}),
            ...(initialEffort ? { effort: initialEffort } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to start the Copilot ACP session process.",
                  cause,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "session/request_permission",
                    params,
                    "acp.jsonrpc",
                  );
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectCopilotAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, {
                    decision,
                    kind: permissionRequest.kind,
                  });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  return permissionOutcome(params, resolved);
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          // Copilot advertises no `models` in `session/new` — the session runs
          // whatever `--model` the server spawned with (default `auto`).
          // Permissions (`allow_all`) and mode (agent/plan) are applied here;
          // model switches mid-session go through `/model <slug>` in sendTurn.
          const advertisedModels = undefined;
          const appliedModelId = yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            modelSelection: copilotModelSelection,
            advertisedModels,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });
          yield* applyCopilotReasoningEffort({
            runtime: acp,
            reasoningEffort: getCopilotReasoningEffort(copilotModelSelection),
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const sessionModel = appliedModelId ?? initialModel ?? "auto";
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: sessionModel,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: COPILOT_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            copilotSkillNames: undefined,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            promptSettlements: new Set(),
            stopped: false,
            // Seed with the resolved session model (same fallback chain as
            // `session.model` above) so the first sendTurn without an explicit
            // selection compares equal and skips a redundant `set_mode` RPC.
            appliedModel: sessionModel,
            appliedReasoningEffort: getCopilotReasoningEffort(copilotModelSelection),
            advertisedModels,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ThoughtDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        streamKind: "reasoning_text",
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "AvailableCommandsUpdated":
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Copilot runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber. `forkChild`
            // makes this a child of `startSession`, and Effect interrupts a
            // fiber's children when it completes, so the consumer died as soon
            // as `startSession` returned and every later notification was
            // dropped. The scope is created, stored on the context and closed
            // on teardown already; only the fork target was wrong.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Copilot ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: CopilotAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const promptSettlement = yield* Deferred.make<void>();
        const run = Effect.gen(function* () {
          // Accounting is serialized under the thread lock: a concurrent
          // sendTurn must observe this prompt's turn id (and this prompt's
          // in-flight count) atomically, or two prompts can both treat
          // themselves as a fresh turn and emit duplicate `turn.started`.
          const prepared = yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              // A sendTurn while a prompt is in flight is a steer: the agent folds
              // the new prompt into the ongoing work, so the active turn id is
              // reused instead of opening a new turn.
              const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
              const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
              const earlierPromptSettlements = Array.from(ctx.promptSettlements);
              ctx.promptSettlements.add(promptSettlement);
              // Count this prompt immediately so a superseded in-flight prompt
              // resolving from here on does not settle the turn; the matching
              // decrement is the `ensuring` below.
              ctx.promptsInFlight += 1;
              // Bind the turn id before any cooperative yield so interruptTurn
              // can mark this prompt interrupted even while it is being prepared.
              ctx.activeTurnId = turnId;
              return { ctx, steeringTurnId, turnId, earlierPromptSettlements };
            }),
          );
          const { ctx, steeringTurnId, turnId, earlierPromptSettlements } = prepared;
          const clearPhantomActiveTurn = () => {
            if (steeringTurnId === undefined) {
              ctx.activeTurnId = undefined;
            }
          };
          // A fresh turn id is a UUID that is never reused, so a preparation
          // abort must retire it from the interrupt set right away; otherwise
          // every aborted preparation leaks one entry for the session's
          // lifetime. A steered turn keeps running and must stay marked.
          const retireAbortedFreshTurn = () => {
            if (steeringTurnId === undefined) {
              ctx.interruptedTurnIds.delete(turnId);
            }
          };

          if (
            steeringTurnId !== undefined &&
            (input.attachments?.length ?? 0) > 0 &&
            earlierPromptSettlements.length > 0
          ) {
            // Hermes can redirect text while active, but queues rich media as
            // a text placeholder. Stop the active request and wait for its RPC
            // to settle before submitting the intact image blocks. This wait is
            // deliberately outside the thread lock so interruptTurn can still
            // cancel while it is in progress.
            yield* ctx.acp
              .notify("session/cancel", { sessionId: ctx.acpSessionId })
              .pipe(Effect.ignore);
            yield* Effect.forEach(earlierPromptSettlements, Deferred.await, {
              discard: true,
            });
            // A stop that arrived while the previous prompt was settling must
            // not resurrect the turn with a fresh image prompt.
            if (ctx.interruptedTurnIds.has(turnId)) {
              // The superseded prompt already skipped its completion (another
              // prompt was in flight), so close the turn here or the thread
              // would stay running forever.
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { state: "cancelled", stopReason: "cancelled" },
              });
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: "Copilot image steer was interrupted.",
              });
            }
          }
          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          const rawPrompt = input.input?.trim() ?? "";
          if (rawPrompt) {
            // Copilot skills surface as `/SKILL-NAME` slash commands over ACP;
            // no local `$name` rewriting is needed.
            promptParts.push({ type: "text", text: rawPrompt });
          }
          if (input.attachments && input.attachments.length > 0) {
            for (const attachment of input.attachments) {
              // Copilot ingests images only. Generic files reach the agent
              // through the path line ProviderService puts in the prompt.
              if (attachment.type !== "image") {
                continue;
              }
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                clearPhantomActiveTurn();
                retireAbortedFreshTurn();
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.tapCause(() => Effect.sync(clearPhantomActiveTurn)),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: "Failed to read attachment file.",
                      cause,
                    }),
                ),
              );
              promptParts.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }
          }

          if (promptParts.length === 0) {
            // A rejected turn must not leave a phantom active turn behind.
            clearPhantomActiveTurn();
            retireAbortedFreshTurn();
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          // A stop that arrived while the prompt was being prepared (attachment
          // I/O or config) must not publish a turn.started afterwards.
          if (ctx.interruptedTurnIds.has(turnId)) {
            clearPhantomActiveTurn();
            retireAbortedFreshTurn();
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: "Copilot prompt was interrupted during preparation.",
            });
          }

          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          const resolvedModel = resolveCopilotAcpBaseModelId(model);
          // Copilot has no `session/set_model` — the model is fixed at spawn
          // via `--model`. Switch mid-session by sending `/model <slug>` as a
          // prompt first; the CLI replies "Model changed to: …" (or a
          // plan-restriction message) as agent text. Only do this when the
          // selection actually changed to avoid polluting history.
          if (ctx.appliedModel !== resolvedModel) {
            yield* ctx.acp
              .prompt({ prompt: [{ type: "text", text: `/model ${resolvedModel}` }] })
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                ),
                // A failed `/model` switch must not fail the user's turn — the
                // agent's reply already explains plan restrictions.
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    "Copilot /model switch failed; continuing with session model.",
                    {
                      cause,
                    },
                  ),
                ),
              );
            // Drain the model-switch turn's events so its "Model changed"
            // message doesn't leak into the user's turn output accounting.
            yield* ctx.acp.drainEvents.pipe(Effect.ignore);
            ctx.appliedModel = resolvedModel;
            ctx.session = { ...ctx.session, model: resolvedModel, updatedAt: yield* nowIso };
          }
          const requestedReasoningEffort = getCopilotReasoningEffort(turnModelSelection);
          if (
            requestedReasoningEffort !== undefined &&
            ctx.appliedReasoningEffort !== requestedReasoningEffort
          ) {
            // Effort is spawn-time only (`--effort`); record it so the picker
            // reflects the selection, but don't RPC (no supported option).
            ctx.appliedReasoningEffort = requestedReasoningEffort;
          }
          // Keep permissions/mode in sync per turn (best-effort, never fails).
          yield* applyRequestedSessionConfiguration({
            runtime: ctx.acp,
            runtimeMode: ctx.session.runtimeMode,
            modelSelection: undefined,
            advertisedModels: undefined,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          }).pipe(Effect.ignore);
          if (steeringTurnId === undefined) {
            ctx.lastPlanFingerprint = undefined;
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          if (steeringTurnId === undefined) {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: resolvedModel },
            });
          }

          const promptResult = yield* ctx.acp
            .prompt({
              prompt: [
                ...promptParts,
                // ACP has no system-message field; keep runtime context
                // separate from the user's text, like Cursor/Grok do.
                {
                  type: "text",
                  text: buildRuntimeInstructions({ harness: "Copilot", model: resolvedModel }),
                },
              ],
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
              Effect.timeoutOption(Duration.millis(turnTimeoutMs)),
            );

          if (Option.isNone(promptResult)) {
            // The deadline fired. A steered turn (another prompt in flight)
            // keeps running, so only the last remaining prompt settles it —
            // cancelling here would kill the surviving prompt's ACP request.
            const remainingPrompts = yield* withThreadLock(
              input.threadId,
              Effect.sync(() => ctx.promptsInFlight),
            );
            if (remainingPrompts <= 1) {
              yield* Effect.ignore(
                ctx.acp.cancel.pipe(
                  Effect.mapError((error) =>
                    mapAcpToAdapterError(PROVIDER, input.threadId, "session/cancel", error),
                  ),
                ),
              );
              yield* withThreadLock(
                input.threadId,
                Effect.gen(function* () {
                  ctx.interruptedTurnIds.delete(turnId);
                  yield* offerRuntimeEvent({
                    type: "turn.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    payload: { state: "cancelled", stopReason: "cancelled" },
                  });
                }),
              );
            }
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: `Copilot turn timed out after ${turnTimeoutMs}ms without completing.`,
            });
          }
          const result = promptResult.value;

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
              if (turnRecord) {
                turnRecord.items.push({ prompt: promptParts, result });
              } else {
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
              }
              ctx.session = {
                ...ctx.session,
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                model: resolvedModel,
              };

              // Only the last remaining prompt settles the turn — a steer-
              // superseded prompt resolving (usually cancelled) while another is
              // in flight or pending must leave the merged turn running.
              if (ctx.promptsInFlight === 1) {
                // The turn is over and its id will never be reused (every
                // sendTurn mints a fresh UUID), so retire it from the
                // interrupt set instead of leaking one entry per turn for
                // the session's lifetime.
                ctx.interruptedTurnIds.delete(turnId);
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: result.stopReason ?? null,
                  },
                });
              }

              return {
                threadId: input.threadId,
                turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        });
        return yield* run.pipe(
          Effect.ensuring(
            withThreadLock(
              input.threadId,
              Effect.sync(() => {
                const ctx = sessions.get(input.threadId);
                if (!ctx) {
                  return;
                }
                ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
                ctx.promptSettlements.delete(promptSettlement);
              }).pipe(Effect.andThen(Deferred.succeed(promptSettlement, undefined)), Effect.asVoid),
            ),
          ),
        );
      });

    const interruptTurn: CopilotAdapterShape["interruptTurn"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const interruptedTurnId = ctx.activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
          yield* Effect.ignore(
            ctx.acp.cancel.pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
              ),
            ),
          );
        }),
      );

    const respondToRequest: CopilotAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: CopilotAdapterShape["respondToUserInput"] = (threadId, requestId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        // Copilot only sends session/request_permission, never user-input
        // requests, so there is nothing to answer: fail instead of dropping it.
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: `Copilot does not emit user-input requests (unknown request: ${requestId}).`,
        });
      });

    const readThread: CopilotAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CopilotAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CopilotAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CopilotAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CopilotAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: CopilotAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Copilot session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      compaction: { type: "slash-command", command: "/compact" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies CopilotAdapterShape;
  });
}
