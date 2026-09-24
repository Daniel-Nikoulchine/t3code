import type { ModelBackendConfig, ModelProxyProtocol } from "@t3tools/contracts";

/**
 * Default wire protocols for a backend that declares none. Single owner for
 * the default: drivers, the OpenCode runtime, and home layouts read this
 * instead of repeating the literal, so a default change lands everywhere.
 * (The router resolves protocols differently — subset match, not default —
 * and stays independent on purpose.)
 */
export const DEFAULT_BACKEND_PROTOCOLS: ReadonlyArray<ModelProxyProtocol> = ["openai", "anthropic"];

/** Harness bucket for backend-wired instances. Single owner for the `"t3-backend"` literal. */
export const BACKEND_BUCKET_PROVIDER_ID = "t3-backend" as const;

/** True when there is no remote endpoint to speak to (undefined) or the harness owns auth/models itself. */
export const isNativeBackend = (backend: ModelBackendConfig | undefined): boolean =>
  backend === undefined || backend.kind === "native";

/** Narrows to a remote backend (defined and not native) for drivers that use it afterwards. */
export const isUsableBackend = (
  backend: ModelBackendConfig | undefined,
): backend is ModelBackendConfig => backend !== undefined && backend.kind !== "native";

/** True for the synthesized router connection, which carries route keys instead of `models`. */
export const isRouterBackend = (backend: ModelBackendConfig | undefined): boolean =>
  backend !== undefined && backend.kind === "t3-router";

/** True for the harness bucket id, never a real model provider. */
export const isBackendBucketProviderId = (provider: string | undefined): boolean =>
  provider === BACKEND_BUCKET_PROVIDER_ID;

/** True for `t3-backend/<slug>` custom-model paths. */
export const isBackendBucketSlug = (slug: string): boolean =>
  slug.startsWith(`${BACKEND_BUCKET_PROVIDER_ID}/`);

/**
 * Strip every leading `t3-backend/` segment; returns the input unchanged
 * when not a bucket slug. Loops (instead of stripping once) so an already
 * prefixed slug copied from the picker into a connection's model list
 * (`t3-backend/t3-backend/<slug>`) degrades to the bare slug instead of
 * surfacing the bucket as its own upstream label downstream.
 */
export const stripBackendBucketPrefix = (slug: string): string => {
  let stripped = slug;
  while (isBackendBucketSlug(stripped)) {
    stripped = stripped.slice(BACKEND_BUCKET_PROVIDER_ID.length + 1);
  }
  return stripped;
};

/**
 * Model slugs a backend serves, per wire protocol: the ones the connection
 * declares, or — for the synthesized `t3-router` connection, which carries no
 * `models` of its own — the router's route keys. An endpoint that cannot
 * speak the harness's wire protocol serves nothing here, matching the env
 * overlay's gate, so a caller never lists a slug the harness cannot call.
 *
 * Pure; exported for the harness drivers that must publish these slugs into
 * their own model surface (OpenCode-style provider config, custom-model
 * lists).
 */
export function resolveBackendModelSlugs(input: {
  readonly backend: ModelBackendConfig | undefined;
  readonly routeKeys: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const { backend, routeKeys } = input;
  if (!isUsableBackend(backend)) return [];
  if (!(backend.protocols ?? DEFAULT_BACKEND_PROTOCOLS).includes("openai")) return [];
  if (backend.baseUrl === undefined || backend.baseUrl.length === 0) return [];
  // Connection model lists are hand-authored and may hold slugs already
  // copied from the picker with the harness bucket prefix. Strip it (and
  // dedupe) so wiring never registers `t3-backend/t3-backend/<slug>` ids
  // that would surface the bucket as its own provider label.
  const sanitize = (slugs: ReadonlyArray<string>): Array<string> => [
    ...new Set(
      slugs.map((slug) => stripBackendBucketPrefix(slug)).filter((slug) => slug.length > 0),
    ),
  ];
  return isRouterBackend(backend) ? sanitize(routeKeys) : sanitize(backend.models ?? []);
}

/**
 * Returns a pure overlay, never a full env. Drivers should prefer
 * `resolveHarnessProcessEnv` in `harnessMaterial.ts`, which fixes the merge
 * order (`{ ...instanceEnv, ...backendOverlay }`, backend wins) in one seam
 * instead of hand-spreading this result. Never mutates `baseEnv`.
 *
 * Only the variable pairs of the backend's declared `protocols` are set;
 * the default (both) reproduces the historical dual-pair overlay. An
 * endpoint that speaks only one wire protocol must not receive the other
 * harness's variables.
 *
 * The key resolves to `backend.apiKey` (runtime-resolved from a stored
 * credential or an inline probe request) first, then to `baseEnv[apiKeyEnv]`
 * — `apiKeyEnv` is only a variable name, the value always comes from
 * `baseEnv`, never from settings. An empty resolved value counts as "no
 * key". `baseEnv` stays explicit on purpose (no `process.env` default);
 * callers pass it in.
 */
export function resolveModelBackendEnvironment(
  backend: ModelBackendConfig | undefined,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!isUsableBackend(backend)) return {};
  const overlay: NodeJS.ProcessEnv = {};
  const protocols = backend.protocols ?? DEFAULT_BACKEND_PROTOCOLS;
  const apiKey =
    backend.apiKey ?? (backend.apiKeyEnv !== undefined ? baseEnv[backend.apiKeyEnv] : undefined);
  if (protocols.includes("openai")) {
    if (backend.baseUrl) {
      overlay.OPENAI_BASE_URL = backend.baseUrl;
    }
    if (apiKey !== undefined && apiKey.length > 0) {
      overlay.OPENAI_API_KEY = apiKey;
    }
  }
  if (protocols.includes("anthropic")) {
    if (backend.baseUrl) {
      overlay.ANTHROPIC_BASE_URL = backend.baseUrl;
    }
    if (apiKey !== undefined && apiKey.length > 0) {
      overlay.ANTHROPIC_API_KEY = apiKey;
    }
  }
  return overlay;
}

/**
 * Declarative single-env backend overlay for harnesses that read their
 * endpoint from their own variable pair instead of the generic `OPENAI_*`
 * pair (Copilot `COPILOT_PROVIDER_*`, dsh `DEEPSEEK_*`). One table row per
 * harness replaces one `resolve*BackendEnvironment` copy; file/config
 * injection harnesses (Grok shadow home, Kilo/OpenCode config merge,
 * Pi extension file) stay custom on purpose — their wiring is not an env
 * pair.
 */
export interface BackendOverlayDecl {
  readonly baseUrlEnv: string;
  readonly apiKeyEnv?: string;
  readonly fixed?: Readonly<Record<string, string>>;
}

export const BACKEND_OVERLAYS = {
  copilot: {
    baseUrlEnv: "COPILOT_PROVIDER_BASE_URL",
    apiKeyEnv: "COPILOT_PROVIDER_API_KEY",
    fixed: { COPILOT_PROVIDER_TYPE: "openai" },
  },
  deepseek: { baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY" },
} as const satisfies Record<string, BackendOverlayDecl>;

/**
 * Shared gate + key resolution for single-env overlays: usable backend,
 * non-empty baseUrl, OpenAI wire only (Anthropic-only endpoints leave the
 * instance on its own login instead of flipping it into a mode whose models
 * could never resolve). Returns `{}` when the overlay does not apply.
 */
export function resolveDeclaredBackendOverlay(
  decl: BackendOverlayDecl,
  backend: ModelBackendConfig | undefined,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!isUsableBackend(backend)) return {};
  if (backend.baseUrl === undefined || backend.baseUrl.length === 0) return {};
  if (!(backend.protocols ?? DEFAULT_BACKEND_PROTOCOLS).includes("openai")) return {};
  const apiKey =
    backend.apiKey ?? (backend.apiKeyEnv !== undefined ? baseEnv[backend.apiKeyEnv] : undefined);
  const overlay: NodeJS.ProcessEnv = {
    [decl.baseUrlEnv]: backend.baseUrl,
    ...decl.fixed,
  };
  if (decl.apiKeyEnv !== undefined && apiKey !== undefined && apiKey.length > 0) {
    overlay[decl.apiKeyEnv] = apiKey;
  }
  return overlay;
}
