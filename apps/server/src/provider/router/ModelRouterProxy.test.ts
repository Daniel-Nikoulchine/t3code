// This integration test asserts raw wire JSON and stubs a real HTTP
// upstream, so the general Effect-side HTTP/JSON diagnostics are off for the
// file.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetchInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import { ModelBackendConnections, ModelCredentials, ModelRouterRoutes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import * as NodeHttp from "node:http";

import { ServerSettingsService } from "../../serverSettings.ts";
import { ModelRouterProxy, modelRouterProxyLayer } from "./ModelRouterProxy.ts";

// ── stub upstream: node http on an ephemeral loopback port ──────────────────

interface StubUpstream {
  readonly origin: string;
  readonly requests: Array<{
    readonly url: string | undefined;
    readonly headers: NodeHttp.IncomingHttpHeaders;
    readonly body: string;
  }>;
  readonly close: () => Promise<void>;
}

const startStubUpstream = (
  respond: (
    res: NodeHttp.ServerResponse,
    request: { readonly url: string | undefined; readonly body: string },
  ) => void,
): Promise<StubUpstream> =>
  new Promise((resolve, reject) => {
    const requests: StubUpstream["requests"] = [];
    const server = NodeHttp.createServer((req, res) => {
      const chunks: Array<Buffer> = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ url: req.url, headers: req.headers, body });
        respond(res, { url: req.url, body });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("stub upstream failed to bind a TCP port"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });

// ── proxy under test: settings via layerTest, ephemeral listener port ───────

const decodeRoutes = Schema.decodeUnknownSync(ModelRouterRoutes);
const decodeConnections = Schema.decodeUnknownSync(ModelBackendConnections);
const decodeCredentials = Schema.decodeUnknownSync(ModelCredentials);

const makeProxyLayer = (input: {
  readonly routes: unknown;
  readonly connections: unknown;
  readonly credentials?: unknown;
}) =>
  modelRouterProxyLayer({ port: 0 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettingsService.layerTest({
          modelRouterRoutes: decodeRoutes(input.routes),
          modelBackendConnections: decodeConnections(input.connections),
          ...(input.credentials === undefined
            ? {}
            : { modelCredentials: decodeCredentials(input.credentials) }),
        }),
        FetchHttpClient.layer,
      ),
    ),
  );

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  Effect.promise(() =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }).then((response) => response.text().then((text) => ({ status: response.status, text }))),
  );

const get = (url: string) =>
  Effect.promise(() =>
    fetch(url).then((response) =>
      response.text().then((text) => ({ status: response.status, text })),
    ),
  );

describe("ModelRouterProxy", () => {
  it.effect("same-protocol pass-through preserves the body bytes and substitutes auth", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"id":"chatcmpl-stub","choices":[{"message":{"content":"ok"}}]}');
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: { "routed-gpt": { target: { kind: "connection", connectionId: "stub" } } },
          connections: {
            stub: { baseUrl: stub.origin, apiKeyCredentialId: "cred" },
          },
          credentials: {
            cred: { displayName: "Stub key", vendor: "openai", value: "sk-stub-123" },
          },
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));
      expect(router.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const sent = {
        model: "routed-gpt",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      };
      const response = yield* post(`${router.baseUrl}/openai/v1/chat/completions`, sent);
      expect(response.status).toBe(200);
      // Byte-faithful relay of the stub's response body.
      expect(response.text).toBe('{"id":"chatcmpl-stub","choices":[{"message":{"content":"ok"}}]}');

      expect(stub.requests).toHaveLength(1);
      const upstream = stub.requests[0]!;
      expect(upstream.url).toBe("/chat/completions");
      expect(upstream.body).toBe(JSON.stringify(sent));
      expect(upstream.headers["authorization"]).toBe("Bearer sk-stub-123");
      expect(upstream.headers["anthropic-version"]).toBeUndefined();
      // The harness's own credentials never travel upstream; the proxy
      // substitutes the route's resolved key instead.
      expect(upstream.body).not.toContain("Bearer");
    }),
  );

  it.effect("cross-protocol translation lands (anthropic in, openai upstream)", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                id: "chatcmpl-x",
                model: "up-gpt",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Bonjour" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 4, completion_tokens: 2 },
              }),
            );
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: {
            "routed-claude": {
              target: {
                kind: "vendor",
                vendor: "openai",
                credentialId: "cred",
                baseUrl: stub.origin,
              },
              upstreamModel: "up-gpt",
            },
          },
          connections: {},
          credentials: {
            cred: { displayName: "OpenAI key", vendor: "openai", value: "sk-openai-9" },
          },
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      const response = yield* post(`${router.baseUrl}/anthropic/v1/messages`, {
        model: "routed-claude",
        system: "Be terse.",
        max_tokens: 64,
        messages: [{ role: "user", content: "Say hello in French" }],
      });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.text) as {
        type: string;
        role: string;
        content: Array<{ type: string; text: string }>;
        stop_reason: string | null;
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(body.type).toBe("message");
      expect(body.role).toBe("assistant");
      expect(body.content).toEqual([{ type: "text", text: "Bonjour" }]);
      expect(body.stop_reason).toBe("end_turn");
      expect(body.usage).toEqual({ input_tokens: 4, output_tokens: 2 });

      // The upstream saw a fully translated OpenAI request with the vendor
      // key as a bearer token and the upstream slug, not the route key.
      expect(stub.requests).toHaveLength(1);
      const upstream = stub.requests[0]!;
      expect(upstream.url).toBe("/chat/completions");
      expect(upstream.headers["authorization"]).toBe("Bearer sk-openai-9");
      expect(upstream.headers["x-api-key"]).toBeUndefined();
      const upstreamBody = JSON.parse(upstream.body) as {
        model: string;
        stream: boolean;
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(upstreamBody.model).toBe("up-gpt");
      expect(upstreamBody.stream).toBe(false);
      expect(upstreamBody.messages).toEqual([
        { role: "system", content: "Be terse." },
        { role: "user", content: "Say hello in French" },
      ]);
    }),
  );

  it.effect("cross-protocol SSE streaming translates the event stream", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(
              'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
            );
            res.write(
              'data: {"choices":[{"index":0,"delta":{"content":"He"},"finish_reason":null}]}\n\n',
            );
            res.write(
              'data: {"choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}\n\n',
            );
            res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
            res.end("data: [DONE]\n\n");
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: {
            "routed-claude": {
              target: {
                kind: "vendor",
                vendor: "openai",
                credentialId: "cred",
                baseUrl: stub.origin,
              },
            },
          },
          connections: {},
          credentials: {
            cred: { displayName: "OpenAI key", vendor: "openai", value: "sk-openai-9" },
          },
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      const response = yield* post(`${router.baseUrl}/anthropic/v1/messages`, {
        model: "routed-claude",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "Say hello" }],
      });
      expect(response.status).toBe(200);
      const events = response.text
        .split("\n\n")
        .filter((frame) => frame.length > 0)
        .map((frame) => {
          const lines = frame.split("\n");
          const dataLine = lines.find((line) => line.startsWith("data: "));
          return {
            event: lines.find((line) => line.startsWith("event: "))?.slice("event: ".length),
            data: dataLine === undefined ? undefined : JSON.parse(dataLine.slice("data: ".length)),
          };
        });

      expect(events.map((event) => event.event)).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      expect(events[0]?.data).toMatchObject({
        type: "message_start",
        // The message envelope echoes the logical model the harness asked for.
        message: { role: "assistant", model: "routed-claude" },
      });
      const textDeltas = events.filter((event) => event.data?.delta?.type === "text_delta");
      expect(textDeltas.map((event) => event.data?.delta?.text).join("")).toBe("Hello");
      expect(events.at(-1)?.data?.type).toBe("message_stop");
    }),
  );

  it.effect("unknown model is a 404 in the inbound protocol's error shape", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200);
            res.end("{}");
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: { known: { target: { kind: "connection", connectionId: "stub" } } },
          connections: { stub: { baseUrl: stub.origin } },
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      const openAiError = yield* post(`${router.baseUrl}/openai/v1/chat/completions`, {
        model: "missing-model",
      });
      expect(openAiError.status).toBe(404);
      expect(JSON.parse(openAiError.text)).toMatchObject({
        error: { type: "invalid_request_error", code: "model_not_found" },
      });

      const anthropicError = yield* post(`${router.baseUrl}/anthropic/v1/messages`, {
        model: "missing-model",
        max_tokens: 1,
      });
      expect(anthropicError.status).toBe(404);
      expect(JSON.parse(anthropicError.text)).toMatchObject({
        type: "error",
        error: { type: "not_found_error" },
      });
      // The stub never saw traffic for unknown models.
      expect(stub.requests).toHaveLength(0);
    }),
  );

  it.effect("upstream failures relay the status with the key sanitized", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end('{"error":{"message":"bad key Bearer sk-stub-123 rejected"}}');
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: { "routed-gpt": { target: { kind: "connection", connectionId: "stub" } } },
          connections: {
            stub: { baseUrl: stub.origin, apiKeyCredentialId: "cred" },
          },
          credentials: {
            cred: { displayName: "Stub key", vendor: "openai", value: "sk-stub-123" },
          },
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      const response = yield* post(`${router.baseUrl}/v1/chat/completions`, {
        model: "routed-gpt",
        messages: [],
      });
      expect(response.status).toBe(500);
      expect(response.text).toContain("***");
      expect(response.text).not.toContain("sk-stub-123");
    }),
  );

  it.effect("models endpoints list routed ids in the respective shapes", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200);
            res.end("{}");
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: {
            "z-model": { target: { kind: "connection", connectionId: "stub" } },
            "a-model": { target: { kind: "vendor", vendor: "openai", credentialId: "cred" } },
          },
          connections: {
            stub: { baseUrl: stub.origin, models: ["m-stub-1", "a-model"] },
          },
          credentials: {
            cred: { displayName: "K", vendor: "openai", value: "sk" },
          },
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      const openAi = yield* get(`${router.baseUrl}/openai/v1/models`);
      expect(openAi.status).toBe(200);
      const openAiBody = JSON.parse(openAi.text) as { data: Array<{ id: string }> };
      expect(openAiBody.data.map((entry) => entry.id)).toEqual(["a-model", "m-stub-1", "z-model"]);

      const anthropic = yield* get(`${router.baseUrl}/anthropic/v1/models`);
      expect(anthropic.status).toBe(200);
      const anthropicBody = JSON.parse(anthropic.text) as {
        data: Array<{ type: string; id: string }>;
        has_more: boolean;
      };
      expect(anthropicBody.has_more).toBe(false);
      expect(anthropicBody.data.map((entry) => entry.id)).toEqual([
        "a-model",
        "m-stub-1",
        "z-model",
      ]);
      expect(anthropicBody.data.every((entry) => entry.type === "model")).toBe(true);
    }),
  );
});
