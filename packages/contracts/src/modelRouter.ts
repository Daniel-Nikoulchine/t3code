import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelBackendConnectionId } from "./modelBackend.ts";
import { ModelCredentialId, ModelVendor } from "./modelCredentials.ts";

/**
 * Reserved `ModelBackendConnectionId` under which the running T3 router
 * (the built-in local translation proxy) is injected into the connections
 * map the instance registry resolves against. Provider instances opt in by
 * setting `ProviderInstanceConfig.connectionId` to this value. A user entry
 * keyed with the same id wins — the synthesized connection is only injected
 * when the id is unclaimed.
 */
export const T3_ROUTER_CONNECTION_ID = "t3-router" as ModelBackendConnectionId;

/**
 * Where one routed model goes. Either a user-managed connection
 * (`ServerSettings.modelBackendConnections` entry, key materialized from its
 * credential or `apiKeyEnv`) or a native vendor API identified by a stored
 * credential. OAuth/subscription tokens are intentionally not expressible —
 * same constraint as `ModelCredential`: keys only.
 */
export const ModelRouterRouteTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("connection"),
    connectionId: ModelBackendConnectionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("vendor"),
    vendor: ModelVendor,
    credentialId: ModelCredentialId,
    /** Overrides the vendor's preset base URL (an OpenAI-/Anthropic-compatible `/v1` root). */
    baseUrl: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type ModelRouterRouteTarget = typeof ModelRouterRouteTarget.Type;

/**
 * One route of `ServerSettings.modelRouterRoutes`: a logical model id slug
 * (the map key, i.e. what a harness puts in the `model` field) mapped to an
 * upstream target.
 */
export const ModelRouterRoute = Schema.Struct({
  target: ModelRouterRouteTarget,
  /**
   * Upstream model slug. Absent means pass the route key (the logical model
   * id) upstream unchanged — the common case where the connection serves the
   * same slug it is routed as. There is deliberately no schema default for
   * this: the fallback is the *route key*, which only the resolver knows.
   */
  upstreamModel: Schema.optional(TrimmedNonEmptyString),
  /**
   * Force the Responses wire protocol upstream even for chat-shaped inbound
   * (the proxy translates). For upstreams that only serve a model on
   * `/responses` (verified live: opencode-go grok-4.6 and the muse-spark
   * contributor tier reject `/chat/completions`).
   */
  upstreamResponses: Schema.optional(Schema.Boolean),
});
export type ModelRouterRoute = typeof ModelRouterRoute.Type;

/**
 * Map shape for `ServerSettings.modelRouterRoutes`. Keyed by the logical
 * model id slug; no slug pattern restriction because upstream model ids
 * freely contain dots, slashes, and colons.
 */
export const ModelRouterRoutes = Schema.Record(TrimmedNonEmptyString, ModelRouterRoute);
export type ModelRouterRoutes = typeof ModelRouterRoutes.Type;
