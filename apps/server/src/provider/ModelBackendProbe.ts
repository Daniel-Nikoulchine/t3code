import type { ModelBackendConfig, ServerTestModelBackendResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/** On-demand probe budget: a backend check must never stall the settings UI. */
export const MODEL_BACKEND_PROBE_TIMEOUT_MS = 4_000;

export interface ModelBackendProbeOutcome {
  readonly ok: boolean;
  readonly modelCount?: number | undefined;
  /** Slugs decoded from the `/models` payload; absent when none decoded. */
  readonly models?: ReadonlyArray<string> | undefined;
  readonly error?: string | undefined;
}

const ModelsListResponse = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
});

/**
 * Extract a model slug from one `/models` entry. OpenAI-compatible payloads
 * name the model `id`, Anthropic-compatible ones `model`; anything else is
 * skipped — the probe stays tolerant of unknown shapes.
 */
const slugFromModelEntry = (entry: unknown): string | undefined => {
  if (entry === null || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  for (const key of ["id", "model"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

const trimTrailingSlashes = (value: string): string => value.replace(/\/+$/, "");

/**
 * Probe an unpersisted backend config (usable before saving).
 *
 * - `native` resolves `{ ok: true }` without touching the network: there is
 *   no remote endpoint to check — the harness manages its own auth and
 *   models, so nothing about the passed config is verifiable here.
 * - `openai-compatible` performs `GET {baseUrl}/models`, attaching
 *   `Authorization: Bearer <key>` and `x-api-key: <key>` when a key exists
 *   (Anthropic-compatible endpoints read the latter; OpenAI-compatible ones
 *   ignore it). The key resolves to `backend.apiKey` first (a stored
 *   credential resolved at runtime) and falls back to `baseEnv[apiKeyEnv]`;
 *   keyless gateways are probed without headers instead of failing early.
 *
 * Secrets stay out of the outcome: transport errors can echo the request URL
 * (which may carry userinfo credentials) and must never surface the API key,
 * so every failure maps to a short status/timeout text — never URL, key,
 * body, or stacktrace. Interrupts still propagate so RPC shutdown stays
 * clean. Model decoding is tolerant: a reachable backend with an unexpected
 * payload shape is still `ok`, just without a count or slug list.
 */
export const testModelBackend = (
  backend: ModelBackendConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ModelBackendProbeOutcome> =>
  Effect.gen(function* () {
    if (backend.kind === "native") {
      return { ok: true as const };
    }
    const clientOption = yield* Effect.serviceOption(HttpClient.HttpClient);
    if (Option.isNone(clientOption)) {
      return { ok: false as const, error: "http client unavailable" };
    }
    const baseUrl = backend.baseUrl !== undefined ? trimTrailingSlashes(backend.baseUrl) : "";
    if (baseUrl.length === 0) {
      return { ok: false as const, error: "backend is missing baseUrl" };
    }
    // A stored credential (`apiKey`, resolved by the caller) wins over the
    // `apiKeyEnv` indirection.
    const apiKey =
      backend.apiKey ?? (backend.apiKeyEnv !== undefined ? baseEnv[backend.apiKeyEnv] : undefined);
    const authHeaders =
      typeof apiKey === "string" && apiKey.length > 0
        ? [
            HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
            HttpClientRequest.setHeader("x-api-key", apiKey),
          ]
        : [];
    const request = HttpClientRequest.get(`${baseUrl}/models`).pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      ...authHeaders,
    );
    const attempted = yield* Effect.exit(
      clientOption.value
        .execute(request)
        .pipe(Effect.timeoutOption(MODEL_BACKEND_PROBE_TIMEOUT_MS)),
    );
    if (Exit.isFailure(attempted)) {
      if (Cause.hasInterruptsOnly(attempted.cause)) {
        return yield* Effect.interrupt;
      }
      return { ok: false as const, error: "request failed" };
    }
    if (Option.isNone(attempted.value)) {
      return {
        ok: false as const,
        error: `request timed out after ${MODEL_BACKEND_PROBE_TIMEOUT_MS}ms`,
      };
    }
    const response = attempted.value.value;
    const okResponse = yield* response.pipe(
      HttpClientResponse.filterStatusOk,
      Effect.orElseSucceed(() => null),
    );
    if (okResponse === null) {
      return { ok: false as const, error: `request failed with status ${response.status}` };
    }
    const payload = yield* okResponse.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ModelsListResponse)),
      Effect.orElseSucceed(() => undefined),
    );
    if (payload === undefined) return { ok: true as const };
    const models = [
      ...new Set(payload.data.map(slugFromModelEntry).filter((slug) => slug !== undefined)),
    ];
    return {
      ok: true as const,
      modelCount: payload.data.length,
      ...(models.length > 0 ? { models } : {}),
    };
  });

/**
 * RPC-facing wrapper: the probe outcome plus the Effect-clock check time
 * the `ServerTestModelBackendResult` contract requires.
 */
export const testModelBackendResult = (
  backend: ModelBackendConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.Effect<ServerTestModelBackendResult> =>
  Effect.gen(function* () {
    const probe = yield* testModelBackend(backend, baseEnv);
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return { ...probe, checkedAt };
  });
