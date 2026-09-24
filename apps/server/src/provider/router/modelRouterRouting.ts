/**
 * Pure route resolution for the model router: settings snapshot + requested
 * model slug → upstream endpoint, key, wire protocol. No HTTP, no Effect —
 * exercised directly by unit tests.
 *
 * Key semantics mirror `resolveModelBackendEnvironment` (see
 * `provider/ModelBackendEnvironment.ts`, not imported on purpose: that module
 * is shaped as a harness env overlay, this is an HTTP upstream): a stored
 * credential value wins, then `apiKeyEnv` is resolved against `baseEnv`, and
 * an empty value counts as "no key" (keyless gateways are called without
 * auth headers, same as the backend probe). The redaction sentinel is never
 * mistaken for a key — materialized settings should never carry it, but a
 * client round-trip that leaks it through must not send bullet characters
 * upstream.
 *
 * @module provider/router/modelRouterRouting
 */
import {
  MODEL_CREDENTIAL_VALUE_REDACTED,
  type ModelBackendConnections,
  type ModelCredentialId,
  type ModelCredentials,
  type ModelProxyConfig,
  type ModelProxyProtocol,
  type ModelRouterRoutes,
} from "@t3tools/contracts";

/** The slice of materialized `ServerSettings` the router reads per request. */
export interface ModelRouterSnapshot {
  readonly routes: ModelRouterRoutes;
  readonly connections: ModelBackendConnections;
  readonly credentials: ModelCredentials;
  /**
   * Codex harness logins usable as OAuth token sources, keyed by provider
   * instance id. The proxy mints the bearer per request through the named
   * harness and never stores a token here.
   */
  readonly codexAccounts: Record<string, CodexOAuthAccount>;
}

/**
 * How to reach one Codex harness login: spawn inputs for
 * `resolveCodexOAuthCredentials`, mirroring what `CodexDriver` passes to
 * `withCodexAppServerClient` (expanded binary path, effective home, launch
 * args, and the instance's merged environment).
 */
export interface CodexOAuthAccount {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly launchArgs?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

export interface ModelRouterUpstream {
  /**
   * How the operation path is appended. Vendor base URLs always carry the
   * API version prefix (presets or a user override), so Anthropic gets
   * `/messages`; connection base URLs follow the harness contract the
   * registry's env overlay establishes (Claude Code appends `/v1/messages`
   * to `ANTHROPIC_BASE_URL`), so Anthropic gets `/v1/messages`. OpenAI
   * appends `/chat/completions` either way.
   */
  readonly kind: "vendor" | "connection" | "codex-oauth";
  /** Base URL including the API version prefix (repo-wide `/v1` convention). */
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  /**
   * Codex instance whose OAuth login authenticates this route. Set only for
   * `kind: "codex-oauth"`; the proxy then mints the bearer token per request
   * through that harness and never relays a stored key.
   */
  readonly codexAccountInstanceId?: string | undefined;
  /** Wire protocol the upstream speaks. */
  readonly protocol: ModelProxyProtocol;
  /** Slug to send upstream (`route.upstreamModel`, defaulting to the route key). */
  readonly upstreamModel: string;
  /**
   * Force the Responses wire protocol upstream even for chat-shaped inbound
   * (`route.upstreamResponses`, defaulting to false).
   */
  readonly responsesUpstream: boolean;
}

export type ResolveModelRouteResult =
  | { readonly _tag: "Found"; readonly upstream: ModelRouterUpstream }
  /** No route for the slug — surfaced as a 404 in the inbound error shape. */
  | { readonly _tag: "UnknownModel" }
  /** Route exists but its target cannot be resolved (orphaned connection, or a
   * vendor without a preset or explicit baseUrl) — a server-side config
   * problem, surfaced as a 502 rather than a fallback. */
  | { readonly _tag: "UnresolvedTarget" };

const PRESET_VENDOR_BASE_URLS: Readonly<Record<string, string>> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  deepseek: "https://api.deepseek.com/v1",
  xai: "https://api.x.ai/v1",
};

/**
 * Upstream wire protocol for a vendor target. `anthropic` is the only
 * preset speaking the Anthropic protocol; every other vendor (including
 * user-chosen slugs like `glm` or `openrouter`) is OpenAI-compatible — the
 * dominant gateway convention.
 */
export const vendorProtocol = (vendor: string): ModelProxyProtocol =>
  vendor === "anthropic" ? "anthropic" : "openai";

const materializedCredentialValue = (
  credentialId: ModelCredentialId,
  credentials: ModelCredentials,
): string | undefined => {
  const value = credentials[credentialId]?.value;
  return value !== undefined && value.length > 0 && value !== MODEL_CREDENTIAL_VALUE_REDACTED
    ? value
    : undefined;
};

/**
 * Decide the upstream wire protocol for a connection target. A connection
 * that declares the inbound protocol is treated as speaking it (pass-through
 * — the default "both" covers gateways that accept either wire format).
 * Only when the connection declares just the other protocol does the proxy
 * translate.
 */
const connectionProtocol = (
  connection: ModelProxyConfig,
  inbound: ModelProxyProtocol,
): ModelProxyProtocol => {
  const protocols = connection.protocols;
  if (protocols === undefined || protocols.includes(inbound)) return inbound;
  return protocols[0] ?? inbound;
};

export const resolveModelRoute = (
  snapshot: ModelRouterSnapshot,
  model: string,
  inbound: ModelProxyProtocol,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ResolveModelRouteResult => {
  const route = snapshot.routes[model];
  if (route === undefined) {
    return { _tag: "UnknownModel" };
  }
  const upstreamModel = route.upstreamModel ?? model;
  const target = route.target;

  if (target.kind === "vendor") {
    const apiKey = materializedCredentialValue(target.credentialId, snapshot.credentials);
    const baseUrl = target.baseUrl ?? PRESET_VENDOR_BASE_URLS[target.vendor];
    if (baseUrl === undefined) {
      return { _tag: "UnresolvedTarget" };
    }
    return {
      _tag: "Found",
      upstream: {
        kind: "vendor",
        baseUrl,
        apiKey,
        protocol: vendorProtocol(target.vendor),
        upstreamModel,
        responsesUpstream: route.upstreamResponses ?? false,
      },
    };
  }

  const connection = snapshot.connections[target.connectionId];
  if (connection === undefined || connection.baseUrl === undefined) {
    return { _tag: "UnresolvedTarget" };
  }
  // A Codex OAuth account route authenticates with the harness's own ChatGPT
  // login, minted per request by the proxy. Keys and env indirections never
  // apply — a stored credential on the same connection must not override it.
  // A dangling account reference (instance deleted) cannot mint, so it is
  // unreachable rather than keyless.
  if (connection.codexAccountInstanceId !== undefined) {
    if (snapshot.codexAccounts[connection.codexAccountInstanceId] === undefined) {
      return { _tag: "UnresolvedTarget" };
    }
    return {
      _tag: "Found",
      upstream: {
        kind: "codex-oauth",
        baseUrl: connection.baseUrl,
        apiKey: undefined,
        codexAccountInstanceId: connection.codexAccountInstanceId,
        protocol: "openai",
        upstreamModel,
        responsesUpstream: true,
      },
    };
  }
  const credentialValue =
    connection.apiKeyCredentialId === undefined
      ? undefined
      : materializedCredentialValue(connection.apiKeyCredentialId, snapshot.credentials);
  const apiKey =
    credentialValue ??
    (connection.apiKeyEnv !== undefined ? baseEnv[connection.apiKeyEnv] : undefined) ??
    undefined;
  return {
    _tag: "Found",
    upstream: {
      kind: "connection",
      baseUrl: connection.baseUrl,
      apiKey,
      protocol: connectionProtocol(connection, inbound),
      upstreamModel,
      responsesUpstream: route.upstreamResponses ?? false,
    },
  };
};

/**
 * Session header OpenCode Go requires (`x-opencode-session`, verified live:
 * requests without it fail with `MissingSessionID`). A harness-supplied id
 * passes through; otherwise a stable per-route id keeps routing and prompt
 * caching working. Returns undefined for any other upstream.
 */
export const resolveOpencodeGoSessionHeader = (input: {
  readonly baseUrl: string;
  readonly routeKey: string;
  readonly inboundSessionId: unknown;
}): string | undefined => {
  if (!input.baseUrl.includes("opencode.ai/zen/go")) return undefined;
  return typeof input.inboundSessionId === "string" && input.inboundSessionId.length > 0
    ? input.inboundSessionId
    : `t3-router-${input.routeKey}`;
};

/**
 * Model ids advertised on `/models`: the route keys plus the static
 * `models` lists of connections that route targets reference. Vendor
 * targets contribute nothing — their upstream slugs are not enumerable
 * without a live call. Sorted for stable output.
 */
export const routedModelIds = (snapshot: ModelRouterSnapshot): ReadonlyArray<string> => {
  const ids = new Set<string>();
  for (const key of Object.keys(snapshot.routes)) {
    ids.add(key);
  }
  for (const route of Object.values(snapshot.routes)) {
    if (route.target.kind !== "connection") continue;
    for (const model of snapshot.connections[route.target.connectionId]?.models ?? []) {
      ids.add(model);
    }
  }
  return [...ids].sort();
};
