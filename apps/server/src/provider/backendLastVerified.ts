import type { IsoDateTime, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class BackendLastVerified extends Context.Service<
  BackendLastVerified,
  {
    /**
     * Record an executed turn for one instance. Callers must invoke this
     * only after a turn demonstrably ran (adapter success) — never for
     * intent, retries that never executed, or background probes.
     */
    readonly record: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
    /**
     * Merge the recorded timestamp into a snapshot, like `withUsageLimits`.
     * Snapshots without a record pass through untouched (absent marker =
     * never verified), as do synthetic `unavailable` shadows.
     */
    readonly stamp: (snapshot: ServerProvider) => Effect.Effect<ServerProvider>;
  }
>()("t3/provider/backendLastVerified") {}

/**
 * Process-local verification timestamps, keyed by provider instance.
 *
 * Volatile by construction (an in-memory table, forgotten on restart — the
 * same trade as the combo last-known-good table in `ProviderService`): a
 * persisted marker would claim a verification this process never observed.
 * No file cache either: the status cache persists per-instance probe state
 * across restarts at the wrong granularity for this signal — a cached
 * timestamp would read as "just verified" after a restart without any turn
 * having run, so `writeProviderStatusCache` strips the field and hydration
 * never resurrects it.
 *
 * There is deliberately no polling or auto-probe: writes happen only via
 * `record` from successful `sendTurn` paths, reads only when the registry
 * publishes snapshots.
 */
export const layer = Layer.effect(
  BackendLastVerified,
  Effect.gen(function* () {
    const table = yield* Ref.make(new Map<ProviderInstanceId, IsoDateTime>());
    return BackendLastVerified.of({
      record: (instanceId) =>
        Effect.gen(function* () {
          const verifiedAt = DateTime.formatIso(yield* DateTime.now);
          yield* Ref.update(table, (previous) => new Map(previous).set(instanceId, verifiedAt));
        }),
      stamp: (snapshot) =>
        Effect.gen(function* () {
          if (snapshot.availability === "unavailable") {
            return snapshot;
          }
          const verifiedAt = (yield* Ref.get(table)).get(snapshot.instanceId);
          if (verifiedAt === undefined || snapshot.backendLastVerifiedAt === verifiedAt) {
            return snapshot;
          }
          return { ...snapshot, backendLastVerifiedAt: verifiedAt };
        }),
    });
  }),
);
