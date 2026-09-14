import type { ModelBackendConfig, ModelProxyProtocol } from "@t3tools/contracts";

// Defensive fallback for hand-built configs; the schema normally fills this
// default on decode.
const DEFAULT_PROTOCOLS: ReadonlyArray<ModelProxyProtocol> = ["openai", "anthropic"];

/**
 * Returns a pure overlay, never a full env. Merge as
 * `{ ...mergeProviderInstanceEnvironment(environment), ...resolveModelBackendEnvironment(backend, process.env) }`
 * so the backend overlay wins on conflicts. Never mutates `baseEnv`.
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
  if (!backend || backend.kind === "native") return {};
  const overlay: NodeJS.ProcessEnv = {};
  const protocols = backend.protocols ?? DEFAULT_PROTOCOLS;
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
