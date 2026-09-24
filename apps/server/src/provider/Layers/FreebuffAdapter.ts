/**
 * FreebuffAdapter — Freebuff free-mode HTTP adapter.
 *
 * No local binary: session admission plus OpenAI-compatible chat SSE
 * against codebuff.com. Conversation history is kept client-side per
 * thread because Freebuff has no resume endpoint for the chat stream.
 *
 * @module provider/Layers/FreebuffAdapter
 */
import {
  ApprovalRequestId,
  type FreebuffSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { makeEventStamper } from "../acp/AcpAdapterScaffold.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  freebuffChatCompletion,
  resolveFreebuffAuthToken,
  resolveFreebuffModel,
  requestFreebuffSessionAdmission,
  type FreebuffSessionAdmission,
} from "../freebuff/FreebuffRuntime.ts";
import type { FreebuffAdapterShape } from "../Services/FreebuffAdapter.ts";

const PROVIDER = ProviderDriverKind.make("freebuff");
const FREEBUFF_RESUME_VERSION = 1 as const;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1_000;

interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

interface FreebuffSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly messages: Array<ChatMessage>;
  readonly admission: FreebuffSessionAdmission;
  readonly instanceId: string;
  activeTurnId: TurnId | undefined;
  readonly interruptedTurnIds: Set<TurnId>;
  stopped: boolean;
  currentModel: string;
}

export interface FreebuffAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly turnTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFreebuffResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== FREEBUFF_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

export function makeFreebuffAdapter(
  freebuffSettings: FreebuffSettings,
  options?: FreebuffAdapterOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("freebuff");
    const turnTimeoutMs =
      typeof options?.turnTimeoutMs === "number" && Number.isFinite(options.turnTimeoutMs)
        ? Math.max(1, Math.floor(options.turnTimeoutMs))
        : DEFAULT_TURN_TIMEOUT_MS;
    const fileSystem = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const path = yield* Path.Path;

    const provideRuntimeServices = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem | HttpClient.HttpClient>,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

    const sessions = new Map<ThreadId, FreebuffSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const stamper = yield* makeEventStamper({
      provider: PROVIDER,
      detail: "Failed to generate Freebuff runtime identifier.",
    });
    const nowIso = stamper.nowIso;
    const makeEventStamp = stamper.makeEventStamp;

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const requireSession = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
              cause: "No active Freebuff session for this thread.",
            }),
          );
        }
        return Effect.succeed(ctx);
      });

    const chatOptions = {
      settings: freebuffSettings,
      environment: process.env,
      fileSystem,
    };

    const stopSessionInternal = (ctx: FreebuffSessionContext) =>
      Effect.sync(() => {
        if (ctx.stopped) return;
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
      });

    const startSession: FreebuffAdapterShape["startSession"] = (input) =>
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
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const modelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = resolveFreebuffModel(modelSelection);
        const instanceId = `t3-${boundInstanceId}`;
        const token = yield* provideRuntimeServices(
          resolveFreebuffAuthToken(freebuffSettings, process.env),
        );
        if (!token) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/admission",
            detail:
              "Freebuff is not authenticated. Set an auth token in Settings or run `freebuff login`.",
          });
        }

        const admission = yield* provideRuntimeServices(
          requestFreebuffSessionAdmission({
            ...chatOptions,
            model,
            instanceId,
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/admission",
                detail: cause.message,
                cause,
              }),
          ),
        );

        if (admission.state === "banned" || admission.state === "country_blocked") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/admission",
            detail: `Freebuff session admission returned state '${admission.state}'.`,
          });
        }

        const now = yield* nowIso;
        const resumeSessionId = parseFreebuffResume(input.resumeCursor)?.sessionId;
        const resumeCursor = {
          schemaVersion: FREEBUFF_RESUME_VERSION,
          sessionId: admission.sessionId ?? resumeSessionId ?? instanceId,
        };
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          model,
          threadId: input.threadId,
          resumeCursor,
          createdAt: now,
          updatedAt: now,
        };

        const ctx: FreebuffSessionContext = {
          threadId: input.threadId,
          session,
          messages: [],
          admission,
          instanceId,
          activeTurnId: undefined,
          interruptedTurnIds: new Set(),
          stopped: false,
          currentModel: model,
        };
        sessions.set(input.threadId, ctx);

        yield* offerRuntimeEvent({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { resume: admission.sessionId ?? instanceId },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { providerThreadId: admission.sessionId ?? instanceId },
        });

        return session;
      });

    const sendTurn: FreebuffAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(yield* stamper.randomUUIDv4);
        const itemId = yield* stamper.randomUUIDv4;

        const turnModelSelection =
          input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
        const model = turnModelSelection?.model?.trim() || ctx.currentModel;
        ctx.currentModel = model;
        ctx.activeTurnId = turnId;
        ctx.session = {
          ...ctx.session,
          activeTurnId: turnId,
          model,
          updatedAt: yield* nowIso,
        };

        const prompt = input.input?.trim() ?? "";
        if (!prompt && (input.attachments?.length ?? 0) === 0) {
          ctx.activeTurnId = undefined;
          ctx.interruptedTurnIds.delete(turnId);
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        if (ctx.interruptedTurnIds.has(turnId)) {
          ctx.interruptedTurnIds.delete(turnId);
          ctx.activeTurnId = undefined;
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat/completions",
            detail: "Freebuff turn was interrupted during preparation.",
          });
        }

        // Append the user message to the local history. Freebuff has no
        // server-side thread, so history rides on every request.
        ctx.messages.push({ role: "user", content: prompt });
        // Freebuff free-mode is a single-turn chat surface: prior assistant
        // turns are dropped so each request stays within the free-context
        // budget and the API sees only the current user message + system.
        const requestMessages: ChatMessage[] = [
          {
            role: "system",
            content: "You are a coding assistant running inside T3 Code via Freebuff free mode.",
          },
          { role: "user", content: prompt },
        ];

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: { model },
        });
        yield* offerRuntimeEvent(
          makeAcpAssistantItemEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            itemId,
            lifecycle: "item.started",
          }),
        );

        const result = yield* provideRuntimeServices(
          freebuffChatCompletion({
            ...chatOptions,
            model,
            messages: requestMessages,
            instanceId: ctx.instanceId,
            sessionId: ctx.admission.sessionId,
            stream: true,
          }),
        ).pipe(
          Effect.timeout(Duration.millis(turnTimeoutMs)),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "chat/completions",
                detail: cause.message,
                cause,
              }),
          ),
        );

        if (ctx.interruptedTurnIds.has(turnId)) {
          ctx.interruptedTurnIds.delete(turnId);
          ctx.activeTurnId = undefined;
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: input.threadId,
            turnId,
            payload: { state: "cancelled", stopReason: "cancelled" },
          });
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat/completions",
            detail: "Freebuff turn was interrupted.",
          });
        }

        if (result.text) {
          yield* offerRuntimeEvent(
            makeAcpContentDeltaEvent({
              stamp: yield* makeEventStamp(),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              itemId,
              text: result.text,
              rawPayload: { source: "freebuff.http", method: "chat/completions" },
            }),
          );
          ctx.messages.push({ role: "assistant", content: result.text });
        }

        yield* offerRuntimeEvent(
          makeAcpAssistantItemEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            itemId,
            lifecycle: "item.completed",
          }),
        );
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.done ? "completed" : "completed",
            stopReason: "stop",
          },
        });

        ctx.activeTurnId = undefined;
        ctx.session = {
          ...ctx.session,
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };

        const resumeCursor = ctx.session.resumeCursor;
        return {
          threadId: input.threadId,
          turnId,
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        };
      });

    const interruptTurn: FreebuffAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const interruptedTurnId = ctx.activeTurnId;
        if (interruptedTurnId !== undefined) {
          ctx.interruptedTurnIds.add(interruptedTurnId);
        }
      });

    const respondToRequest: FreebuffAdapterShape["respondToRequest"] = (
      _threadId,
      requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: `Freebuff does not emit approval requests (unknown request: ${requestId}).`,
        }),
      );

    const respondToUserInput: FreebuffAdapterShape["respondToUserInput"] = (
      _threadId,
      requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/user_input",
          detail: `Freebuff does not emit user-input requests (unknown request: ${requestId}).`,
        }),
      );

    const readThread: FreebuffAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.messages.map((message, index) => ({
            id: TurnId.make(`freebuff-${index}`),
            items: [message],
          })),
        };
      });

    const rollbackThread: FreebuffAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        // Freebuff history is flat user/assistant pairs; drop the last N user
        // turns (and their assistant replies) from local state.
        let toDrop = numTurns;
        while (toDrop > 0 && ctx.messages.length > 0) {
          // Drop trailing assistant then user for each turn.
          while (
            ctx.messages.length > 0 &&
            ctx.messages[ctx.messages.length - 1]?.role === "assistant"
          ) {
            ctx.messages.pop();
          }
          while (
            ctx.messages.length > 0 &&
            ctx.messages[ctx.messages.length - 1]?.role === "user"
          ) {
            ctx.messages.pop();
            toDrop -= 1;
            break;
          }
          if (ctx.messages.length > 0 && ctx.messages[ctx.messages.length - 1]?.role !== "user") {
            // No user message left to pair; clear remaining system noise.
            break;
          }
        }
        return {
          threadId,
          turns: ctx.messages.map((message, index) => ({
            id: TurnId.make(`freebuff-${index}`),
            items: [message],
          })),
        };
      });

    const stopSession: FreebuffAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      });

    const listSessions: FreebuffAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: FreebuffAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: FreebuffAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents,
    } satisfies FreebuffAdapterShape;
  });
}
