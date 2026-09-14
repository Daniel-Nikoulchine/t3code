import type { ModelBackendConfig } from "@t3tools/contracts";
import { ModelBackendConfig as ModelBackendConfigSchema } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Headers, HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  MODEL_BACKEND_PROBE_TIMEOUT_MS,
  testModelBackend,
  testModelBackendResult,
} from "./ModelBackendProbe.ts";

const nativeBackend: ModelBackendConfig = { kind: "native" };
const gatewayBackend: ModelBackendConfig = {
  kind: "openai-compatible",
  baseUrl: "https://gateway.example/v1/",
  apiKeyEnv: "GATEWAY_API_KEY",
};

const jsonClient = (
  payload: unknown,
  status = 200,
  onRequest?: (input: {
    readonly url: string;
    readonly authorization: string | undefined;
    readonly xApiKey: string | undefined;
  }) => void,
) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(payload, { status }))).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          onRequest?.({
            url: request.url,
            authorization: Option.getOrUndefined(Headers.get(request.headers, "authorization")),
            xApiKey: Option.getOrUndefined(Headers.get(request.headers, "x-api-key")),
          }),
        ),
      ),
    ),
  );

describe("testModelBackend", () => {
  it.effect("reports native backends as ok without touching the network", () =>
    Effect.gen(function* () {
      // No HttpClient layer is provided on purpose: a native probe must not
      // need one.
      const result = yield* testModelBackend(nativeBackend);

      assert.deepStrictEqual(result, { ok: true });
    }),
  );

  it.effect("counts and lists models from an openai-compatible gateway", () =>
    Effect.gen(function* () {
      const seen: Array<{
        url: string;
        authorization: string | undefined;
        xApiKey: string | undefined;
      }> = [];
      const client = jsonClient(
        { data: [{ id: "a" }, { id: "b" }, { id: "c" }] },
        200,
        (request) => {
          seen.push({
            url: request.url,
            authorization: request.authorization,
            xApiKey: request.xApiKey,
          });
        },
      );

      const result = yield* testModelBackend(gatewayBackend, {
        GATEWAY_API_KEY: "sk-test-key",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.deepStrictEqual(result, {
        ok: true,
        modelCount: 3,
        models: ["a", "b", "c"],
      });
      assert.deepStrictEqual(
        seen.map((entry) => entry.url),
        ["https://gateway.example/v1/models"],
      );
      assert.deepStrictEqual(
        seen.map((entry) => entry.authorization),
        ["Bearer sk-test-key"],
      );
      // Anthropic-compatible endpoints authenticate via x-api-key; sending it
      // alongside the bearer token is what makes one probe cover both.
      assert.deepStrictEqual(
        seen.map((entry) => entry.xApiKey),
        ["sk-test-key"],
      );
    }),
  );

  it.effect("decodes model slugs from id and model fields, tolerating unknown entries", () =>
    Effect.gen(function* () {
      const client = jsonClient({
        data: [
          { id: "gpt-5" },
          { model: "claude-sonnet-4" },
          { id: "gpt-5" }, // duplicate slug — deduped
          { id: 42 }, // non-string — skipped
          { unrelated: true }, // no slug — skipped
          "junk", // not an object — skipped
        ],
      });

      const result = yield* testModelBackend(gatewayBackend, {
        GATEWAY_API_KEY: "sk-test-key",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.deepStrictEqual(result, {
        ok: true,
        modelCount: 6,
        models: ["gpt-5", "claude-sonnet-4"],
      });
    }),
  );

  it.effect("omits models when the payload carries none", () =>
    Effect.gen(function* () {
      const client = jsonClient({ data: [] });

      const result = yield* testModelBackend(gatewayBackend, {}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      assert.deepStrictEqual(result, { ok: true, modelCount: 0 });
    }),
  );

  it.effect("probes keyless gateways without an authorization header", () =>
    Effect.gen(function* () {
      const seen: Array<{ authorization: string | undefined; xApiKey: string | undefined }> = [];
      const client = jsonClient({ data: [{ id: "a" }] }, 200, (request) => {
        seen.push({ authorization: request.authorization, xApiKey: request.xApiKey });
      });

      const result = yield* testModelBackend(
        { kind: "openai-compatible", baseUrl: "https://open.example/v1" },
        {},
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.deepStrictEqual(result, { ok: true, modelCount: 1, models: ["a"] });
      assert.deepStrictEqual(seen, [{ authorization: undefined, xApiKey: undefined }]);
    }),
  );

  it.effect("sends a resolved credential apiKey as the bearer token", () =>
    Effect.gen(function* () {
      const seen: Array<string | undefined> = [];
      const client = jsonClient({ data: [{ id: "a" }] }, 200, (request) => {
        seen.push(request.authorization);
      });

      const result = yield* testModelBackend(
        { kind: "openai-compatible", baseUrl: "https://open.example/v1", apiKey: "sk-stored" },
        {},
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.deepStrictEqual(result, { ok: true, modelCount: 1, models: ["a"] });
      assert.deepStrictEqual(seen, ["Bearer sk-stored"]);
    }),
  );

  it.effect("prefers a resolved credential apiKey over the apiKeyEnv lookup", () =>
    Effect.gen(function* () {
      const seen: Array<string | undefined> = [];
      const client = jsonClient({ data: [{ id: "a" }] }, 200, (request) => {
        seen.push(request.authorization);
      });

      const result = yield* testModelBackend(
        {
          kind: "openai-compatible",
          baseUrl: "https://open.example/v1",
          apiKey: "sk-stored",
          apiKeyEnv: "GATEWAY_API_KEY",
        },
        { GATEWAY_API_KEY: "sk-from-env" },
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.deepStrictEqual(result, { ok: true, modelCount: 1, models: ["a"] });
      assert.deepStrictEqual(seen, ["Bearer sk-stored"]);
    }),
  );

  it.effect("reports non-2xx statuses without leaking secrets", () =>
    Effect.gen(function* () {
      const secretKey = "sk-super-secret-key";
      const client = jsonClient({ error: "internal explosion" }, 500);

      const result = yield* testModelBackend(
        {
          kind: "openai-compatible",
          baseUrl: "https://operator:s3cret-pw@gateway.example/v1",
          apiKeyEnv: "GATEWAY_API_KEY",
        },
        { GATEWAY_API_KEY: secretKey },
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.strictEqual(result.ok, false);
      assert.match(result.error ?? "", /500/);
      assert.notMatch(result.error ?? "", new RegExp(secretKey));
      assert.notMatch(result.error ?? "", /s3cret-pw/);
      assert.notMatch(result.error ?? "", /operator/);
    }),
  );

  it.effect("reports transport failures without leaking error details", () =>
    Effect.gen(function* () {
      const secretKey = "sk-super-secret-key";
      const client = HttpClient.make(() =>
        Effect.die(new Error(`socket hang up using key ${secretKey}`)),
      );

      const result = yield* testModelBackend(gatewayBackend, {
        GATEWAY_API_KEY: secretKey,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.strictEqual(result.ok, false);
      assert.ok((result.error ?? "").length > 0);
      assert.notMatch(result.error ?? "", new RegExp(secretKey));
    }),
  );

  it.effect("reports timeouts as not-ok", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() => Effect.never);

      const fiber = yield* testModelBackend(gatewayBackend, {}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(MODEL_BACKEND_PROBE_TIMEOUT_MS + 1_000);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(result.ok, false);
      assert.match(result.error ?? "", /timed out/);
    }),
  );

  it.effect("stays ok when the models payload has an unexpected shape", () =>
    Effect.gen(function* () {
      for (const payload of [{ unexpected: true }, { data: { id: "a" } }, null]) {
        const result = yield* testModelBackend(gatewayBackend, {}).pipe(
          Effect.provideService(HttpClient.HttpClient, jsonClient(payload)),
        );

        assert.deepStrictEqual(result, { ok: true });
      }
    }),
  );

  it("rejects an openai-compatible backend without baseUrl at the schema boundary", () => {
    const decodeConfig = Schema.decodeUnknownSync(ModelBackendConfigSchema);

    assert.throws(() => decodeConfig({ kind: "openai-compatible" }));
  });

  it.effect("stamps the probe outcome with the check time", () =>
    Effect.gen(function* () {
      const result = yield* testModelBackendResult(nativeBackend);

      assert.strictEqual(result.ok, true);
      assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    }),
  );
});
