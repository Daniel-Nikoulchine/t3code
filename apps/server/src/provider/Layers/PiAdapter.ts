/**
 * PiAdapterLive — Pi CLI (`pi --mode rpc`) via JSONL RPC.
 *
 * One T3 thread owns one `pi --mode rpc` child process (one pi session).
 * Turns are serialized per thread: `sendTurn` emits `turn.started`, accepts
 * the pi `prompt` (or `steer` while streaming), and returns immediately —
 * completion (`turn.completed`) arrives asynchronously via `agent_end`.
 *
 * Pi tools run without approval gates; extension UI dialogs
 * (`extension_ui_request` with `select`/`confirm`/`input`/`editor`) are the
 * only interactive requests and surface as `user-input.requested`.
 *
 * @module PiAdapterLive
 */
import {
  ApprovalRequestId,
  type PiSettings,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
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
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  discoverPiSkills,
  hasPiSkillMention,
  rewritePiSkillMentions,
} from "../Drivers/PiSkills.ts";
import {
  buildPiModelSlug,
  buildPiResumeCursor,
  normalizePiThinkingLevel,
  parsePiModelSlug,
  parsePiResume,
  PI_DEFAULT_MODEL_SLUG,
  type PiThinkingLevel,
} from "../pi/PiRpcProtocol.ts";
import { makePiRpcRuntime, type PiRpcEvent, type PiRpcRuntime } from "../pi/PiRpcRuntime.ts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_RUNTIME_HARNESS = "pi";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export interface PiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  readonly resolveSettings?: Effect.Effect<PiSettings, ProviderAdapterProcessError>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
  readonly questionIds: ReadonlyArray<string>;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly rpc: PiRpcRuntime;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  turnSettled: boolean;
  interruptedTurnIds: Set<TurnId>;
  skillNames: ReadonlySet<string>;
  currentProvider: string | undefined;
  currentModelId: string | undefined;
  stopped: boolean;
}

function piToolToItemType(
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "bash") return "command_execution";
  if (normalized === "edit" || normalized === "write") return "file_change";
  return "dynamic_tool_call";
}

function toolTitle(toolName: string, args: unknown): string {
  if (toolName === "bash" && isRecord(args) && typeof args.command === "string") {
    const command = args.command.trim().slice(0, 200);
    return command ? `bash: ${command}` : "bash";
  }
  if ((toolName === "read" || toolName === "edit" || toolName === "write") && isRecord(args)) {
    const file = typeof args.path === "string" ? args.path.trim() : "";
    if (file) return `${toolName} ${file.slice(-120)}`;
  }
  return toolName || "tool";
}

function extractAssistantText(message: unknown): string {
  if (!isRecord(message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .join("");
}

function usageFromAgentEnd(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined;
  let lastUsage: Record<string, unknown> | undefined;
  for (const entry of messages) {
    if (!isRecord(entry)) continue;
    const usage = (entry as { usage?: unknown }).usage;
    if (isRecord(usage)) lastUsage = usage as Record<string, unknown>;
  }
  return lastUsage;
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
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

    const sessions = new Map<ThreadId, PiSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
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
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        const id = yield* randomUUIDv4;
        yield* nativeEventLogger
          .write(
            {
              observedAt,
              event: {
                id,
                kind: "notification",
                provider: PROVIDER,
                createdAt: observedAt,
                method,
                threadId,
                payload,
              },
            },
            threadId,
          )
          .pipe(Effect.ignore);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Pi notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
        Effect.ignore,
      );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const settleTurn = (
      ctx: PiSessionContext,
      turnId: TurnId,
      outcome: {
        state: "completed" | "failed" | "cancelled";
        errorMessage?: string;
        stopReason?: string | null;
      },
    ) =>
      Effect.gen(function* () {
        if (ctx.turnSettled || ctx.activeTurnId !== turnId) return;
        ctx.turnSettled = true;
        ctx.activeTurnId = undefined;
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.session = { ...readySession, status: "ready", updatedAt };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: outcome.state,
            ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
            ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
          },
          raw: { source: "pi.rpc", method: "agent_end", payload: { turnId } },
        });
      });

    const emitTokenUsage = (ctx: PiSessionContext, turnId: TurnId | undefined, usage: unknown) =>
      Effect.gen(function* () {
        if (!isRecord(usage)) return;
        const input = typeof usage.input === "number" ? Math.max(0, Math.floor(usage.input)) : 0;
        const output = typeof usage.output === "number" ? Math.max(0, Math.floor(usage.output)) : 0;
        const cacheRead =
          typeof usage.cacheRead === "number"
            ? Math.max(0, Math.floor(usage.cacheRead))
            : undefined;
        const cacheWrite =
          typeof usage.cacheWrite === "number"
            ? Math.max(0, Math.floor(usage.cacheWrite))
            : undefined;
        const total =
          typeof usage.totalTokens === "number"
            ? Math.max(0, Math.floor(usage.totalTokens))
            : input + output;
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          ...(turnId ? { turnId } : {}),
          payload: {
            usage: {
              usedTokens: total,
              ...(cacheRead !== undefined ? { cachedInputTokens: cacheRead } : {}),
              ...(cacheWrite !== undefined ? {} : {}),
              inputTokens: input,
              outputTokens: output,
            },
          },
          raw: { source: "pi.rpc", method: "agent_end", payload: usage },
        });
      }).pipe(Effect.ignore);

    const answerExtensionDialog = (
      ctx: PiSessionContext,
      request: PiRpcEvent,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const id = asString((request as Record<string, unknown>).id);
        const method = asString((request as Record<string, unknown>).method);
        if (!id || !method) return;
        const payload = request as Record<string, unknown>;
        yield* logNative(ctx.threadId, `extension_ui/${method}`, payload);
        if (method === "notify") {
          const message = asString(payload.message) ?? "Pi notification";
          const notifyType = asString(payload.notifyType) ?? "info";
          if (notifyType === "warning" || notifyType === "error") {
            yield* offerRuntimeEvent({
              type: "runtime.warning",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              payload: { message },
              raw: { source: "pi.rpc", method: "extension_ui_request", payload: request },
            });
          }
          return;
        }
        if (
          method === "setStatus" ||
          method === "setWidget" ||
          method === "setTitle" ||
          method === "set_editor_text"
        ) {
          return;
        }
        // Dialog methods: select / confirm / input / editor.
        const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
        const runtimeRequestId = RuntimeRequestId.make(requestId);
        const resolution = yield* Deferred.make<PendingUserInputResolution>();
        const turnId = ctx.activeTurnId;
        if (method === "confirm") {
          const title = asString(payload.title) ?? "Confirm";
          const message = asString(payload.message) ?? "";
          ctx.pendingUserInputs.set(requestId, { resolution, questionIds: ["confirm"] });
          yield* offerRuntimeEvent({
            type: "user-input.requested",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId,
            requestId: runtimeRequestId,
            payload: {
              questions: [
                {
                  id: "confirm",
                  header: title.slice(0, 200),
                  question: (message || title).slice(0, 2000),
                  options: [
                    { label: "Confirm", description: "" },
                    { label: "Cancel", description: "" },
                  ],
                },
              ],
            },
            raw: { source: "pi.rpc", method: "extension_ui_request", payload: request },
          });
          const resolved = yield* Deferred.await(resolution);
          ctx.pendingUserInputs.delete(requestId);
          const confirmed =
            resolved._tag === "answered" && resolved.answers["confirm"] === "Confirm";
          yield* offerRuntimeEvent({
            type: "user-input.resolved",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId,
            requestId: runtimeRequestId,
            payload: { answers: resolved._tag === "answered" ? resolved.answers : {} },
          });
          yield* ctx.rpc
            .notify(
              resolved._tag === "cancelled"
                ? { type: "extension_ui_response", id, cancelled: true }
                : { type: "extension_ui_response", id, confirmed },
            )
            .pipe(Effect.ignore);
          return;
        }
        // select / input / editor → single-question user input.
        const title = asString(payload.title) ?? method;
        const options = Array.isArray(payload.options)
          ? (payload.options as unknown[]).flatMap((entry) =>
              typeof entry === "string" && entry.trim()
                ? [{ label: entry.trim(), description: "" }]
                : [],
            )
          : [];
        const questionText = asString(payload.message) ?? asString(payload.prefill) ?? title;
        const questionId = "value";
        ctx.pendingUserInputs.set(requestId, { resolution, questionIds: [questionId] });
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: {
            questions: [
              {
                id: questionId,
                header: title.slice(0, 200),
                question: questionText.slice(0, 2000),
                options,
              },
            ],
          },
          raw: { source: "pi.rpc", method: "extension_ui_request", payload: request },
        });
        const resolved = yield* Deferred.await(resolution);
        ctx.pendingUserInputs.delete(requestId);
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          requestId: runtimeRequestId,
          payload: { answers: resolved._tag === "answered" ? resolved.answers : {} },
        });
        if (resolved._tag === "cancelled") {
          yield* ctx.rpc
            .notify({ type: "extension_ui_response", id, cancelled: true })
            .pipe(Effect.ignore);
        } else {
          const value = resolved.answers[questionId];
          yield* ctx.rpc
            .notify({
              type: "extension_ui_response",
              id,
              value: typeof value === "string" ? value : "",
            })
            .pipe(Effect.ignore);
        }
      });

    const handleRpcEvent = (
      ctx: PiSessionContext,
      event: PiRpcEvent,
    ): Effect.Effect<void, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        yield* logNative(ctx.threadId, event.type, event);
        const turnId = ctx.activeTurnId;
        switch (event.type) {
          case "message_update": {
            if (!turnId || ctx.turnSettled) return;
            const delta = (event as Record<string, unknown>).assistantMessageEvent;
            if (!isRecord(delta)) return;
            const kind = asString(delta.type);
            if (kind === "text_delta" && typeof delta.delta === "string" && delta.delta) {
              yield* offerRuntimeEvent({
                type: "content.delta",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: ctx.threadId,
                turnId,
                payload: { streamKind: "assistant_text", delta: delta.delta },
                raw: { source: "pi.rpc", method: "message_update", payload: event },
              });
            } else if (
              kind === "thinking_delta" &&
              typeof delta.delta === "string" &&
              delta.delta
            ) {
              yield* offerRuntimeEvent({
                type: "content.delta",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: ctx.threadId,
                turnId,
                payload: { streamKind: "reasoning_text", delta: delta.delta },
                raw: { source: "pi.rpc", method: "message_update", payload: event },
              });
            } else if (kind === "error") {
              const reason = asString(delta.reason) ?? "error";
              yield* settleTurn(ctx, turnId, {
                state: reason === "aborted" ? "cancelled" : "failed",
                errorMessage: asString(delta.error) ?? `Pi turn failed (${reason}).`,
                stopReason: reason,
              });
            }
            return;
          }
          case "tool_execution_start": {
            if (!turnId || ctx.turnSettled) return;
            const toolCallId =
              asString(event.toolCallId) ?? asString((event as Record<string, unknown>).toolcallId);
            const toolName = asString(event.toolName) ?? "tool";
            const args = (event as Record<string, unknown>).args;
            yield* offerRuntimeEvent({
              type: "item.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              turnId,
              ...(toolCallId ? { itemId: RuntimeItemId.make(toolCallId) } : {}),
              payload: {
                itemType: piToolToItemType(toolName),
                status: "inProgress",
                title: toolTitle(toolName, args).slice(0, 300),
                ...(isRecord(args) && Object.keys(args).length > 0
                  ? { data: { toolName, args } }
                  : { data: { toolName } }),
              },
              raw: { source: "pi.rpc", method: "tool_execution_start", payload: event },
            });
            return;
          }
          case "tool_execution_update": {
            if (!turnId || ctx.turnSettled) return;
            const toolCallId = asString(event.toolCallId);
            const toolName = asString(event.toolName) ?? "tool";
            yield* offerRuntimeEvent({
              type: "item.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              turnId,
              ...(toolCallId ? { itemId: RuntimeItemId.make(toolCallId) } : {}),
              payload: {
                itemType: piToolToItemType(toolName),
                status: "inProgress",
                title: toolTitle(toolName, (event as Record<string, unknown>).args).slice(0, 300),
              },
              raw: { source: "pi.rpc", method: "tool_execution_update", payload: event },
            });
            return;
          }
          case "tool_execution_end": {
            if (!turnId || ctx.turnSettled) return;
            const toolCallId = asString(event.toolCallId);
            const toolName = asString(event.toolName) ?? "tool";
            const isError = (event as Record<string, unknown>).isError === true;
            yield* offerRuntimeEvent({
              type: "item.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: ctx.threadId,
              turnId,
              ...(toolCallId ? { itemId: RuntimeItemId.make(toolCallId) } : {}),
              payload: {
                itemType: piToolToItemType(toolName),
                status: isError ? "failed" : "completed",
                title: toolTitle(toolName, (event as Record<string, unknown>).args).slice(0, 300),
              },
              raw: { source: "pi.rpc", method: "tool_execution_end", payload: event },
            });
            return;
          }
          case "agent_end": {
            if (!turnId || ctx.turnSettled) {
              const usage = usageFromAgentEnd((event as Record<string, unknown>).messages);
              if (usage) yield* emitTokenUsage(ctx, turnId, usage);
              return;
            }
            const messages = (event as Record<string, unknown>).messages;
            const usage = usageFromAgentEnd(messages);
            if (usage) yield* emitTokenUsage(ctx, turnId, usage);
            const wasInterrupted = ctx.interruptedTurnIds.has(turnId);
            if (wasInterrupted) ctx.interruptedTurnIds.delete(turnId);
            ctx.turns = [...ctx.turns, { id: turnId, items: [{ messages }] }];
            yield* settleTurn(ctx, turnId, {
              state: wasInterrupted ? "cancelled" : "completed",
              stopReason: wasInterrupted ? "cancelled" : "stop",
            });
            return;
          }
          case "extension_ui_request": {
            yield* answerExtensionDialog(ctx, event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Pi extension UI request failed.", { cause }),
              ),
            );
            return;
          }
          case "pi_process_exited": {
            if (turnId && !ctx.turnSettled) {
              yield* settleTurn(ctx, turnId, {
                state: "failed",
                errorMessage: "Pi exited before the turn completed.",
              });
            }
            return;
          }
          default:
            return;
        }
      });

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        for (const pending of ctx.pendingUserInputs.values()) {
          yield* Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore);
        }
        ctx.pendingUserInputs.clear();
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber).pipe(Effect.ignore);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: PiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const settings = options?.resolveSettings ? yield* options.resolveSettings : piSettings;
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
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const parsedSlug = parsePiModelSlug(modelSelection?.model);
          const requestedThinking = normalizePiThinkingLevel(
            getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"),
          );
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          const resume = parsePiResume(input.resumeCursor);
          const processEnv = options?.environment ?? process.env;
          const displayModel = modelSelection?.model?.trim() || PI_DEFAULT_MODEL_SLUG;
          const runtimeInstructions = buildRuntimeInstructions({
            harness: PI_RUNTIME_HARNESS,
            ...(displayModel !== PI_DEFAULT_MODEL_SLUG ? { model: displayModel } : {}),
            ...(requestedThinking ? { reasoningEffort: requestedThinking } : {}),
          });
          const rpc = yield* makePiRpcRuntime({
            binaryPath: settings.binaryPath || "pi",
            cwd,
            environment: processEnv,
            ...(parsedSlug.provider ? { provider: parsedSlug.provider } : {}),
            ...(parsedSlug.modelId ? { modelId: parsedSlug.modelId } : {}),
            ...(requestedThinking
              ? { thinkingLevel: requestedThinking satisfies PiThinkingLevel }
              : {}),
            appendSystemPrompts: [runtimeInstructions],
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to start Pi RPC session.",
                  cause,
                }),
            ),
          );
          if (resume?.sessionFile) {
            yield* rpc
              .send({ type: "switch_session", sessionPath: resume.sessionFile })
              .pipe(Effect.ignore);
          } else {
            yield* rpc.newSession().pipe(Effect.ignore);
          }
          if (parsedSlug.provider || parsedSlug.modelId) {
            yield* rpc.setModel(parsedSlug.provider, parsedSlug.modelId).pipe(Effect.ignore);
          }
          if (requestedThinking) {
            yield* rpc.setThinkingLevel(requestedThinking).pipe(Effect.ignore);
          }
          const state = yield* rpc
            .getState()
            .pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));
          const stateModel = isRecord(state.model) ? state.model : {};
          const currentProvider = asString(stateModel.provider);
          const currentModelId = asString(stateModel.id);
          const sessionFile = asString(state.sessionFile);
          const sessionId = asString(state.sessionId);
          const skillNames = yield* discoverPiSkills(processEnv, cwd).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.map((skills) => new Set(skills.map((skill) => skill.name))),
            Effect.orElseSucceed(() => new Set<string>()),
          );
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: displayModel,
            threadId: input.threadId,
            resumeCursor: buildPiResumeCursor({
              ...(sessionFile ? { sessionFile } : {}),
              ...(sessionId ? { sessionId } : {}),
            }),
            createdAt: now,
            updatedAt: now,
          };
          const ctx: PiSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            rpc,
            notificationFiber: undefined,
            pendingUserInputs: new Map(),
            turns: [],
            activeTurnId: undefined,
            turnSettled: true,
            interruptedTurnIds: new Set(),
            skillNames,
            currentProvider,
            currentModelId,
            stopped: false,
          };
          // Fork into the session scope, not the calling fiber. `forkScoped`
          // would make this a child of `startSession`, and Effect interrupts
          // a fiber's children when it completes, so the consumer would die
          // as soon as `startSession` returned and every later notification
          // would be dropped.
          const fiber = yield* rpc.events.pipe(
            Stream.runForEach((event) =>
              handleRpcEvent(ctx, event).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Pi RPC event handling failed.", { cause }),
                ),
              ),
            ),
            Effect.forkIn(sessionScope),
          );
          ctx.notificationFiber = fiber;
          sessionScopeTransferred = true;
          sessions.set(input.threadId, ctx);
          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            payload: {},
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const rawInput =
            input.continuation === true ? (input.input?.trim() ?? "") : (input.input?.trim() ?? "");
          if (!rawInput && input.continuation !== true) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "input is required and must be non-empty.",
            });
          }
          const message = !rawInput && input.continuation === true ? "Continue." : rawInput;
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          if (modelSelection?.model) {
            const parsed = parsePiModelSlug(modelSelection.model);
            const thinking = normalizePiThinkingLevel(
              getModelSelectionStringOptionValue(modelSelection, "reasoningEffort"),
            );
            if (parsed.provider !== ctx.currentProvider || parsed.modelId !== ctx.currentModelId) {
              const result = yield* ctx.rpc
                .setModel(parsed.provider, parsed.modelId)
                .pipe(Effect.exit);
              if (Exit.isFailure(result)) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/set_model",
                  detail: "Pi could not switch model for this turn.",
                  cause: result.cause,
                });
              }
              ctx.currentProvider = parsed.provider ?? ctx.currentProvider;
              ctx.currentModelId = parsed.modelId ?? ctx.currentModelId;
            }
            if (thinking) {
              yield* ctx.rpc.setThinkingLevel(thinking).pipe(Effect.ignore);
            }
          }
          let promptText = message;
          if (hasPiSkillMention(promptText)) {
            promptText = rewritePiSkillMentions(promptText, ctx.skillNames);
          }
          const images: Array<{ data: string; mimeType: string }> = [];
          if (input.attachments && input.attachments.length > 0) {
            const mentions: string[] = [];
            for (const attachment of input.attachments) {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              if (attachment.type === "image") {
                const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Failed to read image attachment '${attachment.name}'.`,
                        cause,
                      }),
                  ),
                );
                images.push({
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType: attachment.mimeType,
                });
              } else {
                mentions.push(`@${attachmentPath}`);
              }
            }
            if (mentions.length > 0) {
              promptText = `${promptText}\n\n${mentions.join("\n")}`;
            }
          }
          if (ctx.activeTurnId && !ctx.turnSettled) {
            // A turn is already streaming: steer it instead of opening a new one.
            yield* ctx.rpc.send({ type: "steer", message: promptText }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/steer",
                    detail: "Pi could not steer the running turn.",
                    cause,
                  }),
              ),
            );
            return {
              threadId: input.threadId,
              turnId: ctx.activeTurnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }
          const turnId = TurnId.make(yield* randomUUIDv4);
          ctx.activeTurnId = turnId;
          ctx.turnSettled = false;
          const selectedModel = modelSelection?.model;
          ctx.session = {
            ...ctx.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            ...(selectedModel ? { model: selectedModel } : {}),
          };
          const turnStartedPayload = selectedModel ? { model: selectedModel } : {};
          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: turnStartedPayload,
            raw: { source: "pi.rpc", method: "prompt", payload: { turnId } },
          });
          const accepted = yield* ctx.rpc.prompt(promptText, images).pipe(Effect.exit);
          if (Exit.isFailure(accepted)) {
            const detail = `Pi could not accept the turn prompt.`;
            yield* settleTurn(ctx, turnId, { state: "failed", errorMessage: detail });
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail,
              cause: accepted.cause,
            });
          }
          const response = accepted.value;
          if (!response.success) {
            const errorMessage = response.error?.trim() || "Pi rejected the turn prompt.";
            yield* settleTurn(ctx, turnId, { state: "failed", errorMessage });
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: errorMessage,
            });
          }
          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }),
      );

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const target = turnId ?? ctx.activeTurnId;
          if (!target || ctx.turnSettled || ctx.activeTurnId !== target) return;
          ctx.interruptedTurnIds.add(target);
          yield* ctx.rpc.abort().pipe(Effect.ignore);
          yield* offerRuntimeEvent({
            type: "turn.aborted",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId,
            turnId: target,
            payload: { reason: "Interrupted by user." },
          });
        }),
      );

    // Pi tools run without approval gates; nothing to resolve.
    const respondToRequest: PiAdapterShape["respondToRequest"] = (
      threadId,
      _requestId,
      _decision,
    ) => withThreadLock(threadId, requireSession(threadId).pipe(Effect.asVoid));

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.pendingUserInputs.get(requestId);
          if (!pending) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "user-input/respond",
              detail: `Unknown user-input request '${requestId}'.`,
            });
          }
          yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
        }),
      );

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) return;
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.succeed(
        [...sessions.values()].filter((ctx) => !ctx.stopped).map((ctx) => ctx.session),
      );

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.succeed(sessions.has(threadId) && !sessions.get(threadId)?.stopped);

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })) };
      });

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/rollback",
          detail: "Pi does not support native conversation rollback.",
        });
      });

    const compactThread = (threadId: ThreadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* ctx.rpc.compact().pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/compact",
                  detail: "Pi could not compact the thread.",
                  cause,
                }),
            ),
          );
        }),
      );

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        for (const ctx of sessions.values()) {
          yield* stopSessionInternal(ctx).pipe(Effect.ignore);
        }
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      startSession,
      sendTurn,
      compaction: { type: "native", start: compactThread },
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies PiAdapterShape;
  });
}

export function slugForPiTestExports() {
  return {
    PROVIDER,
    piToolToItemType,
    toolTitle,
    extractAssistantText,
    buildPiModelSlug,
    parsePiModelSlug,
    PI_DEFAULT_MODEL_SLUG,
  };
}
