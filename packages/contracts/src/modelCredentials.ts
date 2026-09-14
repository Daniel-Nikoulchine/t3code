import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

const MODEL_CREDENTIAL_SLUG_MAX_CHARS = 64;
// Intentionally the same slug rules as `ModelBackendConnectionId` (see
// modelBackend.ts): user-chosen keys, letter first, letters/digits/`-`/`_`
// after, 1..64 chars. Branded separately so the type system cannot confuse
// a credential id with a connection id or instance id.
const MODEL_CREDENTIAL_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const ModelCredentialId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MODEL_CREDENTIAL_SLUG_MAX_CHARS),
  Schema.isPattern(MODEL_CREDENTIAL_SLUG_PATTERN),
).pipe(Schema.brand("ModelCredentialId"));
export type ModelCredentialId = typeof ModelCredentialId.Type;

/**
 * Open vendor slug for a credential: a preset (`anthropic`, `openai`,
 * `google`, `deepseek`, `xai`) or any user-chosen vendor (GLM, Kimi,
 * OpenRouter, …). Branded so vendor slugs cannot be confused with driver
 * kinds or connection ids at the type level.
 */
export const ModelVendor = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MODEL_CREDENTIAL_SLUG_MAX_CHARS),
  Schema.isPattern(MODEL_CREDENTIAL_SLUG_PATTERN),
).pipe(Schema.brand("ModelVendor"));
export type ModelVendor = typeof ModelVendor.Type;

/**
 * On disk/in-memory the credential value is replaced by this marker and the
 * real value lives in the secret store, mirroring
 * `UsageLimitSourceConfig.managementKey`. A client that sends the marker
 * back means "keep what you have".
 */
export const MODEL_CREDENTIAL_VALUE_REDACTED = "\u2022\u2022\u2022\u2022\u2022\u2022";

/**
 * One stored API key in `ServerSettings.modelCredentials`. OAuth/subscription
 * credentials are deliberately not expressible here: those are harness-bound
 * (they live in the per-instance CLI config dirs and must never be copied
 * into the model-routing layer). Only API keys travel through this map —
 * that is what makes them reusable across harnesses.
 */
export const ModelCredential = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  vendor: ModelVendor,
  value: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  /** Last characters of the stored value, stamped at persist time for display. */
  lastFour: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ModelCredential = typeof ModelCredential.Type;

/**
 * Map shape for `ServerSettings.modelCredentials`. Keyed by
 * `ModelCredentialId`; referenced by `ModelProxyConfig.apiKeyCredentialId`
 * and by model-router route targets.
 */
export const ModelCredentials = Schema.Record(ModelCredentialId, ModelCredential);
export type ModelCredentials = typeof ModelCredentials.Type;
