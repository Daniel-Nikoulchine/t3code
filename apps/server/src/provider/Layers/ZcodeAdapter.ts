/**
 * ZcodeAdapter — T3 provider adapter for the ZCode (Z.ai GLM harness) CLI.
 *
 * Each T3 thread owns one long-lived `zcode app-server` process (via
 * `ZcodeSessionRuntime`). Turns are `session/send` calls; completion is the
 * `v4/telemetry/event` `turn.terminal` notification, after which assistant
 * text is read back through `session/messages` and replayed as
 * `item.started` / `content.delta` / `item.completed` runtime events.
 *
 * Server-initiated `interaction/requestPermission` calls bridge into T3's
 * approval flow (`request.opened` / `request.resolved`); the stored ZCode
 * `optionId` answers the CLI. `interaction/requestUserInput` bridges into
 * `user-input.requested` / `user-input.resolved` the same way.
 *
 * Attachments travel as path reference lines inside the prompt text: the
 * app-server upload endpoints (`v4/attachment/*`) are desktop-oriented and
 * intentionally out of scope for the first revision.
 *
 * @module provider/Layers/ZcodeAdapter
 */
import {
  ApprovalRequestId,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type ZcodeSettings,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type ZcodeAdapterShape } from "../Services/ZcodeAdapter.ts";
import {
  defaultZcodePermissionOptionId,
  makeZcodeAppServer,
  type ZcodeAppServer,
  type ZcodeNotification,
} from "./ZcodeSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("zcode");
const ZCODE_RESUME_VERSION = 1 as const;
// Absolute backstop per turn. ZCode gives no progress deadline signal, so a
// lost terminal event must not leave the thread on "Working" forever.
const DEFAULT_ZCODE_TURN_TIMEOUT_MS = 30 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export interface ZcodeAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  /** Override the absolute per-turn deadline in focused tests. */
  readonly turnTimeoutMs?: number;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly options: ReadonlyArray<{ optionId: string; kind: string }>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

type ZcodeTurnOutcome =
  | { readonly _tag: "completed" }
  | { readonly _tag: "failed"; readonly errorMessage: string; readonly errorCode?: string }
  | { readonly _tag: "cancelled" };

interface ZcodeSessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  zcodeSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly server: ZcodeAppServer;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly seenMessageIds: Set<string>;
  activeTurnId: TurnId | undefined;
  turnWaiter: Deferred.Deferred<ZcodeTurnOutcome> | undefined;
  turnInterrupted: boolean;
  currentModelId: string | undefined;
  stopped: boolean;
}

export function parseZcodeResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw.schemaVersion !== ZCODE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) {
    return undefined;
  }
  return { sessionId: raw.sessionId.trim() };
}

/**
 * Map a T3 model slug onto a ZCode `{providerId, modelId}` ref. Bare slugs
 * address the built-in `zai` provider; `provider/model` slugs split
 * explicitly so custom endpoints keep working.
 */
export function resolveZcodeModelRef(model: string): { providerId: string; modelId: string } {
  const trimmed = model.trim();
  const separator = trimmed.indexOf("/");
  if (separator > 0 && separator < trimmed.length - 1) {
    return {
      providerId: trimmed.slice(0, separator),
      modelId: trimmed.slice(separator + 1),
    };
  }
  return { providerId: "zai", modelId: trimmed };
}

/** Map T3 runtime/interaction modes onto ZCode session modes. */
export function resolveZcodeMode(input: {
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode?: "default" | "plan" | undefined;
}): string {
  if (input.interactionMode === "plan") {
    return "plan";
  }
  switch (input.runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "edit";
    case "auto":
    case "approval-required":
      return "build";
  }
}

/**
 * Pick the ZCode permission `optionId` for a T3 approval decision, using the
 * option list the server sent with the request.
 */
export function selectZcodePermissionOptionId(
  options: ReadonlyArray<{ optionId: string; kind: string }>,
  decision: ProviderApprovalDecision,
): string {
  const byKind = (kind: string) => options.find((option) => option.kind === kind)?.optionId;
  const byId = (id: string) => options.find((option) => option.optionId === id)?.optionId;
  switch (decision) {
    case "accept":
      return (
        byKind("allow_once") ?? byId("allowOnce") ?? defaultZcodePermissionOptionId({ options })
      );
    case "acceptForSession":
    case "acceptAlways":
      return (
        byKind("allow_always") ??
        options.find((option) => option.optionId === "allow_project")?.optionId ??
        byId("allowAlways") ??
        byKind("allow_once") ??
        defaultZcodePermissionOptionId({ options })
      );
    case "decline":
    case "cancel":
      return byKind("deny") ?? byId("deny") ?? defaultZcodePermissionOptionId({ options });
  }
}

function canonicalRequestTypeForTool(toolName: string | undefined): CanonicalRequestType {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  if (normalized === "read") {
    return "file_read_approval";
  }
  if (normalized === "edit" || normalized === "write") {
    return "file_change_approval";
  }
  if (normalized === "bash") {
    return "exec_command_approval";
  }
  return "dynamic_tool_call";
}

function permissionDetailFromParams(params: unknown): string {
  if (!isRecord(params)) {
    return "ZCode requested permission.";
  }
  const reason = nonEmptyString(params.reason);
  if (reason) {
    return reason.slice(0, 2000);
  }
  const input = params.input;
  try {
    return JSON.stringify(input).slice(0, 2000) || "ZCode requested permission.";
  } catch {
    return "ZCode requested permission.";
  }
}

interface NormalizedUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
  readonly allowCustomAnswer: boolean;
}

/** Normalize ZCode user-input questions onto the T3 question shape. */
export function normalizeZcodeUserInputQuestions(params: unknown): NormalizedUserInputQuestion[] {
  const questions = isRecord(params) && Array.isArray(params.questions) ? params.questions : [];
  const normalized: NormalizedUserInputQuestion[] = [];
  questions.forEach((entry, index) => {
    if (!isRecord(entry)) {
      return;
    }
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option): NormalizedUserInputQuestion["options"] => {
          if (!isRecord(option)) {
            return [];
          }
          const label = nonEmptyString(option.label ?? option.title ?? option.value);
          if (!label) {
            return [];
          }
          return [
            {
              label,
              description: nonEmptyString(option.description) ?? "",
            },
          ];
        })
      : [];
    const questionText =
      nonEmptyString(entry.question) ?? nonEmptyString(entry.prompt) ?? nonEmptyString(entry.text);
    if (!questionText && options.length === 0) {
      return;
    }
    normalized.push({
      id: nonEmptyString(entry.id) ?? `question-${index + 1}`,
      header: nonEmptyString(entry.header ?? entry.title) ?? "ZCode question",
      question: questionText ?? "Choose an option.",
      options,
      multiSelect: entry.multiSelect === true,
      allowCustomAnswer: entry.allowCustomAnswer !== false,
    });
  });
  if (normalized.length === 0) {
    const prompt = isRecord(params) ? nonEmptyString(params.prompt) : undefined;
    normalized.push({
      id: "question-1",
      header: "ZCode question",
      question: prompt ?? "ZCode is waiting for input.",
      options: [],
      multiSelect: false,
      allowCustomAnswer: true,
    });
  }
  return normalized;
}

interface ZcodeAssistantMessage {
  readonly id: string;
  readonly textParts: ReadonlyArray<string>;
}

/** Extract unseen assistant text from a `session/messages` result. */
export function extractUnseenZcodeAssistantMessages(
  result: unknown,
  seenIds: ReadonlySet<string>,
): ZcodeAssistantMessage[] {
  const messages = isRecord(result) && Array.isArray(result.messages) ? result.messages : [];
  const unseen: ZcodeAssistantMessage[] = [];
  for (const entry of messages) {
    if (!isRecord(entry)) {
      continue;
    }
    const info = isRecord(entry.info) ? entry.info : undefined;
    if (info?.role !== "assistant") {
      continue;
    }
    const id =
      nonEmptyString(info.messageId) ??
      nonEmptyString(info.id) ??
      nonEmptyString((entry as Record<string, unknown>).messageId);
    if (!id || seenIds.has(id)) {
      continue;
    }
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    const textParts: string[] = [];
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      if (part.type !== "text") {
        continue;
      }
      const text = nonEmptyString(part.text);
      if (text) {
        textParts.push(text);
      }
    }
    if (textParts.length > 0) {
      unseen.push({ id, textParts });
    }
  }
  return unseen;
}

function turnTerminalOutcomeFromEvent(params: unknown): ZcodeTurnOutcome | undefined {
  if (!isRecord(params) || params.kind !== "turn.terminal") {
    return undefined;
  }
  const status = params.status;
  if (status === "completed") {
    return { _tag: "completed" };
  }
  if (status === "cancelled") {
    return { _tag: "cancelled" };
  }
  const errorMessage =
    nonEmptyString(params.errorMessage) ?? "ZCode turn failed without an error message.";
  const errorCode = nonEmptyString(params.errorCode);
  return {
    _tag: "failed",
    errorMessage,
    ...(errorCode ? { errorCode } : {}),
  };
}

export const makeZcodeAdapter = Effect.fn("makeZcodeAdapter")(function* (
  zcodeSettings: ZcodeSettings,
  options?: ZcodeAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("zcode");
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;

  const sessions = new Map<ThreadId, ZcodeSessionContext>();
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const requestedTimeoutMs = options?.turnTimeoutMs;
  const turnTimeoutMs =
    typeof requestedTimeoutMs === "number" && Number.isFinite(requestedTimeoutMs)
      ? Math.max(1, Math.floor(requestedTimeoutMs))
      : DEFAULT_ZCODE_TURN_TIMEOUT_MS;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate ZCode runtime identifier.",
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
      if (existing) {
        return Effect.succeed([existing, current] as const);
      }
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
  ): Effect.Effect<ZcodeSessionContext, ProviderAdapterSessionNotFoundError> => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(ctx);
  };

  const settlePendingApprovalsAsCancelled = (ctx: ZcodeSessionContext) =>
    Effect.forEach(
      Array.from(ctx.pendingApprovals.values()),
      (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
      { discard: true },
    );

  const settlePendingUserInputsAsCancelled = (ctx: ZcodeSessionContext) =>
    Effect.forEach(
      Array.from(ctx.pendingUserInputs.values()),
      (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
      { discard: true },
    );

  const stopSessionInternal = (ctx: ZcodeSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) {
        return;
      }
      ctx.stopped = true;
      if (ctx.turnWaiter && ctx.activeTurnId) {
        const waiter = ctx.turnWaiter;
        ctx.turnWaiter = undefined;
        yield* Deferred.succeed(waiter, { _tag: "cancelled" } as ZcodeTurnOutcome).pipe(
          Effect.ignore,
        );
      }
      yield* settlePendingApprovalsAsCancelled(ctx);
      yield* settlePendingUserInputsAsCancelled(ctx);
      if (ctx.notificationFiber) {
        yield* Fiber.interrupt(ctx.notificationFiber);
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

  const emitAssistantMessages = (
    ctx: ZcodeSessionContext,
    turnId: TurnId,
    messages: ReadonlyArray<ZcodeAssistantMessage>,
  ) =>
    Effect.gen(function* () {
      for (const message of messages) {
        const itemId = `${ctx.threadId}:${message.id}`;
        yield* offerRuntimeEvent({
          type: "item.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
        for (const text of message.textParts) {
          yield* offerRuntimeEvent({
            type: "content.delta",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId,
            itemId: RuntimeItemId.make(itemId),
            payload: { streamKind: "assistant_text", delta: text },
            raw: {
              source: "zcode.app-server.notification",
              method: "session/messages",
              payload: { messageId: message.id },
            },
          });
        }
        yield* offerRuntimeEvent({
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: { itemType: "assistant_message", status: "completed" },
        });
        ctx.seenMessageIds.add(message.id);
      }
    });

  const settleTurn = (ctx: ZcodeSessionContext, turnId: TurnId, outcome: ZcodeTurnOutcome) =>
    Effect.gen(function* () {
      if (ctx.activeTurnId !== turnId) {
        return;
      }
      ctx.activeTurnId = undefined;
      ctx.turnWaiter = undefined;
      const fetched = yield* ctx.server
        .request("session/messages", { sessionId: ctx.zcodeSessionId })
        .pipe(
          Effect.orElseSucceed(() => ({ messages: [] })),
          Effect.map((result) => result as unknown),
        );
      const unseen = extractUnseenZcodeAssistantMessages(fetched, ctx.seenMessageIds);
      if (unseen.length > 0) {
        yield* emitAssistantMessages(ctx, turnId, unseen);
      }
      const updatedAt = yield* nowIso;
      ctx.session = { ...ctx.session, status: "ready", updatedAt };
      switch (outcome._tag) {
        case "completed": {
          return yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId,
            payload: { state: "completed", stopReason: null },
          });
        }
        case "cancelled": {
          return yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId,
            payload: { state: "cancelled", stopReason: "cancelled" },
          });
        }
        case "failed": {
          return yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: ctx.threadId,
            turnId,
            payload: { state: "failed", errorMessage: outcome.errorMessage },
          });
        }
      }
    });

  // `v4/telemetry/event` `turn.terminal` is the canonical turn end: it
  // carries the final status plus the provider error detail. Companion
  // `computer-use/operation-event` rows are intentionally ignored so a
  // bare `turn-failed` can never shadow the detailed terminal payload.
  const consumeNotification = (ctx: ZcodeSessionContext, notification: ZcodeNotification) =>
    Effect.gen(function* () {
      if (notification.method !== "v4/telemetry/event" || !ctx.activeTurnId) {
        return;
      }
      const outcome = turnTerminalOutcomeFromEvent(notification.params);
      if (outcome && ctx.turnWaiter) {
        const waiter = ctx.turnWaiter;
        ctx.turnWaiter = undefined;
        yield* Deferred.succeed(waiter, outcome).pipe(Effect.ignore);
      }
    });

  const runNotificationLoop = (ctx: ZcodeSessionContext) =>
    ctx.server.notifications.pipe(
      Stream.runForEach((notification) =>
        sessions.get(ctx.threadId) === ctx && !ctx.stopped
          ? consumeNotification(ctx, notification)
          : Effect.void,
      ),
      Effect.ignore,
    );

  const serverRequest = (
    ctx: ZcodeSessionContext,
    method: string,
    params: unknown,
  ): Effect.Effect<unknown, ProviderAdapterRequestError | ProviderAdapterProcessError> =>
    ctx.server.request(method, params).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: cause.message,
            cause,
          }),
      ),
    );

  const startSession: ZcodeAdapterShape["startSession"] = (input) =>
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
        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;

        const boot = Effect.gen(function* () {
          const resumeSessionId = parseZcodeResume(input.resumeCursor)?.sessionId;
          const mode = resolveZcodeMode({
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
          });
          const requestedModel = modelSelection?.model?.trim() || undefined;

          const threadId = input.threadId;

          const server = yield* makeZcodeAppServer({
            command: zcodeSettings.binaryPath || "zcode",
            cwd,
            ...(options?.environment ? { environment: options.environment } : {}),
            handlers: {
              onPermissionRequest: (params) =>
                Effect.gen(function* () {
                  const approvalOptions =
                    isRecord(params) && Array.isArray(params.options)
                      ? params.options.flatMap((entry) => {
                          if (!isRecord(entry) || typeof entry.optionId !== "string") {
                            return [];
                          }
                          const kind = typeof entry.kind === "string" ? entry.kind : entry.optionId;
                          const decision =
                            kind === "deny"
                              ? ("decline" as const)
                              : kind === "allow_always" || entry.optionId === "allow_project"
                                ? ("acceptForSession" as const)
                                : ("accept" as const);
                          return [
                            {
                              decision,
                              label:
                                typeof entry.name === "string" && entry.name.trim()
                                  ? entry.name.trim().slice(0, 80)
                                  : decision,
                            },
                          ];
                        })
                      : [];
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const optionList =
                    isRecord(params) && Array.isArray(params.options)
                      ? params.options.flatMap((entry) =>
                          isRecord(entry) && typeof entry.optionId === "string"
                            ? [
                                {
                                  optionId: entry.optionId,
                                  kind:
                                    typeof entry.kind === "string" ? entry.kind : entry.optionId,
                                },
                              ]
                            : [],
                        )
                      : [];
                  const live = sessions.get(threadId);
                  const turnId = live?.activeTurnId;
                  pendingApprovals.set(requestId, { decision, options: optionList });
                  yield* offerRuntimeEvent({
                    type: "request.opened",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: {
                      requestType: canonicalRequestTypeForTool(
                        isRecord(params) ? nonEmptyString(params.toolName) : undefined,
                      ),
                      detail: permissionDetailFromParams(params),
                      args: isRecord(params) ? (params.input ?? params) : params,
                      ...(approvalOptions.length > 0 ? { options: approvalOptions } : {}),
                    },
                    raw: {
                      source: "zcode.app-server.request",
                      method: "interaction/requestPermission",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent({
                    type: "request.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: {
                      requestType: canonicalRequestTypeForTool(
                        isRecord(params) ? nonEmptyString(params.toolName) : undefined,
                      ),
                      decision: resolved,
                    },
                  });
                  return selectZcodePermissionOptionId(optionList, resolved);
                }),
              onUserInputRequest: (params) =>
                Effect.gen(function* () {
                  const questions = normalizeZcodeUserInputQuestions(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const resolution = yield* Deferred.make<PendingUserInputResolution>();
                  const live = sessions.get(threadId);
                  const turnId = live?.activeTurnId;
                  pendingUserInputs.set(requestId, { resolution });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: { questions },
                    raw: {
                      source: "zcode.app-server.request",
                      method: "interaction/requestUserInput",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(resolution);
                  pendingUserInputs.delete(requestId);
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    payload: {
                      answers: resolved._tag === "answered" ? resolved.answers : {},
                    },
                    raw: {
                      source: "zcode.app-server.request",
                      method: "interaction/requestUserInput",
                      payload: params,
                    },
                  });
                  if (resolved._tag === "cancelled") {
                    return { action: "decline" };
                  }
                  return { action: "accept", content: resolved.answers };
                }),
            },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const workspace = { workspaceKey: cwd, workspacePath: cwd };
          let zcodeSessionId: string | undefined;
          if (resumeSessionId) {
            const resumed = (yield* server
              .request("session/resume", { sessionId: resumeSessionId })
              .pipe(
                Effect.map((result) => ({ ok: true as const, result: result as unknown })),
                Effect.orElseSucceed(() => ({ ok: false as const, result: null })),
              )) as { ok: boolean; result: unknown };
            if (
              resumed.ok &&
              isRecord(resumed.result) &&
              isRecord(resumed.result.session) &&
              typeof resumed.result.session.sessionId === "string"
            ) {
              zcodeSessionId = resumed.result.session.sessionId;
            }
          }
          if (!zcodeSessionId) {
            const created = (yield* server
              .request("session/create", {
                workspace,
                mode,
                ...(requestedModel ? { model: resolveZcodeModelRef(requestedModel) } : {}),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: `Failed to create ZCode session: ${cause.message}`,
                      cause,
                    }),
                ),
              )) as unknown;
            if (!isRecord(created) || !isRecord(created.session)) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "ZCode session/create returned an unexpected payload.",
              });
            }
            const createdId = nonEmptyString(created.session.sessionId);
            if (!createdId) {
              return yield* new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "ZCode session/create returned no sessionId.",
              });
            }
            zcodeSessionId = createdId;
          }

          if (requestedModel) {
            const ref = resolveZcodeModelRef(requestedModel);
            yield* server
              .request("session/setModel", { sessionId: zcodeSessionId, model: ref })
              .pipe(Effect.ignore);
          }
          yield* server
            .request("session/setMode", { sessionId: zcodeSessionId, mode })
            .pipe(Effect.ignore);

          sessionScopeTransferred = true;
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(requestedModel ? { model: requestedModel } : {}),
            threadId: input.threadId,
            resumeCursor: { schemaVersion: ZCODE_RESUME_VERSION, sessionId: zcodeSessionId },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: ZcodeSessionContext = {
            threadId: input.threadId,
            cwd,
            zcodeSessionId,
            session,
            scope: sessionScope,
            server,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            seenMessageIds: new Set(),
            activeTurnId: undefined,
            turnWaiter: undefined,
            turnInterrupted: false,
            currentModelId: requestedModel,
            stopped: false,
          };
          sessions.set(input.threadId, ctx);
          ctx.notificationFiber = yield* runNotificationLoop(ctx).pipe(Effect.forkIn(sessionScope));
          return session;
        }).pipe(
          // Release the session scope when boot fails or is interrupted. On
          // success the scope outlives startSession (transferred above) and
          // closes with stopSession or the registry scope.
          Effect.ensuring(
            Effect.flatMap(
              Effect.sync(() => sessionScopeTransferred),
              (transferred) => (transferred ? Effect.void : Scope.close(sessionScope, Exit.void)),
            ),
          ),
        );
        return yield* boot;
      }),
    );

  const sendTurn: ZcodeAdapterShape["sendTurn"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (ctx.activeTurnId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/send",
            detail: "A ZCode turn is already running for this thread.",
          });
        }
        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const requestedTurnModel = turnModelSelection?.model?.trim() || undefined;
        if (requestedTurnModel && requestedTurnModel !== ctx.currentModelId) {
          const ref = resolveZcodeModelRef(requestedTurnModel);
          const setModelResult = yield* ctx.server
            .request("session/setModel", { sessionId: ctx.zcodeSessionId, model: ref })
            .pipe(Effect.exit);
          if (Exit.isFailure(setModelResult)) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/setModel",
              detail: "Failed to switch ZCode model for this turn.",
              cause: setModelResult.cause,
            });
          }
          ctx.currentModelId = requestedTurnModel;
        }

        const text = input.input?.trim() || "";
        const attachmentLines = (input.attachments ?? []).flatMap((attachment) => {
          const label = attachment.name?.trim() || attachment.id;
          return [`[attachment: ${label} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)]`];
        });
        const runtimeInstructions = buildRuntimeInstructions({
          harness: "ZCode",
          model: ctx.currentModelId,
        });
        const promptParts = [
          runtimeInstructions,
          ...(text ? [text] : []),
          ...attachmentLines,
        ].filter((part) => part.length > 0);
        const content =
          promptParts.length > 0
            ? promptParts.join("\n\n")
            : input.continuation === true
              ? "Continue where you left off."
              : "";
        if (!content) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const turnId = TurnId.make(yield* randomUUIDv4);
        ctx.activeTurnId = turnId;
        ctx.turnInterrupted = false;
        const waiter = yield* Deferred.make<ZcodeTurnOutcome>();
        ctx.turnWaiter = waiter;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          ...(ctx.currentModelId ? { model: ctx.currentModelId } : {}),
        };
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: ctx.currentModelId ? { model: ctx.currentModelId } : {},
        });

        const accepted = yield* ctx.server
          .request("session/send", {
            sessionId: ctx.zcodeSessionId,
            content,
            ...(input.modelSelection?.instanceId === boundInstanceId &&
            turnModelSelection?.model?.trim()
              ? { runtimeModel: resolveZcodeModelRef(turnModelSelection.model.trim()) }
              : {}),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/send",
                  detail: `Failed to send ZCode turn: ${cause.message}`,
                  cause,
                }),
            ),
            Effect.tapError((cause) =>
              Effect.gen(function* () {
                ctx.activeTurnId = undefined;
                ctx.turnWaiter = undefined;
                ctx.session = { ...ctx.session, status: "ready", updatedAt: yield* nowIso };
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: input.threadId,
                  turnId,
                  payload: { state: "failed", errorMessage: cause.detail },
                });
              }),
            ),
          );
        void accepted;

        const outcome = yield* Deferred.await(waiter).pipe(
          Effect.timeoutOption(Duration.millis(turnTimeoutMs)),
        );
        if (Option.isNone(outcome)) {
          ctx.turnWaiter = undefined;
          const timedOutTurnId = ctx.activeTurnId;
          yield* ctx.server
            .request("session/stop", { sessionId: ctx.zcodeSessionId })
            .pipe(Effect.ignore);
          if (timedOutTurnId) {
            yield* settleTurn(ctx, timedOutTurnId, {
              _tag: "failed",
              errorMessage: `ZCode turn timed out after ${turnTimeoutMs}ms without a terminal event.`,
            });
          }
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/send",
            detail: "ZCode turn timed out waiting for completion.",
          });
        }
        const settledOutcome = ctx.turnInterrupted
          ? ({ _tag: "cancelled" } as const)
          : outcome.value;
        yield* settleTurn(ctx, turnId, settledOutcome);
        if (settledOutcome._tag === "failed") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/send",
            detail: settledOutcome.errorMessage,
          });
        }
        return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
      }),
    );

  const interruptTurn: ZcodeAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      // Mark the interruption synchronously: sendTurn owns the thread lock
      // for the whole turn, so everything here must stay lock-free until
      // the turn settles, or interrupt would deadlock behind it.
      const observed = yield* Effect.sync(() => {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return { _tag: "None" as const };
        }
        const activeTurnId = ctx.activeTurnId;
        if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
          return { _tag: "Ignore" as const };
        }
        const targetTurnId = turnId ?? activeTurnId;
        if (targetTurnId !== undefined) {
          ctx.turnInterrupted = true;
        }
        return { _tag: "Stop" as const, ctx, targetTurnId };
      });
      if (observed._tag !== "Stop") {
        return;
      }
      // Unblock the approval/user-input gates so the UI clears immediately.
      yield* settlePendingApprovalsAsCancelled(observed.ctx);
      yield* settlePendingUserInputsAsCancelled(observed.ctx);
      // Ask the server to stop without holding the thread lock — concurrent
      // JSON-RPC requests are safe (responses route by id).
      yield* observed.ctx.server
        .request("session/stop", { sessionId: observed.ctx.zcodeSessionId })
        .pipe(Effect.ignore);
      yield* withThreadLock(
        threadId,
        Effect.gen(function* () {
          const live = sessions.get(threadId);
          if (!live || live !== observed.ctx) {
            return;
          }
          const target = observed.targetTurnId ?? live.activeTurnId;
          if (!target || live.activeTurnId !== target) {
            return;
          }
          const waiter = live.turnWaiter;
          live.turnWaiter = undefined;
          if (waiter) {
            yield* Deferred.succeed(waiter, { _tag: "cancelled" } as ZcodeTurnOutcome).pipe(
              Effect.ignore,
            );
          }
          yield* settleTurn(live, target, { _tag: "cancelled" });
        }),
      );
    });

  // NOTE: respond paths intentionally skip the thread lock. sendTurn owns the
  // lock for the whole turn while it waits on exactly these Deferreds — taking
  // the lock here would deadlock every approval round-trip.
  const respondToRequest: ZcodeAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "request/respond",
          detail: `Unknown pending approval request '${requestId}'.`,
        });
      }
      ctx.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending.decision, decision);
    });

  const respondToUserInput: ZcodeAdapterShape["respondToUserInput"] = (
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
          method: "user-input/respond",
          detail: `Unknown pending user-input request '${requestId}'.`,
        });
      }
      ctx.pendingUserInputs.delete(requestId);
      yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
    });

  const compactThread = (threadId: ThreadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* serverRequest(ctx, "session/compact", { sessionId: ctx.zcodeSessionId });
      }),
    );

  const readThread: ZcodeAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      return { threadId, turns: [] as Array<{ id: TurnId; items: Array<unknown> }> };
    });

  const rollbackThread: ZcodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: "ZCode app-server sessions do not support provider-side rollback yet.",
      });
    });

  const stopSession: ZcodeAdapterShape["stopSession"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* ctx.server
          .request("session/close", { sessionId: ctx.zcodeSessionId })
          .pipe(Effect.ignore);
        yield* stopSessionInternal(ctx);
      }),
    );

  const listSessions: ZcodeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

  const hasSession: ZcodeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const c = sessions.get(threadId);
      return c !== undefined && !c.stopped;
    });

  const stopAll: ZcodeAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

  yield* Effect.addFinalizer(() =>
    Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
  );

  const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    compaction: { type: "native", start: compactThread },
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
  } satisfies ZcodeAdapterShape;
});
