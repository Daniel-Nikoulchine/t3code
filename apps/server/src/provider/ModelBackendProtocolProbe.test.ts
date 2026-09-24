import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { testModelBackendResult, MODEL_BACKEND_PROBE_TIMEOUT_MS } from "./ModelBackendProbe.ts";

const backend = {
  kind: "openai-compatible" as const,
  baseUrl: "https://gateway.example/v1/",
  apiKey: "stored-key",
};
const validation = { error: { type: "invalid_request_error", message: "model: Field required" } };

describe("protocol detection through the backend RPC result", () => {
  for (const [paths, expected] of [
    [["chat/completions"], ["openai"]],
    [["responses"], ["openai"]],
    [["messages"], ["anthropic"]],
    [
      ["chat/completions", "messages"],
      ["openai", "anthropic"],
    ],
  ] as const) {
    it.effect(`detects ${paths.join(" and ")} without requiring a model list`, () =>
      Effect.gen(function* () {
        const client = HttpClient.make((request) => {
          const supported = paths.some((path) => request.url.endsWith(`/${path}`));
          if (request.method === "POST") {
            assert.strictEqual(request.body._tag, "Uint8Array");
            if (request.body._tag === "Uint8Array")
              assert.strictEqual(new TextDecoder().decode(request.body.body), "{}");
            if (request.url.endsWith("/messages")) {
              assert.strictEqual(request.headers["x-api-key"], "stored-key");
              assert.strictEqual(request.headers["anthropic-version"], "2023-06-01");
            } else {
              assert.strictEqual(request.headers.authorization, "Bearer stored-key");
            }
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(supported ? validation : {}, { status: supported ? 400 : 404 }),
            ),
          );
        });
        const result = yield* testModelBackendResult(backend, {}).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        assert.deepStrictEqual(result.protocols, expected);
      }),
    );
  }

  for (const status of [200, 401, 403, 404, 405, 429, 500]) {
    it.effect(`does not infer support from status ${status}`, () =>
      Effect.gen(function* () {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, Response.json(validation, { status })),
          ),
        );
        const result = yield* testModelBackendResult(backend, {}).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        assert.deepStrictEqual(result.protocols, []);
      }),
    );
  }

  it.effect("ignores generic validation errors and HTML fallbacks", () =>
    Effect.gen(function* () {
      for (const body of ['{"error":{"message":"Bad request"}}', "<html>Not found</html>"]) {
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 400 }))),
        );
        const result = yield* testModelBackendResult(backend, {}).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        assert.deepStrictEqual(result.protocols, []);
      }
    }),
  );

  it.effect("bounds stalled response body reads", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) => {
        const response = HttpClientResponse.fromWeb(
          request,
          Response.json(
            {},
            {
              status: request.method === "GET" ? 200 : 400,
            },
          ),
        );
        Object.defineProperty(response, "json", { value: Effect.never });
        return Effect.succeed(response);
      });
      const fiber = yield* testModelBackendResult(backend, {}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkScoped,
      );
      yield* TestClock.adjust(MODEL_BACKEND_PROBE_TIMEOUT_MS + 1);
      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(result.protocols, []);
      assert.strictEqual(result.ok, false);
      assert.match(result.error ?? "", /timed out/);
    }),
  );

  it.effect("bounds stalled requests", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.never);
      const fiber = yield* testModelBackendResult(backend, {}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkScoped,
      );
      yield* TestClock.adjust(MODEL_BACKEND_PROBE_TIMEOUT_MS + 1);
      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(result.protocols, []);
    }),
  );
});
