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
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
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
  readonly providerInstances?: Record<
    string,
    { readonly driver: string; readonly config?: unknown }
  >;
  readonly spawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
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
          ...(input.providerInstances === undefined
            ? {}
            : { providerInstances: input.providerInstances }),
        }),
        FetchHttpClient.layer,
        // Non-OAuth tests never spawn; a die-on-use spawner keeps the layer
        // buildable without masking real mints (the OAuth test passes its own).
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          input.spawner ?? ChildProcessSpawner.make(() => Effect.die("no spawn in this test")),
        ),
      ),
    ),
  );

// ── fake `codex app-server` that mints one fixed OAuth token ─────────────────

const accountToken =
  "header." +
  Buffer.from(
    JSON.stringify({
      email: "dev@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
    }),
  )
    .toString("base64url")
    .replace(/=+$/, "") +
  ".sig";

const decodeRequestLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const encodeResponseLine = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeAuthSpawner = Effect.fn("makeAuthSpawner")(function* () {
  const output = yield* Queue.unbounded<Uint8Array>();
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((bytes: Uint8Array) =>
      Effect.gen(function* () {
        for (const line of new TextDecoder().decode(bytes).trim().split("\n")) {
          const request = decodeRequestLine(line);
          if (request.id === undefined) continue;
          const result =
            request.method === "initialize"
              ? {
                  userAgent: "test-codex",
                  codexHome: "/tmp/codex-test",
                  platformFamily: "unix",
                  platformOs: "linux",
                }
              : { authMethod: "chatgpt", authToken: accountToken, requiresOpenaiAuth: true };
          yield* Queue.offer(
            output,
            new TextEncoder().encode(`${encodeResponseLine({ id: request.id, result })}\n`),
          );
        }
      }),
    ),
    stdout: Stream.fromQueue(output),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
  return ChildProcessSpawner.make(() => Effect.succeed(handle));
});

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
  it.effect("codex-oauth mints a bearer per request and relays Responses SSE", () =>
    Effect.gen(function* () {
      const events =
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-oauth","status":"completed"}}\n\n';
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(events);
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const spawner = yield* makeAuthSpawner();
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: {
            alias: {
              target: { kind: "connection", connectionId: "oauth" },
              upstreamModel: "upstream-luna",
            },
          },
          connections: { oauth: { baseUrl: stub.origin, codexAccountInstanceId: "codex" } },
          providerInstances: { codex: { driver: "codex", config: { binaryPath: "codex" } } },
          spawner,
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      const response = yield* post(`${router.baseUrl}/responses`, {
        model: "alias",
        input: [{ role: "user", content: "hi" }],
        stream: true,
      });
      expect(response.status).toBe(200);
      expect(response.text).toBe(events);

      expect(stub.requests).toHaveLength(1);
      const upstream = stub.requests[0]!;
      expect(upstream.url).toBe("/responses");
      // The minted login travels upstream, renamed to the upstream slug.
      expect(upstream.headers["authorization"]).toBe(`Bearer ${accountToken}`);
      expect(upstream.headers["chatgpt-account-id"]).toBe("acct-123");
      expect(upstream.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(upstream.body)).toMatchObject({ model: "upstream-luna", stream: true });
    }),
  );
  it.effect("codex-oauth forces streaming upstream and answers a non-streaming harness once", () =>
    Effect.gen(function* () {
      const events =
        'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-once","status":"completed","output":[]}}\n\n';
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(events);
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const spawner = yield* makeAuthSpawner();
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: { alias: { target: { kind: "connection", connectionId: "oauth" } } },
          connections: { oauth: { baseUrl: stub.origin, codexAccountInstanceId: "codex" } },
          providerInstances: { codex: { driver: "codex", config: { binaryPath: "codex" } } },
          spawner,
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      // The harness asked once; the ChatGPT backend only streams.
      const response = yield* post(`${router.baseUrl}/responses`, {
        model: "alias",
        input: [{ role: "user", content: "hi" }],
        stream: false,
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toEqual({
        id: "resp-once",
        status: "completed",
        output: [],
      });

      expect(stub.requests).toHaveLength(1);
      expect(JSON.parse(stub.requests[0]!.body)).toMatchObject({ model: "alias", stream: true });
    }),
  );
  it.effect("codex-oauth translates chat completions to Responses and answers JSON", () =>
    Effect.gen(function* () {
      // Recorded shapes from chatgpt.com/backend-api/codex (ids shortened).
      const events = [
        "event: response.created",
        'data: {"type":"response.created","response":{"id":"resp_t"}}',
        "",
        "event: response.output_item.added",
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_t","type":"function_call","status":"in_progress","arguments":"","call_id":"call_t","name":"greet"}}',
        "",
        "event: response.function_call_arguments.delta",
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"name\\":"}',
        "",
        "event: response.function_call_arguments.done",
        'data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"name\\":\\"Ada\\"}","item_id":"fc_t"}',
        "",
        "event: response.output_item.done",
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_t","type":"function_call","status":"completed","arguments":"{\\"name\\":\\"Ada\\"}","call_id":"call_t","name":"greet"}}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"id":"resp_t","object":"response","created_at":1789683892,"status":"completed","model":"upstream-luna","output":[],"usage":{"input_tokens":51,"output_tokens":18,"total_tokens":69}}}',
        "",
      ].join("\n");
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res, request) => {
            const url = request.url ?? "";
            if (url !== "/responses") {
              res.writeHead(404, { "content-type": "application/json" });
              res.end('{"detail":"Not Found"}');
              return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(events);
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const spawner = yield* makeAuthSpawner();
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: {
            alias: {
              target: { kind: "connection", connectionId: "oauth" },
              upstreamModel: "upstream-luna",
            },
          },
          connections: { oauth: { baseUrl: stub.origin, codexAccountInstanceId: "codex" } },
          providerInstances: { codex: { driver: "codex", config: { binaryPath: "codex" } } },
          spawner,
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      const response = yield* post(`${router.baseUrl}/v1/chat/completions`, {
        model: "alias",
        messages: [{ role: "user", content: "Call greet with Ada." }],
        tools: [{ type: "function", function: { name: "greet", parameters: { type: "object" } } }],
        stream: false,
      });
      expect(response.status).toBe(200);
      const completion = JSON.parse(response.text) as {
        choices: Array<{
          message: { content: null; tool_calls: Array<unknown> };
          finish_reason: string;
        }>;
        usage: unknown;
      };
      expect(completion.choices[0]?.finish_reason).toBe("tool_calls");
      expect(completion.choices[0]?.message.tool_calls).toEqual([
        {
          id: "call_t",
          type: "function",
          function: { name: "greet", arguments: '{"name":"Ada"}' },
        },
      ]);
      expect(completion.usage).toEqual({
        prompt_tokens: 51,
        completion_tokens: 18,
        total_tokens: 69,
      });

      expect(stub.requests).toHaveLength(1);
      const upstream = stub.requests[0]!;
      expect(upstream.url).toBe("/responses");
      expect(upstream.headers["authorization"]).toBe(`Bearer ${accountToken}`);
      const sent = JSON.parse(upstream.body) as Record<string, unknown>;
      expect(sent).toMatchObject({ model: "upstream-luna", stream: true, store: false });
      expect(sent.input).toBeDefined();
      expect(sent.tools).toBeDefined();
    }),
  );

  it.effect(
    "upstreamResponses routes translate chat completions to Responses and answer JSON",
    () =>
      Effect.gen(function* () {
        const events = [
          "event: response.output_item.done",
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_t","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi","annotations":[]}]}}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"resp_t","object":"response","created_at":1789751900,"status":"completed","model":"upstream-model","output":[{"id":"msg_t","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi","annotations":[]}]}],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
          "",
        ].join("\n");
        const stub = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startStubUpstream((res, request) => {
              if ((request.url ?? "") !== "/responses") {
                res.writeHead(404, { "content-type": "application/json" });
                res.end('{"detail":"Not Found"}');
                return;
              }
              res.writeHead(200, { "content-type": "text/event-stream" });
              res.end(events);
            }),
          ),
          (upstream) => Effect.promise(() => upstream.close()),
        );
        const context = yield* Layer.build(
          makeProxyLayer({
            routes: {
              alias: {
                target: { kind: "connection", connectionId: "stub" },
                upstreamModel: "upstream-model",
                upstreamResponses: true,
              },
            },
            connections: { stub: { baseUrl: stub.origin } },
          }),
        );
        const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

        const response = yield* post(`${router.baseUrl}/openai/v1/chat/completions`, {
          model: "alias",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        });
        expect(response.status).toBe(200);
        const completion = JSON.parse(response.text) as {
          choices: Array<{ message: { content: string }; finish_reason: string }>;
        };
        expect(completion.choices[0]?.message.content).toBe("hi");
        expect(completion.choices[0]?.finish_reason).toBe("stop");

        expect(stub.requests).toHaveLength(1);
        const upstream = stub.requests[0]!;
        expect(upstream.url).toBe("/responses");
        const sent = JSON.parse(upstream.body) as Record<string, unknown>;
        expect(sent).toMatchObject({ model: "upstream-model", stream: true });
        expect(sent.input).toBeDefined();
        expect(sent.messages).toBeUndefined();
      }),
  );

  it.effect("codex-oauth streams chat completions chunks from Responses SSE", () =>
    Effect.gen(function* () {
      const events = [
        "event: response.created",
        'data: {"type":"response.created","response":{"id":"resp_x"}}',
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"OK"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"id":"resp_x","status":"completed","model":"upstream-luna","output":[],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
        "",
      ].join("\n");
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(events);
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const spawner = yield* makeAuthSpawner();
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: { alias: { target: { kind: "connection", connectionId: "oauth" } } },
          connections: { oauth: { baseUrl: stub.origin, codexAccountInstanceId: "codex" } },
          providerInstances: { codex: { driver: "codex", config: { binaryPath: "codex" } } },
          spawner,
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      const response = yield* post(`${router.baseUrl}/v1/chat/completions`, {
        model: "alias",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      expect(response.status).toBe(200);
      expect(response.text).toContain('"content":"OK"');
      expect(response.text).toContain("chat.completion.chunk");
      expect(response.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    }),
  );

  it.effect("codex-oauth translates anthropic messages through to Responses", () =>
    Effect.gen(function* () {
      const events = [
        "event: response.created",
        'data: {"type":"response.created","response":{"id":"resp_x"}}',
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"OK"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"id":"resp_x","status":"completed","model":"upstream-luna","output":[{"id":"msg_x","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"OK","annotations":[]}]}],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
        "",
      ].join("\n");
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(events);
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const spawner = yield* makeAuthSpawner();
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: { alias: { target: { kind: "connection", connectionId: "oauth" } } },
          connections: { oauth: { baseUrl: stub.origin, codexAccountInstanceId: "codex" } },
          providerInstances: { codex: { driver: "codex", config: { binaryPath: "codex" } } },
          spawner,
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));

      const response = yield* post(`${router.baseUrl}/anthropic/v1/messages`, {
        model: "alias",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toMatchObject({
        type: "message",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
      });

      const sent = JSON.parse(stub.requests[0]!.body) as Record<string, unknown>;
      expect(sent).toMatchObject({ model: "alias", stream: true });
      expect(sent.input).toBeDefined();
    }),
  );
  it.effect("relays Responses requests and SSE without converting them to Chat Completions", () =>
    Effect.gen(function* () {
      const events =
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-test","status":"completed"}}\n\n';
      const stub = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startStubUpstream((res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(events);
          }),
        ),
        (upstream) => Effect.promise(() => upstream.close()),
      );
      const context = yield* Layer.build(
        makeProxyLayer({
          routes: {
            alias: {
              target: { kind: "connection", connectionId: "stub" },
              upstreamModel: "upstream-model",
            },
          },
          connections: { stub: { baseUrl: stub.origin, protocols: ["openai"] } },
        }),
      );
      const router = yield* ModelRouterProxy.pipe(Effect.provideContext(context));
      const body = { model: "alias", input: [{ role: "user", content: "hi" }], stream: true };
      for (const path of [
        "/responses",
        "/v1/responses",
        "/openai/responses",
        "/openai/v1/responses",
      ]) {
        const response = yield* post(`${router.baseUrl}${path}`, body);
        expect(response.status).toBe(200);
        expect(response.text).toBe(events);
      }
      expect(stub.requests).toHaveLength(4);
      for (const request of stub.requests) {
        expect(request.url).toBe("/responses");
        expect(JSON.parse(request.body)).toEqual({ ...body, model: "upstream-model" });
      }
    }),
  );
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
      // No session header leaks to non-Go upstreams.
      expect(upstream.headers["x-opencode-session"]).toBeUndefined();
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
