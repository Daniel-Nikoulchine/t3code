/**
 * Derives the client-side logical model catalog from data a client already
 * holds: provider snapshots (each instance's `models` list) plus the server
 * settings' model backend connections. Pure derivation shared by web and
 * mobile — no new wire format, no server change. Models become a first-class
 * entity by grouping the (instance, model) pairings the client can already
 * see into one {@link LogicalModel} per exact slug.
 *
 * Deliberate decisions:
 *
 *  - Grouping is by exact model slug. Alias merging across drivers (the same
 *    upstream model surfacing under different slugs per harness) is
 *    deliberately out of scope until something needs it.
 *  - A snapshot's `auth.status` is not consulted: an instance whose auth has
 *    lapsed still serves its listed models once re-authenticated, and pickers
 *    render auth affordances themselves. Only `auth.type` matters here, and
 *    only to classify the pairing ({@link authModeFromAuth}).
 *  - Provider snapshots do not carry `connectionId`, and the snapshot's
 *    `backend.viaProxy` is display-only metadata that can lag settings. The
 *    settings-level instance→connection link
 *    (`ProviderInstanceConfig.connectionId`) is therefore a caller-supplied
 *    input; connection-provided models become sources only through it.
 *
 * @module modelCatalog
 */
import type {
  ModelBackendConnectionId,
  ModelBackendConnections,
  ModelRouterRoute,
  ServerProvider,
} from "@t3tools/contracts";
import { ProviderInstanceId, T3_ROUTER_CONNECTION_ID } from "@t3tools/contracts";

export type ModelAuthMode = "api-key" | "subscription" | "unknown";

/**
 * Why an otherwise-eligible instance cannot serve a logical model yet.
 * `protocol-unsupported` and `subscription-bound` are reserved for the
 * router phase: classifying them needs per-connection protocol knowledge and
 * subscription-to-model binding that today's inputs do not carry.
 */
export type ModelAvailabilityReason =
  | "requires-api-key"
  | "subscription-bound"
  | "protocol-unsupported"
  | "vendor-locked";

/** One concrete, usable instance→model pairing. */
export interface LogicalModelSource {
  instanceId: string;
  model: string;
  /** `native` — the snapshot lists the model; `connection` — a linked model backend connection serves it. */
  via: "native" | "connection";
  authMode: ModelAuthMode;
  /** Snapshot display name; present on native sources (`ServerProviderModel.name` is required). */
  name?: string;
  /**
   * Upstream provider label for multi-provider harnesses (`ServerProviderModel.subProvider`).
   * Pickers prefer this over the harness instance display name so a MiniMax-served
   * OpenCode Go model reads as its provider, not as "MiniMax".
   */
  subProvider?: string;
}

/** An eligible instance that plausibly could serve the model but currently cannot. */
export interface LogicalModelGap {
  instanceId: string;
  reason: ModelAvailabilityReason;
}

export interface LogicalModel {
  modelId: string;
  displayName: string;
  /** Best-effort vendor of the first native source; undefined for multi-vendor harnesses. */
  vendor?: string | undefined;
  sources: LogicalModelSource[];
  gaps: LogicalModelGap[];
}

/**
 * Upstream provider label for a model-router route, following the MiniMax
 * rule: the connection (or vendor) that actually serves the model — never
 * the reserved `t3-router` bucket. Bare routes whose target is the router
 * itself get no label and fall back to the instance display name.
 */
export function routeSubProvider(route: ModelRouterRoute): string | undefined {
  if (route.target.kind === "connection") {
    // Neither reserved bucket is a provider label: the router itself nor the
    // harness-side backend bucket (legacy settings predate its reservation).
    if (route.target.connectionId === T3_ROUTER_CONNECTION_ID) return undefined;
    if (String(route.target.connectionId).toLowerCase() === "t3-backend") return undefined;
    return route.target.connectionId;
  }
  return route.target.vendor;
}

/**
 * How a driver's model ids relate to model backends, distilled once so the
 * catalog (and later the router) never special-cases drivers ad hoc:
 *
 *  - `endpoint-anthropic` — the harness speaks the Anthropic Messages API;
 *    custom endpoints plug in via `ANTHROPIC_BASE_URL` (claudeAgent).
 *  - `endpoint-openai` — the harness speaks the OpenAI API; custom endpoints
 *    plug in via its provider config (`model_providers` in config.toml)
 *    (codex), its endpoint env var (`DEEPSEEK_BASE_URL`) (deepseek), or its
 *    BYOK env set (`COPILOT_PROVIDER_BASE_URL`) (copilot).
 *  - `multi-provider` — the harness natively serves multiple vendors through
 *    its own configuration (opencode, pi, omp, hermes, openclaw, cline, kilo).
 *  - `vendor-locked` — model ids are restricted to the vendor's own set, so
 *    no connection can widen it (cursor, droid, devin, zcode, antigravity).
 *
 * Driver kinds are an open slug (forks ship their own); a driver missing from
 * the map is treated as `vendor-locked` at the read site — the conservative
 * default.
 */
export type ProviderModelBinding =
  | "vendor-locked"
  | "endpoint-anthropic"
  | "endpoint-openai"
  | "multi-provider";

export const MODEL_BINDING_BY_DRIVER: Record<string, ProviderModelBinding> = {
  claudeAgent: "endpoint-anthropic",
  codex: "endpoint-openai",
  deepseek: "endpoint-openai",
  opencode: "multi-provider",
  pi: "multi-provider",
  omp: "multi-provider",
  hermes: "multi-provider",
  openclaw: "multi-provider",
  cline: "multi-provider",
  kilo: "multi-provider",
  minimax: "multi-provider",
  cursor: "vendor-locked",
  copilot: "endpoint-openai",
  droid: "vendor-locked",
  devin: "vendor-locked",
  grok: "endpoint-openai",
  freebuff: "vendor-locked",
  zcode: "vendor-locked",
  antigravity: "vendor-locked",
};

/**
 * Maps a snapshot's `auth.type` onto the mode a routing UI must respect.
 * Only the API-key spellings are distinctive — every harness reports them
 * differently (Claude's tokenSource, Codex's account.type, env-var detection
 * on Grok/DeepSeek/Devin/Droid). Every other label — subscription plans,
 * cached tokens, OAuth — is harness-bound and cannot serve a model through a
 * generic endpoint.
 */
export function authModeFromAuth(auth: { type?: string | undefined } | undefined): ModelAuthMode {
  const type = auth?.type;
  if (type === undefined) return "unknown";
  return type === "apiKey" || type === "api_key" ? "api-key" : "subscription";
}

/**
 * Best-effort vendor slug for a driver, for grouping and display.
 * Single-vendor harnesses map to their vendor; multi-vendor harnesses
 * (opencode, pi, omp, hermes, cursor, …) and unknown drivers have no single
 * vendor and return undefined.
 */
export function vendorForDriver(driver: string): string | undefined {
  switch (driver) {
    case "codex":
      return "openai";
    case "claudeAgent":
      return "anthropic";
    case "grok":
      return "xai";
    case "deepseek":
      return "deepseek";
    case "antigravity":
      return "google";
    case "zcode":
      return "zai";
    default:
      return undefined;
  }
}

/**
 * An instance counts toward the catalog only when it can actually run turns.
 * `availability: "unavailable"` snapshots always carry `enabled: false` and
 * `installed: false` (contracts/server.ts), so missing drivers are covered.
 */
const isEligibleInstance = (snapshot: ServerProvider): boolean =>
  snapshot.enabled && snapshot.installed && snapshot.status !== "disabled";

interface ModelAccumulator {
  sources: LogicalModelSource[];
  gaps: LogicalModelGap[];
  /** Pairings already recorded, keyed `via\u0000instanceId` to drop duplicate slugs. */
  servedBy: Set<string>;
  /** Driver of the first native source in caller order; picks the model's vendor. */
  firstNativeDriver: string | undefined;
}

const viaRank = (via: LogicalModelSource["via"]): number => (via === "native" ? 0 : 1);

const compareSources = (a: LogicalModelSource, b: LogicalModelSource): number =>
  a.instanceId === b.instanceId
    ? viaRank(a.via) - viaRank(b.via)
    : a.instanceId < b.instanceId
      ? -1
      : 1;

const compareGaps = (a: LogicalModelGap, b: LogicalModelGap): number =>
  a.instanceId === b.instanceId ? 0 : a.instanceId < b.instanceId ? -1 : 1;

/**
 * Groups provider snapshots and model backend connections into logical
 * models. Sources are the pairings that work today; gaps name the eligible
 * instances that could serve the model but cannot yet, with the reason.
 * Output is deterministic: models by `modelId`, sources by `instanceId`
 * (native before connection), gaps by `instanceId`.
 */
export function deriveModelCatalog(input: {
  providers: ReadonlyArray<ServerProvider>;
  connections: ModelBackendConnections;
  /**
   * Per-instance link into `connections`, mirrored from
   * `ServerSettings.providerInstances` (`ProviderInstanceConfig.connectionId`).
   * Snapshots do not carry the link; without it no connection-provided model
   * becomes a source.
   */
  instanceConnections?: Readonly<Partial<Record<ProviderInstanceId, ModelBackendConnectionId>>>;
  /**
   * Callable model slugs served through the shared model router
   * (`ServerSettings.modelRouterRoutes` keys). An instance linked to the
   * reserved t3-router connection serves every route — through the proxy's
   * protocol translation, so no per-connection protocol check applies —
   * unless its driver is vendor-locked (those instances keep a gap instead
   * of a source they could never run).
   */
  routes?: ReadonlyArray<string>;
  /**
   * Per-route upstream label (see {@link routeSubProvider}). Keyed by route
   * slug so connection- and vendor-targeted routes render their provider
   * instead of the harness instance display name.
   */
  routeSubProviders?: Readonly<Record<string, string>>;
}): LogicalModel[] {
  const instanceConnections = input.instanceConnections ?? {};
  const routes = input.routes ?? [];
  const routeSubProviders = input.routeSubProviders ?? {};
  const eligible = input.providers.filter(isEligibleInstance);

  const grouped = new Map<string, ModelAccumulator>();
  const accumulatorFor = (slug: string): ModelAccumulator => {
    let accumulator = grouped.get(slug);
    if (!accumulator) {
      accumulator = { sources: [], gaps: [], servedBy: new Set(), firstNativeDriver: undefined };
      grouped.set(slug, accumulator);
    }
    return accumulator;
  };

  // Native sources first, in caller order: they define each model's display
  // name and vendor.
  for (const instance of eligible) {
    const authMode = authModeFromAuth(instance.auth);
    for (const entry of instance.models) {
      const accumulator = accumulatorFor(entry.slug);
      const key = `native\u0000${instance.instanceId}`;
      if (accumulator.servedBy.has(key)) continue;
      accumulator.servedBy.add(key);
      accumulator.sources.push({
        instanceId: instance.instanceId,
        model: entry.slug,
        via: "native",
        // Harness-bucket slugs (`t3-backend/<slug>`, owned by the server's
        // ModelBackendEnvironment) ride the backend key, never the
        // instance's own login — so they must not inherit a `subscription`
        // badge from instance auth.
        authMode: entry.slug.startsWith("t3-backend/") ? "unknown" : authMode,
        name: entry.name,
        ...(entry.subProvider ? { subProvider: entry.subProvider } : {}),
      });
      accumulator.firstNativeDriver ??= instance.driver;
    }
  }

  // Connection sources. Connections are API-key backed by design — only API
  // keys travel through the connections/credentials maps — so their pairings
  // are always `authMode: "api-key"`.
  for (const [connectionId, connection] of Object.entries(input.connections)) {
    for (const slug of connection.models ?? []) {
      for (const instance of eligible) {
        if (instanceConnections[instance.instanceId] !== connectionId) continue;
        const accumulator = accumulatorFor(slug);
        const key = `connection\u0000${instance.instanceId}`;
        if (accumulator.servedBy.has(key)) continue;
        accumulator.servedBy.add(key);
        accumulator.sources.push({
          instanceId: instance.instanceId,
          model: slug,
          via: "connection",
          authMode: "api-key",
          // Direct connection link: the connection itself is the upstream.
          // The reserved router bucket is never a provider label.
          ...(connectionId !== T3_ROUTER_CONNECTION_ID ? { subProvider: connectionId } : {}),
        });
      }
    }
  }

  // Router sources. Route slugs are callable through the shared proxy by any
  // instance linked to the reserved t3-router connection — except on
  // vendor-locked drivers, whose harness resolves slugs against its own
  // vendor API and could never run them. Auth rides the route's own target
  // (key, login, or keyless gateway), never the instance, so router sources
  // stay `unknown` here.
  for (const slug of routes) {
    for (const instance of eligible) {
      if (instanceConnections[instance.instanceId] !== T3_ROUTER_CONNECTION_ID) continue;
      if ((MODEL_BINDING_BY_DRIVER[instance.driver] ?? "vendor-locked") === "vendor-locked") {
        continue;
      }
      const accumulator = accumulatorFor(slug);
      const key = `connection\u0000${instance.instanceId}`;
      if (accumulator.servedBy.has(key)) continue;
      accumulator.servedBy.add(key);
      const subProvider = routeSubProviders[slug];
      accumulator.sources.push({
        instanceId: instance.instanceId,
        model: slug,
        via: "connection",
        authMode: "unknown",
        ...(subProvider ? { subProvider } : {}),
      });
    }
  }

  // Gaps: eligible instances with no source for the model. Connection- and
  // router-provided slugs become sources wherever the driver can run them,
  // so a remaining gap means a missing API key, a missing endpoint config,
  // or a vendor-locked harness.
  for (const accumulator of grouped.values()) {
    for (const instance of eligible) {
      if (
        accumulator.servedBy.has(`native\u0000${instance.instanceId}`) ||
        accumulator.servedBy.has(`connection\u0000${instance.instanceId}`)
      ) {
        continue;
      }
      const binding = MODEL_BINDING_BY_DRIVER[instance.driver] ?? "vendor-locked";
      accumulator.gaps.push({
        instanceId: instance.instanceId,
        reason: binding === "vendor-locked" ? "vendor-locked" : "requires-api-key",
      });
    }
  }

  return [...grouped.entries()]
    .map(([slug, accumulator]) => ({
      modelId: slug,
      displayName: accumulator.sources.find((source) => source.name !== undefined)?.name ?? slug,
      vendor:
        accumulator.firstNativeDriver === undefined
          ? undefined
          : vendorForDriver(accumulator.firstNativeDriver),
      sources: [...accumulator.sources].sort(compareSources),
      gaps: [...accumulator.gaps].sort(compareGaps),
    }))
    .sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
}

/**
 * Per-instance link into the model backend connections map, mirrored from
 * `settings.providerInstances[*].connectionId`. Single owner for the loop
 * web (`providerInstanceConnectionMap`) and mobile (`instanceConnectionMap`)
 * carried as copies; snapshots do not carry the link, so catalog derivation
 * needs it as its own input.
 */
export function connectionMapFromSettings(settings: {
  readonly providerInstances?:
    | Record<string, { readonly connectionId?: ModelBackendConnectionId | undefined } | undefined>
    | undefined;
}): Partial<Record<ProviderInstanceId, ModelBackendConnectionId>> {
  const out: Partial<Record<ProviderInstanceId, ModelBackendConnectionId>> = {};
  for (const [instanceId, instance] of Object.entries(settings.providerInstances ?? {})) {
    if (instance?.connectionId) {
      out[ProviderInstanceId.make(instanceId)] = instance.connectionId;
    }
  }
  return out;
}

/**
 * Per-route upstream labels for catalog derivation (see {@link routeSubProvider}).
 * Single owner for the loop web (`routeSubProvidersFromSettings`) and mobile
 * (`buildConnectionModelOptions`) carried inline.
 */
export function routeLabelsFromSettings(
  routes: Record<string, ModelRouterRoute> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slug, route] of Object.entries(routes ?? {})) {
    const subProvider = routeSubProvider(route);
    if (subProvider) out[slug] = subProvider;
  }
  return out;
}

/**
 * Logical models pooled across provider instances with the backend
 * connections and router routes from settings. Canonical hull around
 * {@link deriveModelCatalog} so web (`deriveAppModelCatalog`) and mobile
 * (`buildConnectionModelOptions`) share input normalization instead of
 * repeating it.
 */
export function resolveModelCatalog(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly connections: ModelBackendConnections;
  readonly providerInstances?: Record<
    string,
    { readonly connectionId?: ModelBackendConnectionId | undefined } | undefined
  >;
  readonly routes?: Record<string, ModelRouterRoute>;
}): LogicalModel[] {
  return deriveModelCatalog({
    providers: input.providers,
    connections: input.connections,
    instanceConnections: connectionMapFromSettings({ providerInstances: input.providerInstances }),
    routes: Object.keys(input.routes ?? {}),
    routeSubProviders: routeLabelsFromSettings(input.routes),
  });
}
