/**
 * PiBackend — model-backend (shared API connection / t3-router) wiring for Pi.
 *
 * Pi has no endpoint flag for custom models: custom providers come from
 * `models.json` or an extension calling `pi.registerProvider()` (verified
 * against the installed `pi` docs `models.md` / `custom-provider.md`). A
 * linked backend therefore injects a T3-owned `t3-backend` provider through
 * a generated extension file passed via `pi --extension`, so the backend's
 * models become selectable as `t3-backend/<slug>` with no Pi `/login`.
 *
 * The key never lands in the file: real keys travel as
 * `PI_T3_BACKEND_API_KEY` in the spawned env and the extension references
 * `$PI_T3_BACKEND_API_KEY` (the same `$ENV_VAR` syntax `models.json`
 * uses). Only the non-secret `t3-router` placeholder is a literal.
 *
 * @module provider/Drivers/PiBackend
 */
import type { ModelBackendConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import {
  BACKEND_BUCKET_PROVIDER_ID,
  DEFAULT_BACKEND_PROTOCOLS,
  isUsableBackend,
  resolveBackendModelSlugs,
} from "../ModelBackendEnvironment.ts";

/** Provider id T3 owns inside Pi; models are `t3-backend/<slug>`. */
export const PI_BACKEND_PROVIDER_ID = BACKEND_BUCKET_PROVIDER_ID;

/** Env var carrying the backend key into the spawned Pi process. */
export const PI_BACKEND_API_KEY_ENV = "PI_T3_BACKEND_API_KEY";

/**
 * Placeholder key for a `t3-router` backend without a stored key. The
 * router authenticates upstream itself and ignores what the harness sends,
 * so a placeholder keeps Pi from demanding a login it never needs (same
 * reasoning as the Grok driver's router entries).
 */
export const PI_BACKEND_API_KEY_PLACEHOLDER = "t3-router";

const PI_BACKEND_API = "openai-completions" as const;

export interface PiBackendWiring {
  /** Bare route/model keys served through the `t3-backend` provider. */
  readonly slugs: ReadonlyArray<string>;
  /** Picker slugs (`t3-backend/<slug>`) appended to the instance catalog. */
  readonly customModels: ReadonlyArray<string>;
  /** Generated extension source registering the provider. */
  readonly extensionContent: string;
  /**
   * Env overlay for the spawned Pi process. Carries the real key only;
   * empty when the extension uses the placeholder.
   */
  readonly envOverlay: NodeJS.ProcessEnv;
  /** `apiKey` value embedded in the extension (`$VAR` ref or placeholder). */
  readonly apiKeyRef: string;
}

export function buildPiBackendExtensionContent(input: {
  readonly baseUrl: string;
  readonly apiKeyRef: string;
  readonly slugs: ReadonlyArray<string>;
}): string {
  const models = input.slugs.map((slug) => ({
    id: slug,
    name: slug,
    // Extended thinking, pi style: the level map marks which pi levels the
    // model offers (`null` hides), `supportsReasoningEffort` makes pi send
    // the mapped value as top-level `reasoning_effort`, which the t3-router
    // translates for Responses upstreams and passes through elsewhere.
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    compat: { supportsReasoningEffort: true },
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
  }));
  return `// Managed by T3 Code model routing; do not edit.
export default function (pi) {
  pi.registerProvider(${JSON.stringify(PI_BACKEND_PROVIDER_ID)}, {
    baseUrl: ${JSON.stringify(input.baseUrl)},
    apiKey: ${JSON.stringify(input.apiKeyRef)},
    api: ${JSON.stringify(PI_BACKEND_API)},
    models: ${JSON.stringify(models)},
  });
};
`;
}

/**
 * Resolve the backend wiring for a Pi instance. Returns `undefined` when
 * the instance stays native: no backend, a `native` backend, an
 * Anthropic-only endpoint Pi cannot speak over this wire, a missing
 * base URL, or no servable slugs. A direct backend without a resolvable
 * key also stays native — listing models Pi could never call would be a
 * half-visible picker entry.
 *
 * Pure; exported for unit tests.
 */
export function resolvePiBackendWiring(input: {
  readonly backend: ModelBackendConfig | undefined;
  readonly routeKeys: ReadonlyArray<string>;
  readonly baseEnv: NodeJS.ProcessEnv;
}): PiBackendWiring | undefined {
  const { backend, routeKeys, baseEnv } = input;
  if (!isUsableBackend(backend)) return undefined;
  if (!(backend.protocols ?? DEFAULT_BACKEND_PROTOCOLS).includes("openai")) return undefined;
  const baseUrl = backend.baseUrl;
  if (baseUrl === undefined || baseUrl.length === 0) return undefined;
  const slugs = resolveBackendModelSlugs({ backend, routeKeys });
  if (slugs.length === 0) return undefined;
  const apiKey =
    backend.apiKey ?? (backend.apiKeyEnv !== undefined ? baseEnv[backend.apiKeyEnv] : undefined);
  if (apiKey !== undefined && apiKey.length > 0) {
    return {
      slugs,
      customModels: slugs.map((slug) => `${PI_BACKEND_PROVIDER_ID}/${slug}`),
      extensionContent: buildPiBackendExtensionContent({
        baseUrl,
        apiKeyRef: `$${PI_BACKEND_API_KEY_ENV}`,
        slugs,
      }),
      envOverlay: { [PI_BACKEND_API_KEY_ENV]: apiKey },
      apiKeyRef: `$${PI_BACKEND_API_KEY_ENV}`,
    };
  }
  if (backend.kind !== "t3-router") return undefined;
  return {
    slugs,
    customModels: slugs.map((slug) => `${PI_BACKEND_PROVIDER_ID}/${slug}`),
    extensionContent: buildPiBackendExtensionContent({
      baseUrl,
      apiKeyRef: PI_BACKEND_API_KEY_PLACEHOLDER,
      slugs,
    }),
    envOverlay: {},
    apiKeyRef: PI_BACKEND_API_KEY_PLACEHOLDER,
  };
}

export const ensurePiBackendExtension = Effect.fn("ensurePiBackendExtension")(function* (input: {
  readonly baseDir: string;
  readonly instanceId: string;
  readonly content: string;
}): Effect.fn.Return<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(input.baseDir, "pi-extensions", input.instanceId);
  yield* fileSystem.makeDirectory(dir, { recursive: true });
  const filePath = path.join(dir, "t3-backend.js");
  yield* fileSystem.writeFileString(filePath, input.content);
  return filePath;
});
