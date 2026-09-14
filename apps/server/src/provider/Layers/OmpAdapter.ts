/**
 * OmpAdapterLive — Oh-My-Pi / Pi CLI (`--mode rpc`) via the native RPC
 * protocol.
 *
 * One adapter owns one harness subprocess per T3 thread: `startSession`
 * spawns `<binary> --mode rpc`, `sendTurn` issues `prompt` (or a `steer`
 * while a turn runs), and `interruptTurn` issues `abort`. Agent events off
 * the process stdout are translated into canonical `ProviderRuntimeEvent`s.
 *
 * Extension UI dialogs (`extension_ui_request` with `select` / `confirm` /
 * `input` / `editor`) surface as `user-input.requested` events and resolve
 * through `respondToUserInput`. The harness runs tools without asking, so
 * `respondToRequest` (tool approvals) always fails — mirroring Copilot's
 * `respondToUserInput` for its unsupported direction.
 *
 * @module provider/Layers/OmpAdapter
 */
import {
  ApprovalRequestId,
  type OmpSettings,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { hasOmpSkillMention, rewriteOmpSkillMentions } from "../Drivers/OmpSkills.ts";
import {
  buildPromptCommand,
  deltaFromMessageUpdate,
  isThinkingDelta,
  lastAssistantText,
  parseAvailableModels,
  parseCommandDescriptors,
  parseSessionState,
  extractSkillNames,
  isPiThinkingLevel,
  splitProviderModel,
  toolCallFromToolEvent,
  type PiRpcEvent,
  type PiRpcImage,
  type PiRpcModel,
} from "../pi/PiRpcProtocol.ts";
import {
  makePiRpcClient,
  makePiRpcProcessTransport,
  type PiRpcClient,
  type PiRpcClientError,
} from "../pi/PiRpcClient.ts";
import {
  makeOmpContentDeltaEvent,
  makeOmpToolCallEvent,
  makeOmpTurnCompletedEvent,
  makeOmpUserInputRequestedEvent,
  makeOmpUserInputResolvedEvent,
} from "../pi/OmpRuntimeEvents.ts";
import type { OmpAdapterShape } from "../Services/OmpAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const OMP_RESUME_VERSION = 1 as const;
// Absolute per-turn backstop: without one a stalled harness turn leaves the
// thread on "Working" forever. Matches the Hermes/Copilot adapters.
const DEFAULT_OMP_TURN_TIMEOUT_MS = 30 * 60 * 1_000;
// RPC request budget for session setup calls (get_state, set_model, ...).
const OMP_SETUP_REQUEST_TIMEOUT_MS = 30_000;

export interface OmpAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`omp`).
   */
  readonly instanceId?: ProviderInstanceId;
  /** Override the absolute per-turn prompt deadline in focused tests. */
  readonly turnTimeoutMs?: number;
  /**
   * Optional per-session settings resolver (see Hermes/Copilot adapters).
   * Production leaves this undefined; tests swap `binaryPath` mid-flight.
   */
  readonly resolveSettings?: Effect.Effect<OmpSettings>;
}

interface PendingUserInput {
  /** Harness-side dialog id for `extension_ui_response`. */
  readonly dialogId: string;
  readonly method: string;
  readonly resolution: Deferred.Deferred<Record<string, unknown> | undefined>;
}

interface PendingTurn {
  readonly turnId: TurnId;
  readonly completion: Deferred.Deferred<{ readonly messages: unknown } | undefined>;
}

interface OmpSessionContext {
  readonly threadId: ThreadId;
  /** Harness-side session id from `get_state` (for `--session` resume). */
  rpcSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly rpc: PiRpcClient;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  skillNames: ReadonlySet<string>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late agent frames must not resurrect them. */
  readonly interruptedTurnIds: Set<TurnId>;
  /** Prompts currently in flight or being prepared. >0 means a new sendTurn is a steer. */
  promptsInFlight: number;
  /** Waiters settled by the next `agent_end` (or interrupt/timeout). */
  pendingTurns: PendingTurn[];
  turnToolCalls: string[];
  stopped: boolean;
  appliedModel: string | undefined;
  appliedThinkingLevel: string | undefined;
  advertisedModels: ReadonlyArray<PiRpcModel>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOmpResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== OMP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function resolveOmpAgentDir(
  settings: Pick<OmpSettings, "agentDir">,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const configured = settings.agentDir.trim();
  if (!configured) return environment ?? process.env;
  return {
    ...(environment ?? process.env),
    PI_AGENT_DIR: expandHomePath(configured),
  };
}

/**
 * Spawn argv for `<binary> --mode rpc`. Exported for unit tests and the
 * status probe, which spawns short-lived siblings of the session process.
 */
export function buildOmpRpcSpawnArgs(input: {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly resumeSessionId?: string;
  readonly noSession?: boolean;
}): ReadonlyArray<string> {
  const args: string[] = ["--mode", "rpc"];
  if (input.provider?.trim()) args.push("--provider", input.provider.trim());
  if (input.model?.trim()) args.push("--model", input.model.trim());
  if (input.thinking?.trim()) args.push("--thinking", input.thinking.trim());
  if (input.resumeSessionId?.trim()) {
    args.push("--session", input.resumeSessionId.trim());
  } else if (input.noSession === true) {
    args.push("--no-session");
  }
  return args;
}

export function getOmpReasoningEffort(
  modelSelection:
    | {
        readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
      }
    | undefined,
): string | undefined {
  const raw =
    modelSelection?.options?.find((option) => option.id === "reasoningEffort")?.value ??
    modelSelection?.options?.find((option) => option.id === "effort")?.value ??
    modelSelection?.options?.find((option) => option.id === "thinkingLevel")?.value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return isPiThinkingLevel(trimmed) ? trimmed : undefined;
}

/**
 * Resolve a stored model selection against the live catalog from
 * `get_available_models`. `set_model` requires an exact provider+id match,
 * so unresolvable ids return `undefined` and the caller keeps the session
 * model instead of failing the turn.
 */
export function resolveOmpSessionModel(
  model: string | null | undefined,
  advertised: ReadonlyArray<PiRpcModel>,
  currentModel: PiRpcModel | null,
): { readonly provider: string; readonly modelId: string } | undefined {
  const requested = model?.trim();
  if (!requested || requested === "default") return undefined;
  const { provider, modelId } = splitProviderModel(requested);
  const byExact = advertised.find(
    (entry) => entry.id === modelId && (provider === undefined || entry.provider === provider),
  );
  if (byExact?.provider) return { provider: byExact.provider, modelId: byExact.id };
  // Bare id matching the running model stays on its provider.
  if (
    provider === undefined &&
    currentModel &&
    currentModel.id === modelId &&
    currentModel.provider
  ) {
    return { provider: currentModel.provider, modelId };
  }
  // Anything else cannot satisfy set_model's exact provider+id match, so
  // the caller keeps the session model instead of failing the turn.
  return undefined;
}

function mapRpcToAdapterError(
  threadId: ThreadId,
  method: string,
  cause: PiRpcClientError,
): ProviderAdapterRequestError | ProviderAdapterProcessError {
  if (cause._tag === "PiRpcCommandError" || cause._tag === "PiRpcTimeoutError") {
    return new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: cause.message,
      cause,
    });
  }
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: cause.message,
    cause,
  });
}

function textFromToolResultPayload(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string" && block.text) parts.push(block.text);
  }
  const text = parts.join("\n").trim();
  return text || undefined;
}

export function makeOmpAdapter(ompSettings: OmpSettings, options?: OmpAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("omp");
    const requestedTurnTimeoutMs = options?.turnTimeoutMs;
    const turnTimeoutMs =
      typeof requestedTurnTimeoutMs === "number" && Number.isFinite(requestedTurnTimeoutMs)
        ? Math.max(1, Math.floor(requestedTurnTimeoutMs))
        : DEFAULT_OMP_TURN_TIMEOUT_MS;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, OmpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Oh-My-Pi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(threadId);
        if (existing) return Effect.succeed([existing, current] as const);
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(threadId, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<OmpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
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
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Oh-My-Pi notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const settlePendingUserInputsAsCancelled = (ctx: OmpSessionContext) =>
      Effect.forEach(
        Array.from(ctx.pendingUserInputs.entries()),
        ([requestId, pending]) =>
          Effect.gen(function* () {
            ctx.pendingUserInputs.delete(requestId);
            yield* Deferred.succeed(pending.resolution, undefined).pipe(Effect.ignore);
            yield* offerRuntimeEvent(
              makeOmpUserInputResolvedEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                requestId: RuntimeRequestId.make(requestId),
                answers: {},
              }),
            );
          }),
        { discard: true },
      );

    const settleTurn = (
      ctx: OmpSessionContext,
      turnId: TurnId,
      state: "completed" | "failed" | "cancelled",
      errorMessage?: string,
    ) =>
      Effect.gen(function* () {
        if (ctx.activeTurnId !== turnId) return;
        ctx.activeTurnId = undefined;
        ctx.promptsInFlight = 0;
        const waiters = ctx.pendingTurns;
        ctx.pendingTurns = [];
        ctx.turns.push({
          id: turnId,
          items: [{ prompt: true, state, toolCalls: [...ctx.turnToolCalls] }],
        });
        ctx.turnToolCalls = [];
        for (const waiter of waiters) {
          yield* Deferred.succeed(waiter.completion, undefined).pipe(Effect.ignore);
        }
        yield* offerRuntimeEvent(
          makeOmpTurnCompletedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            state,
            ...(errorMessage ? { errorMessage } : {}),
          }),
        );
      });

    const stopSessionInternal = (ctx: OmpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        const activeTurnId = ctx.activeTurnId;
        if (activeTurnId !== undefined) {
          ctx.interruptedTurnIds.add(activeTurnId);
          yield* settleTurn(ctx, activeTurnId, "cancelled");
        }
        yield* settlePendingUserInputsAsCancelled(ctx);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(ctx.rpc.close);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* SynchronizedRef.update(threadLocksRef, (current) => {
          const next = new Map(current);
          next.delete(ctx.threadId);
          return next;
        });
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const dialogOptionsFromRequest = (
      event: PiRpcEvent,
    ): ReadonlyArray<{ readonly label: string; readonly description: string }> => {
      const rawOptions = event.options;
      if (!Array.isArray(rawOptions)) return [];
      return rawOptions.flatMap((option) => {
        if (typeof option === "string") {
          return option.trim() ? [{ label: option.trim(), description: option.trim() }] : [];
        }
        if (!isRecord(option)) return [];
        const label =
          typeof option.label === "string" && option.label.trim()
            ? option.label.trim()
            : typeof option.value === "string" && option.value.trim()
              ? option.value.trim()
              : undefined;
        if (!label) return [];
        return [
          {
            label,
            description:
              typeof option.description === "string" && option.description.trim()
                ? option.description.trim()
                : label,
          },
        ];
      });
    };

    const handleExtensionUiRequest = (ctx: OmpSessionContext, event: PiRpcEvent) =>
      Effect.gen(function* () {
        yield* logNative(ctx.threadId, "extension_ui_request", event);
        const dialogId = typeof event.id === "string" && event.id ? event.id : undefined;
        const method = typeof event.method === "string" ? event.method : "";
        if (
          !dialogId ||
          (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor")
        ) {
          // Fire-and-forget frames (notify, setStatus, setWidget, ...) need
          // no response; anything malformed is logged and dropped.
          if (dialogId === undefined && method) return;
          yield* Effect.logDebug("Ignoring non-dialog Oh-My-Pi extension UI request.", { method });
          return;
        }
        const title =
          typeof event.title === "string" && event.title.trim() ? event.title.trim() : method;
        const message =
          typeof event.message === "string" && event.message.trim()
            ? event.message.trim()
            : typeof event.placeholder === "string" && event.placeholder.trim()
              ? event.placeholder.trim()
              : title;
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const resolution = yield* Deferred.make<Record<string, unknown> | undefined>();
        ctx.pendingUserInputs.set(requestId, { dialogId, method, resolution });
        yield* offerRuntimeEvent(
          makeOmpUserInputRequestedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            header: title,
            question: message,
            options:
              method === "confirm"
                ? [
                    { label: "Confirm", description: "Confirm" },
                    { label: "Cancel", description: "Cancel" },
                  ]
                : dialogOptionsFromRequest(event),
            rawPayload: event,
          }),
        );
      });

    const runNotificationConsumer = (ctx: OmpSessionContext) =>
      ctx.rpc.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* logNative(ctx.threadId, event.type, event);
            switch (event.type) {
              case "message_update": {
                const delta = deltaFromMessageUpdate(event);
                if (!delta) return;
                yield* offerRuntimeEvent(
                  makeOmpContentDeltaEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    streamKind: isThinkingDelta(event) ? "reasoning_text" : "assistant_text",
                    text: delta,
                    rawPayload: event,
                  }),
                );
                return;
              }
              case "tool_execution_start": {
                const toolCall = toolCallFromToolEvent(event);
                if (!toolCall) return;
                ctx.turnToolCalls.push(`${toolCall.toolName}:${toolCall.toolCallId}`);
                yield* offerRuntimeEvent(
                  makeOmpToolCallEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    status: "inProgress",
                    ...(toolCall.args !== undefined ? { data: toolCall.args } : {}),
                    rawPayload: event,
                  }),
                );
                return;
              }
              case "tool_execution_update": {
                const toolCall = toolCallFromToolEvent(event);
                if (!toolCall) return;
                const partial = isRecord(event.partialResult)
                  ? textFromToolResultPayload(event.partialResult)
                  : undefined;
                yield* offerRuntimeEvent(
                  makeOmpToolCallEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    status: "inProgress",
                    ...(partial ? { detail: partial.slice(0, 2000) } : {}),
                    rawPayload: event,
                  }),
                );
                return;
              }
              case "tool_execution_end": {
                const toolCall = toolCallFromToolEvent(event);
                if (!toolCall) return;
                const failed = event.isError === true;
                const resultText = textFromToolResultPayload(event.result);
                yield* offerRuntimeEvent(
                  makeOmpToolCallEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: ctx.activeTurnId,
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    status: failed ? "failed" : "completed",
                    ...(resultText ? { detail: resultText.slice(0, 2000) } : {}),
                    rawPayload: event,
                  }),
                );
                return;
              }
              case "agent_end": {
                const messages = Array.isArray(event.messages) ? event.messages : [];
                const waiters = ctx.pendingTurns;
                if (waiters.length === 0 || ctx.activeTurnId === undefined) {
                  yield* Effect.logDebug("Oh-My-Pi agent_end without an active turn; ignoring.");
                  return;
                }
                const activeTurnId = ctx.activeTurnId;
                if (ctx.interruptedTurnIds.has(activeTurnId)) return;
                ctx.pendingTurns = [];
                ctx.promptsInFlight = 0;
                const assistantText = lastAssistantText(messages);
                ctx.turns.push({
                  id: activeTurnId,
                  items: [
                    {
                      prompt: true,
                      state: "completed",
                      ...(assistantText ? { assistantText } : {}),
                      toolCalls: [...ctx.turnToolCalls],
                    },
                  ],
                });
                ctx.turnToolCalls = [];
                ctx.activeTurnId = undefined;
                for (const waiter of waiters) {
                  yield* Deferred.succeed(waiter.completion, { messages }).pipe(Effect.ignore);
                }
                yield* offerRuntimeEvent(
                  makeOmpTurnCompletedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: ctx.threadId,
                    turnId: activeTurnId,
                    state: "completed",
                  }),
                );
                return;
              }
              case "extension_ui_request": {
                yield* handleExtensionUiRequest(ctx, event);
                return;
              }
              default:
                return;
            }
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("Failed to process Oh-My-Pi runtime notification.", { cause }),
        ),
        Effect.forkIn(ctx.scope),
      );

    const applyModelSelection = (
      ctx: OmpSessionContext,
      threadId: ThreadId,
      modelSelection: { readonly model: string } | undefined,
      currentModel: PiRpcModel | null,
    ) =>
      Effect.gen(function* () {
        if (!modelSelection) return currentModel?.id;
        const resolved = resolveOmpSessionModel(
          modelSelection.model,
          ctx.advertisedModels,
          currentModel,
        );
        const resolvedId = resolved ? `${resolved.provider}/${resolved.modelId}` : undefined;
        if (!resolved || ctx.appliedModel === resolvedId) {
          return ctx.appliedModel ?? currentModel?.id;
        }
        // set_model needs an exact catalog match. A stale or cross-provider
        // id must keep the session on its current model instead of failing
        // the session start, so only a successful RPC updates appliedModel.
        const outcome = yield* ctx.rpc
          .request(
            { type: "set_model", provider: resolved.provider, modelId: resolved.modelId },
            OMP_SETUP_REQUEST_TIMEOUT_MS,
          )
          .pipe(
            Effect.mapError((cause) => mapRpcToAdapterError(threadId, "set_model", cause)),
            Effect.exit,
          );
        if (Exit.isFailure(outcome)) {
          yield* Effect.logWarning("Oh-My-Pi model selection failed; keeping session model.", {
            cause: String(outcome.cause),
            requested: modelSelection.model,
          });
          return ctx.appliedModel ?? currentModel?.id;
        }
        ctx.appliedModel = resolvedId;
        return resolvedId;
      });

    const applyThinkingLevel = (
      ctx: OmpSessionContext,
      threadId: ThreadId,
      thinking: string | undefined,
    ) =>
      Effect.gen(function* () {
        if (!thinking || !isPiThinkingLevel(thinking) || ctx.appliedThinkingLevel === thinking)
          return;
        yield* ctx.rpc
          .request({ type: "set_thinking_level", level: thinking }, OMP_SETUP_REQUEST_TIMEOUT_MS)
          .pipe(
            Effect.mapError((cause) => mapRpcToAdapterError(threadId, "set_thinking_level", cause)),
            Effect.catchCause((cause) =>
              Effect.logWarning("Oh-My-Pi thinking level failed; keeping session default.", {
                cause,
                requested: thinking,
              }),
            ),
          );
        ctx.appliedThinkingLevel = thinking;
      });

    const startSession: OmpAdapterShape["startSession"] = (input) =>
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
          const ompModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const effectiveOmpSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : ompSettings;
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const baseEnv = resolveOmpAgentDir(
            effectiveOmpSettings,
            options?.environment ?? process.env,
          );
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const processEnv = McpProviderSession.withAgentDeviceEnvironment(baseEnv, mcpSession);

          const resumeSessionId = parseOmpResume(input.resumeCursor)?.sessionId;
          const rawSelectionModel =
            ompModelSelection?.model ?? effectiveOmpSettings.model.trim() ?? undefined;
          // The harness default ("default") means "no flag": passing it as a
          // model id makes the harness hang resolving a model named default.
          const selectionModel =
            rawSelectionModel && rawSelectionModel !== "default" ? rawSelectionModel : undefined;
          const selectionProvider = selectionModel
            ? splitProviderModel(selectionModel).provider
            : undefined;
          const spawnProvider =
            selectionProvider ?? effectiveOmpSettings.provider.trim() ?? undefined;
          const spawnThinking =
            getOmpReasoningEffort(ompModelSelection) ?? effectiveOmpSettings.thinkingLevel;
          const transport = yield* makePiRpcProcessTransport({
            command: effectiveOmpSettings.binaryPath || "omp",
            args: buildOmpRpcSpawnArgs({
              ...(spawnProvider ? { provider: spawnProvider } : {}),
              ...(selectionModel ? { model: selectionModel } : {}),
              ...(spawnThinking ? { thinking: spawnThinking } : {}),
              ...(resumeSessionId ? { resumeSessionId } : {}),
            }),
            cwd,
            env: processEnv,
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to start the Oh-My-Pi RPC process.",
                  cause,
                }),
            ),
          );
          const rpc = yield* makePiRpcClient(transport).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
          );

          const ctx: OmpSessionContext = {
            threadId: input.threadId,
            rpcSessionId: resumeSessionId ?? "",
            session: undefined as never,
            scope: sessionScope,
            rpc,
            notificationFiber: undefined,
            pendingUserInputs: new Map(),
            skillNames: new Set(),
            turns: [],
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            pendingTurns: [],
            turnToolCalls: [],
            stopped: false,
            appliedModel: undefined,
            appliedThinkingLevel: undefined,
            advertisedModels: [],
          };
          sessions.set(input.threadId, ctx);
          ctx.notificationFiber = yield* runNotificationConsumer(ctx).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
          );

          const stateData = yield* rpc
            .request({ type: "get_state" }, OMP_SETUP_REQUEST_TIMEOUT_MS)
            .pipe(
              Effect.mapError((cause) => mapRpcToAdapterError(input.threadId, "get_state", cause)),
            );
          const state = parseSessionState(stateData);
          if (!state) {
            sessions.delete(input.threadId);
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Oh-My-Pi get_state returned an unparseable session state.",
            });
          }
          if (state.sessionId) ctx.rpcSessionId = state.sessionId;

          const availableData = yield* rpc
            .request({ type: "get_available_models" }, OMP_SETUP_REQUEST_TIMEOUT_MS)
            .pipe(
              Effect.mapError((cause) =>
                mapRpcToAdapterError(input.threadId, "get_available_models", cause),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("Oh-My-Pi model catalog unavailable; continuing.", {
                  cause,
                }).pipe(Effect.as({ models: [] as PiRpcModel[] })),
              ),
            );
          ctx.advertisedModels = parseAvailableModels(availableData);

          const appliedModelId = yield* applyModelSelection(
            ctx,
            input.threadId,
            ompModelSelection,
            state.model,
          );
          if (!ompModelSelection && selectionModel) {
            const resolved = resolveOmpSessionModel(
              selectionModel,
              ctx.advertisedModels,
              state.model,
            );
            if (resolved) {
              ctx.appliedModel = `${resolved.provider}/${resolved.modelId}`;
            } else if (state.model) {
              ctx.appliedModel = state.model.provider
                ? `${state.model.provider}/${state.model.id}`
                : state.model.id;
            }
          } else if (state.model) {
            ctx.appliedModel ??= state.model.provider
              ? `${state.model.provider}/${state.model.id}`
              : state.model.id;
          }
          yield* applyThinkingLevel(
            ctx,
            input.threadId,
            getOmpReasoningEffort(ompModelSelection) ?? state.thinkingLevel ?? spawnThinking,
          );

          if (input.title?.trim()) {
            yield* rpc
              .request(
                { type: "set_session_name", name: input.title.trim() },
                OMP_SETUP_REQUEST_TIMEOUT_MS,
              )
              .pipe(
                Effect.mapError((cause) =>
                  mapRpcToAdapterError(input.threadId, "set_session_name", cause),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Oh-My-Pi set_session_name failed; continuing.", { cause }),
                ),
              );
          }

          const commandsData = yield* rpc
            .request({ type: "get_commands" }, OMP_SETUP_REQUEST_TIMEOUT_MS)
            .pipe(
              Effect.mapError((cause) =>
                mapRpcToAdapterError(input.threadId, "get_commands", cause),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("Oh-My-Pi command catalog unavailable; continuing.", {
                  cause,
                }).pipe(Effect.as({ commands: [] as unknown[] })),
              ),
            );
          ctx.skillNames = new Set(
            extractSkillNames(parseCommandDescriptors(commandsData)).map((skill) => skill.name),
          );

          const now = yield* nowIso;
          const sessionModel = appliedModelId ?? state.model?.id ?? "default";
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: sessionModel,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: OMP_RESUME_VERSION,
              sessionId: ctx.rpcSessionId,
            },
            createdAt: now,
            updatedAt: now,
          };
          ctx.session = session;
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {},
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Oh-My-Pi RPC session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: ctx.rpcSessionId ? { providerThreadId: ctx.rpcSessionId } : {},
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            const completion = yield* Deferred.make<{ readonly messages: unknown } | undefined>();
            ctx.pendingTurns.push({ turnId, completion });
            ctx.promptsInFlight += 1;
            ctx.activeTurnId = turnId;
            return { ctx, steeringTurnId, turnId, completion };
          }),
        );
        const { ctx, steeringTurnId, turnId, completion } = prepared;
        const abortPreparation = () =>
          withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const live = sessions.get(input.threadId);
              if (live !== ctx) return;
              ctx.pendingTurns = ctx.pendingTurns.filter((waiter) => waiter.turnId !== turnId);
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
              if (steeringTurnId === undefined) ctx.activeTurnId = undefined;
              yield* Deferred.succeed(completion, undefined).pipe(Effect.ignore);
            }),
          );

        if (ctx.interruptedTurnIds.has(turnId) || ctx.stopped) {
          yield* abortPreparation();
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: "Oh-My-Pi prompt was interrupted during preparation.",
          });
        }

        const rawPrompt = input.input?.trim() ?? "";
        const promptParts: string[] = [];
        if (rawPrompt) {
          promptParts.push(
            ctx.skillNames.size > 0 && hasOmpSkillMention(rawPrompt)
              ? rewriteOmpSkillMentions(rawPrompt, ctx.skillNames)
              : rawPrompt,
          );
        }
        const images: PiRpcImage[] = [];
        if (input.attachments && input.attachments.length > 0) {
          for (const attachment of input.attachments) {
            if (attachment.type !== "image") continue;
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              yield* abortPreparation();
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
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
            images.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
        }
        if (promptParts.length === 0 && images.length === 0) {
          yield* abortPreparation();
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const modelBeforeTurn = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const live = sessions.get(input.threadId);
            if (live !== ctx || ctx.interruptedTurnIds.has(turnId)) return undefined;
            const stateData = yield* ctx.rpc
              .request({ type: "get_state" }, OMP_SETUP_REQUEST_TIMEOUT_MS)
              .pipe(Effect.option);
            const current = Option.match(stateData, {
              onNone: () => null,
              onSome: (data) => parseSessionState(data)?.model ?? null,
            });
            return yield* applyModelSelection(ctx, input.threadId, turnModelSelection, current);
          }),
        );
        if (modelBeforeTurn === undefined && ctx.interruptedTurnIds.has(turnId)) {
          yield* abortPreparation();
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail: "Oh-My-Pi prompt was interrupted during preparation.",
          });
        }
        const resolvedModel = modelBeforeTurn ?? ctx.session.model ?? "default";
        if (steeringTurnId === undefined) {
          ctx.turnToolCalls = [];
        }
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          model: resolvedModel,
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

        const message = [
          ...promptParts,
          buildRuntimeInstructions({ harness: "Oh My Pi", model: resolvedModel }),
        ]
          .filter((part) => part.trim().length > 0)
          .join("\n\n");
        const promptResult = yield* ctx.rpc
          .request(
            buildPromptCommand({
              message,
              ...(images.length > 0 ? { images } : {}),
              ...(steeringTurnId !== undefined ? { streamingBehavior: "steer" as const } : {}),
            }),
            turnTimeoutMs,
          )
          .pipe(
            Effect.mapError((cause) => mapRpcToAdapterError(input.threadId, "prompt", cause)),
            Effect.exit,
          );
        if (Exit.isFailure(promptResult)) {
          yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const live = sessions.get(input.threadId);
              if (live === ctx) {
                yield* settleTurn(ctx, turnId, "failed", "Oh-My-Pi did not accept the prompt.");
              }
            }),
          );
          return yield* Effect.failCause(promptResult.cause);
        }

        const turnOutcome = yield* Deferred.await(completion).pipe(
          Effect.timeoutOption(turnTimeoutMs),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const live = sessions.get(input.threadId);
                    if (live === ctx && ctx.activeTurnId === turnId) {
                      yield* Effect.ignore(
                        ctx.rpc.request({ type: "abort" }, OMP_SETUP_REQUEST_TIMEOUT_MS),
                      );
                      yield* settleTurn(
                        ctx,
                        turnId,
                        "cancelled",
                        `Oh-My-Pi turn timed out after ${turnTimeoutMs}ms without completing.`,
                      );
                    }
                  }),
                ).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Oh-My-Pi turn timed out after ${turnTimeoutMs}ms without completing.`,
                      }),
                    ),
                  ),
                ),
              onSome: (value) => Effect.succeed(value),
            }),
          ),
        );
        void turnOutcome;

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const interruptedTurnId = ctx.activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          yield* settlePendingUserInputsAsCancelled(ctx);
          yield* Effect.ignore(ctx.rpc.request({ type: "abort" }, OMP_SETUP_REQUEST_TIMEOUT_MS));
          if (interruptedTurnId !== undefined) {
            yield* settleTurn(ctx, interruptedTurnId, "cancelled");
          }
        }),
      );

    const respondToRequest: OmpAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      _decision,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        // Oh-My-Pi runs tools without asking; approvals never open.
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: `Oh-My-Pi does not emit approval requests (unknown request: ${requestId}).`,
        });
      });

    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        ctx.pendingUserInputs.delete(requestId);
        const choice = answers["choice"];
        const responsePayload: Record<string, unknown> =
          pending.method === "confirm"
            ? typeof choice === "string" && /^(confirm|yes|true|1)$/i.test(choice.trim())
              ? { confirmed: true }
              : { confirmed: false }
            : choice === undefined
              ? { cancelled: true }
              : { value: choice };
        yield* ctx.rpc
          .notify({ type: "extension_ui_response", id: pending.dialogId, ...responsePayload })
          .pipe(
            Effect.mapError((cause) =>
              mapRpcToAdapterError(threadId, "extension_ui_response", cause),
            ),
          );
        yield* Deferred.succeed(pending.resolution, responsePayload).pipe(Effect.ignore);
        yield* offerRuntimeEvent(
          makeOmpUserInputResolvedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId,
            turnId: ctx.activeTurnId,
            requestId: RuntimeRequestId.make(requestId),
            answers,
          }),
        );
      });

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to emit Oh-My-Pi session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
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
    } satisfies OmpAdapterShape;
  });
}
