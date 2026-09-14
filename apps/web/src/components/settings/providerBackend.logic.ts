import type { ModelProviderPreset } from "@t3tools/client-runtime/state/model-provider-presets";
import type {
  ModelBackendConfig,
  ModelProxyConfig,
  ModelProxyProtocol,
  ProviderInstanceConfig,
} from "@t3tools/contracts";
import { ModelCredentialId, T3_ROUTER_CONNECTION_ID } from "@t3tools/contracts";

/**
 * Pure patches for the named model-backend connections map.
 *
 * Connections live on `ServerSettings.modelBackendConnections` as a whole-map
 * replacement (absent/empty means no connections, all instances native).
 * Provider instances reference one entry via
 * `ProviderInstanceConfig.connectionId` (absent means direct); the registry
 * synthesizes the per-instance backend overlay centrally, and a `connectionId`
 * with no matching map entry (orphan, e.g. after the connection was deleted)
 * silently routes natively while the UI surfaces the hint. Callers persist
 * through the existing settings patch (`updateSettings({
 * modelBackendConnections: nextMap })` for add/remove, the
 * `buildProviderInstanceUpdatePatch` + `onUpdate` whole-map pattern for the
 * per-instance selection — same shape as `updateDisplayName`).
 */

export interface ModelProxyDraft {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly displayName: string;
  /** Wire protocols the endpoint speaks; defaults to both. */
  readonly protocols?: ReadonlyArray<ModelProxyProtocol> | undefined;
  /** Stored credential reference (wins over `apiKeyEnv`); empty means none. */
  readonly apiKeyCredentialId?: string | undefined;
  /** Model slugs served by the endpoint; empty means unset. */
  readonly models?: ReadonlyArray<string> | undefined;
}

const BOTH_PROTOCOLS: ReadonlyArray<ModelProxyProtocol> = ["openai", "anthropic"];

/**
 * Clean draft fields into a saveable connection entry. Trims; drops blank
 * optional names so the stored value stays minimal; omits `models` when
 * empty. `protocols` is required by the contract, so a draft without any
 * stores both (the contract's decoding default) and the dialog gates the
 * empty selection. Returns `undefined` when the base URL is blank — the
 * contract requires it, so the dialog must not add or probe.
 */
export function toModelProxyConfig(draft: ModelProxyDraft): ModelProxyConfig | undefined {
  const baseUrl = draft.baseUrl.trim();
  if (baseUrl.length === 0) return undefined;
  const apiKeyEnv = draft.apiKeyEnv.trim();
  const displayName = draft.displayName.trim();
  const apiKeyCredentialId = draft.apiKeyCredentialId?.trim() ?? "";
  const selected = draft.protocols ?? BOTH_PROTOCOLS;
  const protocols = BOTH_PROTOCOLS.filter((protocol) => selected.includes(protocol));
  const models = [
    ...new Set(
      (draft.models ?? []).map((model) => model.trim()).filter((model) => model.length > 0),
    ),
  ];
  return {
    baseUrl,
    ...(apiKeyEnv.length > 0 ? { apiKeyEnv } : {}),
    ...(displayName.length > 0 ? { displayName } : {}),
    protocols,
    ...(models.length > 0 ? { models } : {}),
    ...(apiKeyCredentialId.length > 0
      ? { apiKeyCredentialId: ModelCredentialId.make(apiKeyCredentialId) }
      : {}),
  };
}

/**
 * Build the probe envelope for the existing `server.testModelBackend` RPC
 * (which takes `{ backend: ModelBackendConfig }`) from a connection entry.
 * No new RPC: a connection is always a proxy endpoint, so the kind is fixed.
 * `apiKeyCredentialId` is not part of `ModelBackendConfig` — callers pass it
 * separately to the probe so the server resolves the key from the store.
 */
export function toTestBackend(proxy: ModelProxyConfig): ModelBackendConfig {
  const { apiKeyCredentialId: _credential, ...rest } = proxy;
  return { kind: "openai-compatible", ...rest };
}

/**
 * Fill the add-dialog draft from a provider template. One-way only: the
 * draft keeps no link to the preset, so edits after applying stay free and
 * `custom` simply resets to blank fields. Non-custom presets label the
 * draft with the template name (editable like any other field).
 */
export function applyProviderPreset(preset: ModelProviderPreset): ModelProxyDraft {
  if (preset.id === "custom") return { baseUrl: "", apiKeyEnv: "", displayName: "" };
  return {
    baseUrl: preset.baseUrl,
    apiKeyEnv: preset.apiKeyEnv ?? "",
    displayName: preset.label,
  };
}

const BACKEND_CONNECTION_ID_MAX_CHARS = 64;
const BACKEND_CONNECTION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Slugify a preset label (or any free text) into a connection-id proposal:
 * lowercase, fold every run of non-alphanumerics to one dash, enforce the
 * letter-first contract rule (`connection-` prefix), cap at 64 chars,
 * `connection` fallback for empty input. Mirrors the
 * `ModelBackendConnectionId` slug rules in contracts (`modelBackend.ts`),
 * so proposals validate without a server round-trip.
 */
export function slugifyBackendConnectionId(label: string): string {
  const folded = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, BACKEND_CONNECTION_ID_MAX_CHARS);
  if (folded.length === 0) return "connection";
  if (/^[a-z]/u.test(folded)) return folded;
  return `connection-${folded}`.slice(0, BACKEND_CONNECTION_ID_MAX_CHARS).replace(/-+$/gu, "");
}

/**
 * Allocate a free connection id for the map: the trimmed proposal when it
 * is valid and unused, the slugified proposal when it is not valid input,
 * otherwise the proposal with a `-2`/`-3`/… suffix (base truncated so the
 * result still fits 64 chars). The add-dialog runs every save through here,
 * so a collision silently becomes a suffixed id instead of overwriting.
 * The built-in router's id is permanently taken — the registry injects it
 * when unclaimed, so a user entry must never claim it.
 */
export function allocateBackendConnectionId(desired: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  taken.add(T3_ROUTER_CONNECTION_ID);
  const trimmed = desired.trim();
  const base =
    trimmed.length > 0 &&
    trimmed.length <= BACKEND_CONNECTION_ID_MAX_CHARS &&
    BACKEND_CONNECTION_ID_PATTERN.test(trimmed)
      ? trimmed
      : slugifyBackendConnectionId(trimmed);
  if (!taken.has(base)) return base;
  for (let counter = 2; ; counter += 1) {
    const suffix = `-${counter}`;
    const candidate = `${base.slice(0, BACKEND_CONNECTION_ID_MAX_CHARS - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Validate a hand-edited connection id (mirrors `validateInstanceId` in the
 * add-instance dialog). Returns the error text, or `null` when saveable.
 * Collisions are NOT an error — `allocateBackendConnectionId` suffixes them
 * on save — so this only rejects empty/overlong/off-pattern input and the
 * reserved built-in router id, which no user entry may claim.
 */
export function validateBackendConnectionId(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) return "Connection ID is required.";
  if (trimmed.length > BACKEND_CONNECTION_ID_MAX_CHARS) {
    return "Connection ID must be 64 characters or fewer.";
  }
  if (!BACKEND_CONNECTION_ID_PATTERN.test(trimmed)) {
    return "Connection ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (trimmed === T3_ROUTER_CONNECTION_ID) {
    return '"t3-router" is reserved for the built-in routing.';
  }
  return null;
}

/** Whole-map patch with one entry added (callers send the full map). */
export function addBackendConnection(
  connections: Readonly<Record<string, ModelProxyConfig>>,
  id: string,
  config: ModelProxyConfig,
): Record<string, ModelProxyConfig> {
  return { ...connections, [id]: config };
}

/** Whole-map patch with one entry removed (callers send the full map). */
export function removeBackendConnection(
  connections: Readonly<Record<string, ModelProxyConfig>>,
  id: string,
): Record<string, ModelProxyConfig> {
  const { [id]: _omit, ...rest } = connections;
  return rest;
}

export type InstanceConnectionState =
  | { readonly kind: "direct" }
  | { readonly kind: "connected"; readonly connectionId: string }
  | { readonly kind: "orphan"; readonly connectionId: string };

/**
 * Render decision for the Harness card's provider selection: direct when no
 * `connectionId` is set, connected when it names a map entry, orphan when
 * the entry is gone (deleted connection — routes natively, card warns).
 * The built-in router (`t3-router`) is injected by the registry at resolve
 * time, not a settings entry, so it reads as connected, never an orphan.
 * Pure so both the web card and the mobile read-only rows decide identically.
 */
export function resolveInstanceConnectionState(
  instance: Pick<ProviderInstanceConfig, "connectionId">,
  connections: Readonly<Record<string, unknown>>,
): InstanceConnectionState {
  const connectionId = instance.connectionId;
  if (connectionId === undefined) return { kind: "direct" };
  const id = String(connectionId);
  if (id === T3_ROUTER_CONNECTION_ID) return { kind: "connected", connectionId: id };
  if (connections[id] === undefined) return { kind: "orphan", connectionId: id };
  return { kind: "connected", connectionId: id };
}

/**
 * Pure envelope patch for the instance connection selection (mirrors the
 * `updateDisplayName` whole-map pattern in `ProviderInstanceCard`: the caller
 * passes the result to the existing `onUpdate` hook). `null` removes the
 * field back to the direct default so the envelope stays minimal.
 */
export function nextInstanceWithConnectionId(
  instance: ProviderInstanceConfig,
  connectionId: string | null,
): ProviderInstanceConfig {
  const { connectionId: _omit, ...rest } = instance;
  if (connectionId === null) return rest as ProviderInstanceConfig;
  return { ...rest, connectionId } as ProviderInstanceConfig;
}

/**
 * How many provider instances reference a connection. The remove-confirm
 * dialog names the count so deleting a shared connection is explicit;
 * referencing instances silently fall back to native (orphan rule).
 */
export function countConnectionReferences(
  providerInstances:
    | Readonly<Record<string, Pick<ProviderInstanceConfig, "connectionId">>>
    | undefined,
  connectionId: string,
): number {
  if (providerInstances === undefined) return 0;
  let count = 0;
  for (const instance of Object.values(providerInstances)) {
    if (instance.connectionId !== undefined && String(instance.connectionId) === connectionId) {
      count += 1;
    }
  }
  return count;
}
