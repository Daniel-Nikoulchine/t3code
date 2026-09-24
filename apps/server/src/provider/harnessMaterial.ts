/**
 * HarnessMaterial — single seam for what a spawned harness process receives
 * from a model backend connection.
 *
 * Drivers used to repeat the same spread (`{...merge..., ...overlay}`) with
 * the merge order only documented in a comment, and the registry degraded a
 * dangling `connectionId` to native without telling anyone. Both are owned
 * here now:
 *
 *   - `resolveHarnessProcessEnv` fixes the merge order (backend overlay wins)
 *     and returns the intermediate pieces so drivers that need more than the
 *     spawn env (config-file injection, shadow homes) reuse the same inputs.
 *   - `orphanBackendConnectionId` names the dangling reference the registry
 *     falls back on, so the fallback stays native but becomes observable.
 *
 * Pure; no Effect services involved.
 *
 * @module provider/harnessMaterial
 */
import type {
  ModelBackendConfig,
  ModelBackendConnections,
  ProviderInstanceConfig,
  ProviderInstanceEnvironment,
} from "@t3tools/contracts";

import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { resolveModelBackendEnvironment as resolveBackendOverlay } from "./ModelBackendEnvironment.ts";

export interface HarnessProcessEnv {
  /** Instance vars merged over the base env, before any backend overlay. */
  readonly instanceEnv: NodeJS.ProcessEnv;
  /** Backend overlay only (empty without a usable backend). */
  readonly backendOverlay: NodeJS.ProcessEnv;
  /** Spawn env: `{ ...instanceEnv, ...backendOverlay }`. Backend wins. */
  readonly processEnv: NodeJS.ProcessEnv;
}

/**
 * Instance vars over `baseEnv`. Explicit `baseEnv` on purpose (no hidden
 * `process.env` default at the seam); callers pass it in.
 */
export function resolveHarnessBaseEnv(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return mergeProviderInstanceEnvironment(environment, baseEnv);
}

/**
 * Full spawn material for a harness process. Prefer this over hand-spreading
 * `mergeProviderInstanceEnvironment` + `resolveModelBackendEnvironment` in
 * drivers — the merge order lives here, not in N copies.
 */
export function resolveHarnessProcessEnv(input: {
  readonly environment: ProviderInstanceEnvironment | undefined;
  readonly backend: ModelBackendConfig | undefined;
  readonly baseEnv: NodeJS.ProcessEnv;
}): HarnessProcessEnv {
  const instanceEnv = resolveHarnessBaseEnv(input.environment, input.baseEnv);
  const backendOverlay = resolveBackendOverlay(input.backend, input.baseEnv);
  return {
    instanceEnv,
    backendOverlay,
    processEnv: { ...instanceEnv, ...backendOverlay },
  };
}

/**
 * The referenced connection id when it has no map entry (deleted
 * connection, or the synthesized `t3-router` entry missing because the
 * router failed to bind). The registry still resolves these to native —
 * deleting a connection must never break referencing instances — but the
 * caller can now observe the fallback instead of degrading silently.
 *
 * Pure; exported for unit tests and the registry's reconcile path.
 */
export function orphanBackendConnectionId(
  entry: Pick<ProviderInstanceConfig, "connectionId">,
  connections: ModelBackendConnections | undefined,
): string | undefined {
  const connectionId = entry.connectionId;
  if (connectionId === undefined) return undefined;
  if (connections?.[connectionId] !== undefined) return undefined;
  return String(connectionId);
}
