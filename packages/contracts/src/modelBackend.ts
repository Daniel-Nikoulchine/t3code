import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelCredentialId } from "./modelCredentials.ts";

/**
 * Which wire protocols an endpoint speaks. Harnesses differ: Codex speaks
 * the OpenAI API, Claude Code speaks the Anthropic API, and most vendor
 * gateways (GLM, DeepSeek, Kimi, …) offer both. The env overlay only sets
 * the variable pairs of the declared protocols.
 */
export const ModelProxyProtocol = Schema.Literals(["openai", "anthropic"]);
export type ModelProxyProtocol = typeof ModelProxyProtocol.Type;

const DEFAULT_PROXY_PROTOCOLS: ReadonlyArray<ModelProxyProtocol> = ["openai", "anthropic"];

/**
 * `t3-router` is the built-in local translation proxy (see the server's
 * `provider/router` module). Instances referencing the reserved
 * `T3_ROUTER_CONNECTION_ID` get a synthesized backend of this kind whose
 * baseUrl points at the running proxy's loopback listener; it is only valid
 * while that listener is up.
 */
export const ModelBackendKind = Schema.Literals(["native", "openai-compatible", "t3-router"]);
export type ModelBackendKind = typeof ModelBackendKind.Type;
const ModelBackendConfigBase = Schema.Struct({
  kind: ModelBackendKind,
  // Include the API prefix, e.g. https://host/v1 — the probe calls GET {baseUrl}/models.
  baseUrl: Schema.optional(TrimmedNonEmptyString),
  apiKeyEnv: Schema.optional(TrimmedNonEmptyString),
  displayName: Schema.optional(TrimmedNonEmptyString),
  /**
   * Resolved API key. Synthesized at runtime (from a stored credential or an
   * inline probe request) and never persisted — settings only ever carry
   * credential *references*, and the overlay prefers this value over the
   * `apiKeyEnv` indirection.
   */
  apiKey: Schema.optional(TrimmedNonEmptyString),
  /** Defaults to both protocols, matching the historical dual-pair overlay. */
  protocols: Schema.optional(
    Schema.Array(ModelProxyProtocol).pipe(
      Schema.withDecodingDefault(Effect.succeed([...DEFAULT_PROXY_PROTOCOLS])),
    ),
  ),
  /** Model slugs the endpoint serves; merged into referencing instances' model lists. */
  models: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /**
   * Codex OAuth account backend: set when the referenced connection names a
   * `codexAccountInstanceId`. Codex's own sign-in authenticates the proxied
   * requests, so the home layout emits `requires_openai_auth` instead of an
   * `env_key` (mirrors `ModelProxyConfig.codexAccountInstanceId`).
   */
  codexAccountInstanceId: Schema.optionalKey(TrimmedNonEmptyString),
});

const requiresBaseUrlForOpenAiCompatible = Schema.makeFilter(
  (config: typeof ModelBackendConfigBase.Type) =>
    config.kind !== "openai-compatible" ||
    (typeof config.baseUrl === "string" && config.baseUrl.length > 0) ||
    `openai-compatible backend requires baseUrl.`,
);

export const ModelBackendConfig = ModelBackendConfigBase.check(requiresBaseUrlForOpenAiCompatible);
export type ModelBackendConfig = typeof ModelBackendConfig.Type;

/**
 * One named model backend connection (a user-managed OpenAI-/Anthropic-
 * compatible `/v1` endpoint). Stored per entry in
 * `ServerSettings.modelBackendConnections`; provider instances reference an
 * entry via `ProviderInstanceConfig.connectionId` and the registry
 * synthesizes the per-instance `ModelBackendConfig` overlay from the
 * referenced value.
 *
 * There is intentionally no `kind` field: a connection is always a proxy.
 * The API key never lives here — either `apiKeyEnv` names an environment
 * variable, or `apiKeyCredentialId` references `ServerSettings.modelCredentials`.
 */
export const ModelProxyConfig = Schema.Struct({
  /** Codex owns this account's OAuth login and refresh. No token is stored here. */
  codexAccountInstanceId: Schema.optionalKey(TrimmedNonEmptyString),
  // Include the API prefix, e.g. https://host/v1 — the probe calls GET {baseUrl}/models.
  baseUrl: TrimmedNonEmptyString,
  apiKeyEnv: Schema.optional(TrimmedNonEmptyString),
  displayName: Schema.optional(TrimmedNonEmptyString),
  /** Which wire protocols the endpoint speaks. Defaults to both. */
  protocols: Schema.Array(ModelProxyProtocol).pipe(
    Schema.withDecodingDefault(Effect.succeed([...DEFAULT_PROXY_PROTOCOLS])),
  ),
  /** Static model slugs served by this endpoint, merged with probe results. */
  models: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Reference into `ServerSettings.modelCredentials`; wins over `apiKeyEnv`. */
  apiKeyCredentialId: Schema.optionalKey(ModelCredentialId),
});
export type ModelProxyConfig = typeof ModelProxyConfig.Type;

const MODEL_BACKEND_CONNECTION_SLUG_MAX_CHARS = 64;
// Intentionally the same slug rules as `ProviderInstanceId` (see
// providerInstance.ts): user-chosen keys, letter first, letters/digits/`-`/
// `_` after, 1..64 chars, trimmed. Branded separately so the type system
// cannot confuse a connection id with an instance id.
const MODEL_BACKEND_CONNECTION_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * `ModelBackendConnectionId` — user-chosen routing key for one entry of
 * `ServerSettings.modelBackendConnections`. Provider instances reference a
 * connection through `ProviderInstanceConfig.connectionId`; absent means
 * direct/native.
 */
export const ModelBackendConnectionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MODEL_BACKEND_CONNECTION_SLUG_MAX_CHARS),
  Schema.isPattern(MODEL_BACKEND_CONNECTION_SLUG_PATTERN),
).pipe(Schema.brand("ModelBackendConnectionId"));
export type ModelBackendConnectionId = typeof ModelBackendConnectionId.Type;

/**
 * Map shape for `ServerSettings.modelBackendConnections`. Keyed by
 * `ModelBackendConnectionId`; values are `ModelProxyConfig` entries the
 * registry resolves per-instance `connectionId` references against.
 */
export const ModelBackendConnections = Schema.Record(ModelBackendConnectionId, ModelProxyConfig);
export type ModelBackendConnections = typeof ModelBackendConnections.Type;
