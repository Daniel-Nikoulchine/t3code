// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect } from "vite-plus/test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import {
  ProviderDriverKind,
  ThreadId,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import {
  makeEventStamper,
  makeThreadLockRegistry,
  requireScaffoldSession,
  settlePendingApprovalsAsCancelled,
  stopScaffoldSession,
  type ScaffoldSessionContext,
} from "./AcpAdapterScaffold.ts";

const PROVIDER = ProviderDriverKind.make("droid");
const approvalId = (value: string) => value as unknown as ApprovalRequestId;

const testLayer = NodeServices.layer;

describe("AcpAdapterScaffold", () => {
  effectIt.layer(testLayer)("thread locks", (it) => {
    it.effect("serializes same-thread work in permit order", () =>
      Effect.gen(function* () {
        const locks = yield* makeThreadLockRegistry;
        const finished: Array<string> = [];
        const mark = (label: string) =>
          Effect.sync(() => {
            finished.push(label);
          });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const slow = locks.withThreadLock(
          "thread-a",
          Deferred.succeed(entered, undefined).pipe(
            Effect.flatMap(() => Deferred.await(release)),
            Effect.flatMap(() => mark("slow")),
          ),
        );
        const fast = locks.withThreadLock("thread-a", mark("fast"));
        const slowFiber = yield* Effect.forkScoped(slow);
        // Slow holds the permit before fast may proceed.
        yield* Deferred.await(entered);
        const fastFiber = yield* Effect.forkScoped(fast);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(slowFiber);
        yield* Fiber.join(fastFiber);
        expect(finished).toEqual(["slow", "fast"]);
      }),
    );
  });

  effectIt.layer(testLayer)("event stamps", (it) => {
    it.effect("mints a fresh event id per stamp", () =>
      Effect.gen(function* () {
        const stamper = yield* makeEventStamper({
          provider: PROVIDER,
          detail: "Failed to generate scaffold test identifier.",
        });
        const first = yield* stamper.makeEventStamp();
        const second = yield* stamper.makeEventStamp();
        expect(first.eventId).not.toBe(second.eventId);
        expect(typeof first.createdAt).toBe("string");
      }),
    );
  });

  effectIt.layer(testLayer)("session lifecycle", (it) => {
    it.effect("requires live sessions, settles approvals, and stops exactly once", () =>
      Effect.gen(function* () {
        const locks = yield* makeThreadLockRegistry;
        const stamper = yield* makeEventStamper({
          provider: PROVIDER,
          detail: "Failed to generate scaffold test identifier.",
        });
        const events: Array<ProviderRuntimeEvent> = [];
        const eventsRef = yield* Ref.make(events);
        const offer = (event: ProviderRuntimeEvent) =>
          Ref.update(eventsRef, (all) => [...all, event]);
        const threadId = ThreadId.make("scaffold-stop-once");
        const scope = yield* Scope.make();
        const scopeClosed = yield* Ref.make(false);
        yield* Scope.addFinalizer(scope, Ref.set(scopeClosed, true));
        const decision = yield* Deferred.make<ProviderApprovalDecision>();
        const sessions = new Map<ThreadId, ScaffoldSessionContext>();
        const ctx: ScaffoldSessionContext = {
          threadId,
          scope,
          notificationFiber: undefined,
          pendingApprovals: new Map([[approvalId("approval-1"), { decision, kind: "unknown" }]]),
          stopped: false,
        };
        sessions.set(threadId, ctx);

        const requireSession = requireScaffoldSession(sessions, PROVIDER);
        assert.isTrue((yield* requireSession(threadId)) === ctx);

        const stop = stopScaffoldSession({
          ctx,
          sessions,
          releaseThreadLock: locks.releaseThreadLock,
          offerRuntimeEvent: offer,
          makeEventStamp: stamper.makeEventStamp,
          provider: PROVIDER,
        });
        yield* stop;
        // Second stop is a no-op: no second event, no failure.
        yield* stop;

        expect(ctx.stopped).toBe(true);
        expect(sessions.has(threadId)).toBe(false);
        expect(yield* Ref.get(scopeClosed)).toBe(true);
        expect(yield* Deferred.isDone(decision)).toBe(true);
        expect(yield* Deferred.await(decision)).toBe("cancel");
        const allEvents = yield* Ref.get(eventsRef);
        const exited = allEvents.filter((event) => event.type === "session.exited");
        expect(exited).toHaveLength(1);
        expect(exited[0]?.threadId).toBe(threadId);

        const missing = yield* Effect.flip(requireSession(threadId));
        expect(missing._tag).toBe("ProviderAdapterSessionNotFoundError");
      }),
    );

    it.effect("settlePendingApprovalsAsCancelled completes every decision", () =>
      Effect.gen(function* () {
        const first = yield* Deferred.make<ProviderApprovalDecision>();
        const second = yield* Deferred.make<ProviderApprovalDecision>();
        yield* settlePendingApprovalsAsCancelled(
          new Map([
            [approvalId("a-1"), { decision: first, kind: "shell" }],
            [approvalId("a-2"), { decision: second, kind: "unknown" }],
          ]),
        );
        expect(yield* Deferred.await(first)).toBe("cancel");
        expect(yield* Deferred.await(second)).toBe("cancel");
      }),
    );
  });
});
