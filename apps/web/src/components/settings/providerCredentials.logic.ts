import { MODEL_CREDENTIAL_VALUE_REDACTED } from "@t3tools/contracts";
import type {
  ModelBackendConnectionId,
  ModelCredential,
  ModelCredentialId,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";

/**
 * Pure patches and render decisions for the stored API-key credentials map
 * (`ServerSettings.modelCredentials`), the credential half of the Providers
 * tab. The map is whole-map replacement (same as `modelBackendConnections`):
 * add/edit/remove send the full map, and an unchanged secret travels as the
 * `MODEL_CREDENTIAL_VALUE_REDACTED` sentinel — the server reads the sentinel
 * back as "keep what you have" (same contract as `managementKey`).
 */

const MODEL_CREDENTIAL_ID_MAX_CHARS = 64;
// Same slug rules as `ModelBackendConnectionId` / `ModelCredentialId` in
// contracts: user-chosen keys, letter first, letters/digits/`-`/`_` after.
const MODEL_CREDENTIAL_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Credential vendor presets for the add form. Each preset also names the
 * vendor's public API root so the per-credential Test button can probe the
 * stored key through the existing `server.testModelBackend` RPC; custom
 * vendors have no default URL and are only testable through a connection
 * that references the credential.
 */
export const CREDENTIAL_VENDOR_PRESETS: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
}> = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google Gemini" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "xai", label: "xAI" },
  { id: "custom", label: "Custom" },
];

const CREDENTIAL_PROBE_URLS: Readonly<Record<string, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
};

/** Preset probe URL for a vendor, or `undefined` for custom vendors. */
export function credentialProbeUrl(vendor: string): string | undefined {
  return CREDENTIAL_PROBE_URLS[vendor];
}

/** Display label for a vendor slug: preset label, or the raw slug for custom vendors. */
export function credentialVendorLabel(vendor: string): string {
  return CREDENTIAL_VENDOR_PRESETS.find((preset) => preset.id === vendor)?.label ?? vendor;
}

export function isPresetVendor(vendor: string): boolean {
  return credentialProbeUrl(vendor) !== undefined;
}

/**
 * Render decision for a credential's stored-secret state. Clients never see
 * real key values — the server replaces them with the sentinel, so a stored
 * secret and an empty entry are the only two observable states.
 */
export type CredentialSecretState =
  | { readonly kind: "stored"; readonly lastFour?: string | undefined }
  | { readonly kind: "empty" };

export function credentialSecretState(credential: ModelCredential): CredentialSecretState {
  return credential.value === MODEL_CREDENTIAL_VALUE_REDACTED
    ? {
        kind: "stored",
        ...(credential.lastFour !== undefined ? { lastFour: credential.lastFour } : {}),
      }
    : { kind: "empty" };
}

/**
 * Slugify a label into a credential-id proposal. Mirrors
 * `slugifyBackendConnectionId` but falls back to `key` — credentials are
 * keys, not connections.
 */
export function slugifyCredentialId(label: string): string {
  const folded = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MODEL_CREDENTIAL_ID_MAX_CHARS);
  if (folded.length === 0) return "key";
  if (/^[a-z]/u.test(folded)) return folded;
  return `key-${folded}`.slice(0, MODEL_CREDENTIAL_ID_MAX_CHARS).replace(/-+$/gu, "");
}

/**
 * Allocate a free credential id for the map: the trimmed proposal when valid
 * and unused, otherwise slugified/suffixed — same collision rule as
 * `allocateBackendConnectionId`, so a collision never overwrites.
 */
export function allocateCredentialId(desired: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const trimmed = desired.trim();
  const base =
    trimmed.length > 0 &&
    trimmed.length <= MODEL_CREDENTIAL_ID_MAX_CHARS &&
    MODEL_CREDENTIAL_ID_PATTERN.test(trimmed)
      ? trimmed
      : slugifyCredentialId(trimmed);
  if (!taken.has(base)) return base;
  for (let counter = 2; ; counter += 1) {
    const suffix = `-${counter}`;
    const candidate = `${base.slice(0, MODEL_CREDENTIAL_ID_MAX_CHARS - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Validate a credential id for display. Collisions are not errors (saves
 * suffix them); only empty/overlong/off-pattern input is rejected.
 */
export function validateCredentialId(id: string): string | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) return "Key ID is required.";
  if (trimmed.length > MODEL_CREDENTIAL_ID_MAX_CHARS) {
    return "Key ID must be 64 characters or fewer.";
  }
  if (!MODEL_CREDENTIAL_ID_PATTERN.test(trimmed)) {
    return "Key ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  return null;
}

/**
 * Validate a custom vendor slug (same pattern as the credential id, since
 * `ModelVendor` shares the contract's slug rules).
 */
export function validateVendorSlug(vendor: string): string | null {
  const trimmed = vendor.trim();
  if (trimmed.length === 0) return "Vendor is required.";
  if (trimmed.length > MODEL_CREDENTIAL_ID_MAX_CHARS) {
    return "Vendor must be 64 characters or fewer.";
  }
  if (!MODEL_CREDENTIAL_ID_PATTERN.test(trimmed)) {
    return "Vendor must start with a letter and use only letters, digits, '-', or '_'.";
  }
  return null;
}

/** Whole-map patch with one credential added (callers send the full map). */
export function addCredential(
  credentials: Readonly<Record<string, ModelCredential>>,
  id: string,
  credential: ModelCredential,
): Record<string, ModelCredential> {
  return { ...credentials, [id]: credential };
}

/** Whole-map patch with one credential removed (callers send the full map). */
export function removeCredential(
  credentials: Readonly<Record<string, ModelCredential>>,
  id: string,
): Record<string, ModelCredential> {
  const { [id]: _omit, ...rest } = credentials;
  return rest;
}

/**
 * The edited credential entry. A blank key input means "keep the stored
 * secret": the existing value (the redacted sentinel for a stored key)
 * travels back unchanged, lastFour included. Typing a value replaces the
 * secret; lastFour is dropped and the server re-stamps it at persist time.
 */
export function nextCredentialWithSecret(
  existing: ModelCredential,
  draft: { readonly displayName: string; readonly vendor: string; readonly value: string },
): ModelCredential {
  const value = draft.value.trim();
  const keepsStoredSecret = value.length === 0;
  return {
    displayName: draft.displayName.trim(),
    vendor: draft.vendor.trim() as ModelCredential["vendor"],
    value: keepsStoredSecret ? existing.value : value,
    ...(keepsStoredSecret && existing.lastFour !== undefined
      ? { lastFour: existing.lastFour }
      : {}),
  };
}

/**
 * How many connections reference a credential. The remove-confirm dialog
 * names the count; referencing connections keep their (now dangling)
 * reference and probe/route keyless — same orphan rule as a deleted
 * connection.
 */
export function countCredentialReferences(
  connections: Readonly<Record<string, Pick<ModelProxyLike, "apiKeyCredentialId">>>,
  credentialId: string,
): number {
  let count = 0;
  for (const connection of Object.values(connections)) {
    if (
      connection.apiKeyCredentialId !== undefined &&
      String(connection.apiKeyCredentialId) === credentialId
    ) {
      count += 1;
    }
  }
  return count;
}

/** Minimal connection shape the reference helpers need. */
interface ModelProxyLike {
  readonly baseUrl: string;
  readonly apiKeyCredentialId?: ModelCredentialId | undefined;
  readonly apiKeyEnv?: string | undefined;
}

/**
 * The first connection referencing a credential, for the custom-vendor Test
 * button (which probes through that connection's endpoint since custom
 * vendors have no preset URL). Map order is the user's entry order.
 */
export function referencingConnection(
  connections: Readonly<
    Record<string, Pick<ModelProxyLike, "apiKeyCredentialId" | "baseUrl" | "apiKeyEnv">>
  >,
  credentialId: string,
):
  | { readonly id: string; readonly baseUrl: string; readonly apiKeyEnv?: string | undefined }
  | undefined {
  for (const [id, connection] of Object.entries(connections)) {
    if (
      connection.apiKeyCredentialId !== undefined &&
      String(connection.apiKeyCredentialId) === credentialId
    ) {
      return {
        id,
        baseUrl: connection.baseUrl,
        ...(connection.apiKeyEnv !== undefined ? { apiKeyEnv: connection.apiKeyEnv } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Instance → connection links for `deriveModelCatalog`, mirrored from
 * `ServerSettings.providerInstances` (`ProviderInstanceConfig.connectionId`).
 * Snapshots do not carry the link, so the catalog takes it as input.
 */
export function buildInstanceConnections(
  providerInstances:
    | Readonly<Record<string, Pick<ProviderInstanceConfig, "connectionId">>>
    | undefined,
): Partial<Record<ProviderInstanceId, ModelBackendConnectionId>> {
  if (providerInstances === undefined) return {};
  const links: Partial<Record<ProviderInstanceId, ModelBackendConnectionId>> = {};
  for (const [instanceId, instance] of Object.entries(providerInstances)) {
    if (instance.connectionId !== undefined) {
      links[instanceId as ProviderInstanceId] = instance.connectionId;
    }
  }
  return links;
}
