import type { ModelBackendConfig, ModelProxyProtocol } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { isNativeBackend } from "./ModelBackendEnvironment.ts";

const ValidationError = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
    type: Schema.optional(Schema.String),
    param: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

/** Probe validation, not inference: no model or messages are sent, so no tokens are generated.
 * Auth failures, generic gateway errors, and catch-all HTML are inconclusive.
 */
export const detectModelBackendProtocols = Effect.fn("detectModelBackendProtocols")(function* (
  backend: ModelBackendConfig,
  baseEnv: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  if (isNativeBackend(backend) || !backend.baseUrl) return [];
  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(client)) return [];
  const baseUrl = backend.baseUrl.replace(/\/+$/, "");
  const apiKey = backend.apiKey ?? (backend.apiKeyEnv ? baseEnv[backend.apiKeyEnv] : undefined);
  const endpoints: ReadonlyArray<readonly [ModelProxyProtocol, string]> = [
    ["openai", "chat/completions"],
    ["openai", "responses"],
    ["anthropic", "messages"],
  ];
  const detected = yield* Effect.forEach(
    endpoints,
    ([protocol, path]) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(`${baseUrl}/${path}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({}),
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.setHeaders({
            ...(protocol === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
            ...(apiKey
              ? protocol === "anthropic"
                ? { "x-api-key": apiKey }
                : { authorization: `Bearer ${apiKey}` }
              : {}),
          }),
        );
        const result = yield* Effect.exit(
          Effect.gen(function* () {
            const response = yield* client.value.execute(request);
            if (response.status !== 400 && response.status !== 422) return false;
            const payload = yield* response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(ValidationError)),
            );
            const error = payload.error;
            // Both APIs validate these required fields before attempting inference.
            return (
              /\b(model|messages|input)\b/i.test(error.param ?? error.message) &&
              /required|missing|must (?:provide|specify)|field required/i.test(error.message)
            );
          }).pipe(Effect.timeoutOption(timeoutMs)),
        );
        if (Exit.isFailure(result)) {
          if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.interrupt;
          return undefined;
        }
        return Option.isSome(result.value) && result.value.value ? protocol : undefined;
      }),
    { concurrency: "unbounded" },
  );
  const protocols = [...new Set(detected.filter((protocol) => protocol !== undefined))];
  return protocols;
});
