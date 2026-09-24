/**
 * AcpAdapterScaffold — the session/turn scaffold every ACP adapter repeats.
 *
 * Fourteen adapters each own an identical block: a per-thread lock registry,
 * event-stamp helpers, pending-approval settlement, session lookup, and
 * session teardown. The only per-adapter inputs are the provider tag and the
 * uuid-failure detail string; everything else is shared behavior that used
 * to be fixed N times (e.g. the lock-release comment in every
 * `stopSessionInternal` copy).
 *
 * Adapters keep their own session map (typed context) and event pubsub and
 * feed them into `requireScaffoldSession` / `stopScaffoldSession`. Turn
 * settlement, permission mapping, and content mapping stay in the adapters —
 * this module owns the lifecycle frame, not the protocol translation.
 *
 * Pure Effect, no layers involved.
 *
 * @module provider/acp/AcpAdapterScaffold
 */
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as EffectAcpErrors from "effect-acp/errors";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";

export interface ScaffoldPendingDecision {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

export interface ScaffoldPendingApproval extends ScaffoldPendingDecision {
  readonly kind: string | "unknown";
}

/**
 * Settle every pending approval as cancelled. Shared by session teardown and
 * turn interruption paths; each adapter used to carry this exact copy. Only
 * the decision is needed — adapters with richer approval shapes (a `kind`
 * tag, user-input resolutions) keep them; the scaffold reads the decision.
 */
export function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, ScaffoldPendingDecision>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

export interface ThreadLockRegistry {
  readonly withThreadLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /**
   * Drop the semaphore for a thread whose session is gone, so starting and
   * stopping sessions does not grow the registry for the adapter's lifetime.
   */
  readonly releaseThreadLock: (threadId: ThreadId) => Effect.Effect<void>;
}

/**
 * One semaphore per thread id, created on first use. Every ACP adapter used
 * to inline this registry; the lock discipline (one permit per thread) is
 * identical everywhere.
 */
export const makeThreadLockRegistry: Effect.Effect<ThreadLockRegistry> = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const getSemaphore = (threadId: string) =>
    SynchronizedRef.modifyEffect(ref, (current) => {
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
  return {
    withThreadLock: (threadId, effect) =>
      Effect.flatMap(getSemaphore(threadId), (semaphore) => semaphore.withPermit(effect)),
    releaseThreadLock: (threadId) =>
      SynchronizedRef.update(ref, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }),
  };
});

export interface EventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

export interface EventStamper {
  readonly nowIso: Effect.Effect<string>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError>;
  readonly nextEventId: Effect.Effect<EventId, ProviderAdapterRequestError>;
  readonly makeEventStamp: () => Effect.Effect<EventStamp, ProviderAdapterRequestError>;
}

/**
 * Fresh `eventId` + `createdAt` per call. The only per-adapter inputs are the
 * provider tag and the uuid-failure detail; adapters previously repeated the
 * whole block with a one-word difference in that string.
 */
export const makeEventStamper = (input: {
  readonly provider: ProviderDriverKind;
  readonly detail: string;
}): Effect.Effect<EventStamper, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: input.provider,
            method: "crypto/randomUUIDv4",
            detail: input.detail,
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    return {
      nowIso,
      randomUUIDv4,
      nextEventId,
      makeEventStamp: () => Effect.all({ eventId: nextEventId, createdAt: nowIso }),
    };
  });

/**
 * Bind an ACP extension/callback failure mapper for one harness: eleven
 * adapters repeated this plumbing with a one-word difference in `detail`.
 * Adapters keep a one-line alias under their established local name, so
 * existing call sites are untouched.
 */
export function makeExtensionFailureMapper(detail: string) {
  return <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, EffectAcpErrors.AcpTransportError, R> =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail,
            cause,
          }),
      ),
    );
}

/**
 * The session shape the shared teardown path needs. Adapter contexts carry
 * more (skill names, turns, model state); structural typing keeps those
 * intact while this slice is all the scaffold reads. Lookup needs even
 * less — just identity plus the stop flag.
 */
export interface ScaffoldLookupContext {
  readonly threadId: ThreadId;
  stopped: boolean;
}

export interface ScaffoldSessionContext extends ScaffoldLookupContext {
  readonly scope: Scope.Closeable;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: ReadonlyMap<ApprovalRequestId, ScaffoldPendingDecision>;
}

export function requireScaffoldSession<Ctx extends ScaffoldLookupContext>(
  sessions: ReadonlyMap<ThreadId, Ctx>,
  provider: ProviderDriverKind,
): (threadId: ThreadId) => Effect.Effect<Ctx, ProviderAdapterSessionNotFoundError> {
  return (threadId) => {
    const ctx = sessions.get(threadId);
    if (!ctx || ctx.stopped) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
    }
    return Effect.succeed(ctx);
  };
}

/**
 * Parse a versioned `{ schemaVersion, sessionId }` resume cursor. Six ACP
 * adapters carried this identical copy (only the version const differed);
 * single owner here. Returns the trimmed session id, `undefined` when the
 * payload is missing, malformed, or from another version.
 */
export function parseAcpResumeCursor(
  raw: unknown,
  version: number,
): { sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== version) return undefined;
  if (typeof record.sessionId !== "string" || !record.sessionId.trim()) return undefined;
  return { sessionId: record.sessionId.trim() };
}

/**
 * Shared session teardown: idempotent stop flag, approval settlement,
 * notification-fiber interrupt, scope close, map removal, lock release, and
 * the graceful `session.exited` event. Order matters (approvals settle before
 * the scope closes); adapters previously repeated it verbatim.
 */
export function stopScaffoldSession<E, Ctx extends ScaffoldSessionContext>(input: {
  readonly ctx: Ctx;
  readonly sessions: Map<ThreadId, Ctx>;
  readonly releaseThreadLock: (threadId: ThreadId) => Effect.Effect<void>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<EventStamp, E>;
  readonly provider: ProviderDriverKind;
}): Effect.Effect<void, E> {
  const { ctx, sessions, releaseThreadLock, offerRuntimeEvent, makeEventStamp, provider } = input;
  return Effect.gen(function* () {
    if (ctx.stopped) return;
    ctx.stopped = true;
    yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
    if (ctx.notificationFiber) {
      yield* Fiber.interrupt(ctx.notificationFiber);
    }
    yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
    sessions.delete(ctx.threadId);
    yield* releaseThreadLock(ctx.threadId);
    yield* offerRuntimeEvent({
      type: "session.exited",
      ...(yield* makeEventStamp()),
      provider,
      threadId: ctx.threadId,
      payload: { exitKind: "graceful" },
    });
  });
}
