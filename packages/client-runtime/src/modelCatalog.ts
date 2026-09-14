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
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";

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
 * How a driver's model ids relate to model backends, distilled once so the
 * catalog (and later the router) never special-cases drivers ad hoc:
 *
 *  - `endpoint-anthropic` — the harness speaks the Anthropic Messages API;
 *    custom endpoints plug in via `ANTHROPIC_BASE_URL` (claudeAgent).
 *  - `endpoint-openai` — the harness speaks the OpenAI API; custom endpoints
 *    plug in via its provider config (`model_providers` in config.toml)
 *    (codex).
 *  - `multi-provider` — the harness natively serves multiple vendors through
 *    its own configuration (opencode, pi, omp, hermes, openclaw, cline, kilo).
 *  - `vendor-locked` — model ids are restricted to the vendor's own set, so
 *    no connection can widen it (cursor, copilot, droid, devin, grok,
 *    deepseek, zcode, antigravity).
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
  opencode: "multi-provider",
  pi: "multi-provider",
  omp: "multi-provider",
  hermes: "multi-provider",
  openclaw: "multi-provider",
  cline: "multi-provider",
  kilo: "multi-provider",
  cursor: "vendor-locked",
  copilot: "vendor-locked",
  droid: "vendor-locked",
  devin: "vendor-locked",
  grok: "vendor-locked",
  deepseek: "vendor-locked",
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
}): LogicalModel[] {
  const instanceConnections = input.instanceConnections ?? {};
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
        authMode,
        name: entry.name,
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
        });
      }
    }
  }

  // Gaps: eligible instances with no source for the model. Connection-
  // provided slugs always become sources, so an endpoint-speakable slug
  // without a source means no linked connection provides it — what is
  // missing is an API key (plus, for endpoint harnesses, the endpoint
  // config), not protocol support.
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
