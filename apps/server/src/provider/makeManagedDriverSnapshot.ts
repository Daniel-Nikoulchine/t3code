/**
 * makeManagedDriverSnapshot — the managed snapshot block every provider
 * driver repeats.
 *
 * Thirteen drivers carried this identical ~35-line block: a settings source
 * from the effective config, `makeManagedServerProvider` with a stamped
 * initial snapshot, a prebuilt provider check, and an enrichment closure
 * that resolves maintenance and publishes through the standard
 * version-advisory enrich. The only per-driver inputs are the kind/instance
 * label, the effective config, the maintenance resolver, the initial/check
 * pieces, and the standard enrich function. Drivers keep building their own
 * `checkProvider` (per-harness status probes with identity stamping) and
 * pass it in.
 *
 * Deliberately NOT covered: Cursor (enrich needs settings + stampIdentity
 * with an unauthenticated early return), Codex/OpenCode (inline the advisory
 * without the warning-swallowing publish), and Antigravity/Freebuff (no
 * enrichment at all). Those three shapes stay explicit at their call sites.
 *
 * @module provider/makeManagedDriverSnapshot
 */
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import type { ServerSettingsService } from "../serverSettings.ts";
import { ProviderDriverError } from "./Errors.ts";
import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";
import type { EnrichSnapshotInput } from "./providerMaintenance.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "./providerUpdateSettings.ts";

export interface ManagedDriverSnapshotInput<Settings> {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  /** Human label for the driver-error text (`Failed to build <label> snapshot`). */
  readonly displayLabel: string;
  readonly effectiveConfig: Settings;
  readonly serverSettings: ServerSettingsService["Service"];
  readonly resolveMaintenance: ServerProviderShape["resolveMaintenance"];
  readonly buildInitialSnapshot: (provider: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly enrichSnapshot: (input: EnrichSnapshotInput) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}

export const makeManagedDriverSnapshot = Effect.fn("makeManagedDriverSnapshot")(function* <
  Settings,
>(input: ManagedDriverSnapshotInput<Settings>) {
  const snapshotSettings = makeProviderSnapshotSettingsSource(
    input.effectiveConfig,
    input.serverSettings,
  );
  return yield* makeManagedServerProvider<ProviderSnapshotSettings<Settings>>({
    resolveMaintenance: input.resolveMaintenance,
    getSettings: snapshotSettings.getSettings,
    streamSettings: snapshotSettings.streamSettings,
    haveSettingsChanged: haveProviderSnapshotSettingsChanged,
    initialSnapshot: (settings) => input.buildInitialSnapshot(settings.provider),
    checkProvider: input.checkProvider,
    enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
      Effect.flatMap(input.resolveMaintenance(), (maintenanceCapabilities) =>
        input.enrichSnapshot({
          snapshot: currentSnapshot,
          maintenanceCapabilities,
          enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          publishSnapshot,
          httpClient: input.httpClient,
        }),
      ),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: input.driverKind,
          instanceId: input.instanceId,
          detail: `Failed to build ${input.displayLabel} snapshot: ${cause.message ?? String(cause)}`,
          cause,
        }),
    ),
  );
});
