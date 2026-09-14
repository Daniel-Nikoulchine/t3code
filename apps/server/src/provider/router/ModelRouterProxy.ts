/**
 * ModelRouterProxy — the built-in local translation proxy behind the
 * `t3-router` backend kind. A loopback-only HTTP listener inside the server
 * process: harnesses point their `*_BASE_URL` at it, it routes by the
 * requested model slug (settings.modelRouterRoutes) to a connection or a
 * native vendor API, and translates Anthropic Messages ↔ OpenAI Chat
 * Completions when the wire protocols differ.
 *
 * Routing is strict: an unknown slug is a 404, an upstream failure relays the
 * upstream status, and there is deliberately no fallback or rerouting. OAuth
 * tokens never appear here — routes resolve keys from materialized
 * credentials or `apiKeyEnv` only (see modelRouterRouting).
 *
 * Settings are consumed through a Ref fed by a settings subscription, not
 * `getSettings` per request: the proxy sits on every harness turn, so the
 * request path must be a single Ref read, and the subscribe-before-seed
 * ordering of `ServerSettingsService.subscribeChanges` keeps the ref from
 * missing updates.
 *
 * Buffering: request bodies are buffered (bounded) because the `model` slug
 * decides the upstream before any byte moves; same-protocol RESPONSE bytes
 * are piped through unbuffered (the DeviceHubProxy pattern). Only
 * cross-protocol streams re-emit per translated event.
 *
 * @module provider/router/ModelRouterProxy
 */
import type { ModelProxyProtocol, ServerSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import { guardHttpResponseWriteErrors } from "../../httpResponseErrorGuard.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { deriveModelRouterPort } from "./modelRouterPort.ts";
import {
  resolveModelRoute,
  routedModelIds,
  type ModelRouterSnapshot,
} from "./modelRouterRouting.ts";
import {
  anthropicMessageToStreamEvents,
  anthropicRequestToOpenAI,
  anthropicResponseToOpenAI,
  createAnthropicToOpenAIChunkTranslator,
  createOpenAIToAnthropicChunkTranslator,
  createSseParser,
  encodeSseFrame,
  openAICompletionToChunkSequence,
  openAIRequestToAnthropic,
  openAIResponseToAnthropic,
  type SseFrame,
} from "./modelRouterTranslation.ts";

const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Request bodies buffer for routing; 32 MiB covers image-bearing harness
 * turns. Cross-protocol non-streaming responses buffer for translation with
 * a generous headroom; pass-through responses never buffer at all.
 */
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 1024 * 1024;

/** Hop-by-hop and compression headers that must not cross the relay. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
]);

export class ModelRouterBodyTooLarge extends Data.TaggedError("ModelRouterBodyTooLarge")<{}> {}
export class ModelRouterUpstreamBodyTooLarge extends Data.TaggedError(
  "ModelRouterUpstreamBodyTooLarge",
)<{}> {}

export class ModelRouterProxy extends Context.Service<
  ModelRouterProxy,
  {
    /**
     * Loopback base URL of the running listener, or undefined when the
     * listener failed to bind — the router is disabled and instances routed
     * through it degrade to native orphans.
     */
    readonly baseUrl: string | undefined;
  }
>()("t3/provider/router/ModelRouterProxy") {}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const readBodyBytes = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  maxBytes: number,
  onTooLarge: Effect.Effect<never>,
): Effect.Effect<Uint8Array, E> => {
  const parts: Array<Uint8Array> = [];
  let total = 0;
  return stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        total += chunk.byteLength;
        if (total > maxBytes) {
          return yield* onTooLarge;
        }
        parts.push(chunk);
      }),
    ),
    // Lazy map: the concat must run after the stream drains, not when the
    // effect is constructed.
    Effect.map(() => concatBytes(parts)),
  );
};

/** Encode a JSON body for the wire (kept outside Effect code). */
const encodeBodyJson = (value: Record<string, unknown>): Uint8Array =>
  textEncoder.encode(JSON.stringify(value));

const EMPTY_SNAPSHOT: ModelRouterSnapshot = { routes: {}, connections: {}, credentials: {} };

/** Best-effort JSON parse; non-JSON input yields `undefined`. */
const parseJsonText = (text: string): unknown | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const snapshotFromSettings = (settings: ServerSettings): ModelRouterSnapshot => ({
  routes: settings.modelRouterRoutes,
  connections: settings.modelBackendConnections,
  credentials: settings.modelCredentials,
});

// Inbound error shapes. Errors are always reported in the protocol the
// harness spoke, never the upstream's.
const errorResponse = (inbound: ModelProxyProtocol, status: number, message: string) => {
  if (inbound === "anthropic") {
    const type =
      status === 404
        ? "not_found_error"
        : status === 413
          ? "request_too_large"
          : status === 400
            ? "invalid_request_error"
            : "api_error";
    return Effect.succeed(
      HttpServerResponse.jsonUnsafe({ type: "error", error: { type, message } }, { status }),
    );
  }
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      {
        error: {
          message,
          type: status === 400 || status === 404 ? "invalid_request_error" : "api_error",
          ...(status === 404 ? { code: "model_not_found" } : {}),
        },
      },
      { status },
    ),
  );
};

/**
 * Proxy routes accept the documented paths (`/openai/v1/...`,
 * `/anthropic/v1/...`) plus the shorter forms harnesses actually produce
 * from the synthesized connection's baseUrl (`/openai/chat/completions`,
 * `/openai/v1/messages`, `/openai/models`) and bare root paths
 * (`/v1/chat/completions`, `/v1/messages`). The operation decides the
 * inbound protocol; the `/openai|anthropic` prefix only disambiguates the
 * `/models` shape, which exists in both.
 */
const CHAT_COMPLETIONS_PATH = /^\/(?:openai|anthropic)?\/?(?:v1\/)?chat\/completions$/;
const MESSAGES_PATH = /^\/(?:openai|anthropic)?\/?(?:v1\/)?messages$/;
const MODELS_PATH = /^\/(openai|anthropic)?\/?(?:v1\/)?models$/;

/**
 * Frame-level SSE translation plumbing, kept outside Effect code so it stays
 * a pure string/JSON concern (mirrors `parseJsonLine`-style best-effort
 * parsing elsewhere in the server). Wraps a protocol chunk translator with
 * the SSE parser and the inbound protocol's wire framing.
 */
const makeSseFrameTranslator = (
  inbound: ModelProxyProtocol,
  upstreamModel: string,
  createdSeconds: number,
) => {
  const id = inbound === "anthropic" ? "msg_t3_router" : "chatcmpl_t3_router";
  const translator =
    inbound === "anthropic"
      ? createOpenAIToAnthropicChunkTranslator({ model: upstreamModel, id })
      : createAnthropicToOpenAIChunkTranslator({
          id,
          model: upstreamModel,
          created: createdSeconds,
        });
  const encodeEvent = (event: Record<string, unknown>): string =>
    inbound === "anthropic"
      ? encodeSseFrame(event as { event?: string; data: unknown })
      : encodeSseFrame({ data: event });
  const sseParser = createSseParser();
  const translateFrame = (frame: SseFrame): ReadonlyArray<Record<string, unknown>> => {
    if (frame.data === "[DONE]") {
      return translator.end();
    }
    let data: unknown | undefined;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return [];
    }
    if (!Predicate.isObject(data)) return [];
    return translator.push(data);
  };
  return {
    /** Feed raw upstream text; returns encoded downstream frames. */
    push: (text: string): ReadonlyArray<string> =>
      sseParser.push(text).flatMap(translateFrame).map(encodeEvent),
    /** Flush translator state once the upstream stream closes. */
    done: (): ReadonlyArray<string> => [
      ...translator.end().map(encodeEvent),
      // OpenAI streams close with the [DONE] sentinel; Anthropic streams end
      // on the message_stop event the translator already emitted.
      ...(inbound === "openai" ? ["data: [DONE]\n\n"] : []),
    ],
  };
};

export const modelRouterProxyLayer = (options: {
  readonly port: number;
}): Layer.Layer<ModelRouterProxy, never, ServerSettingsService | HttpClient.HttpClient> =>
  Layer.effect(
    ModelRouterProxy,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
      const snapshotRef = yield* Ref.make<ModelRouterSnapshot>(EMPTY_SNAPSHOT);

      // Subscribe before the initial read, per the subscribeChanges
      // contract: no settings change can slip between seed and stream.
      const changes = yield* serverSettings.subscribeChanges;
      const initial = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
      yield* Ref.set(
        snapshotRef,
        initial === undefined ? EMPTY_SNAPSHOT : snapshotFromSettings(initial),
      );
      yield* changes.pipe(
        Stream.runForEach((next) => Ref.set(snapshotRef, snapshotFromSettings(next))),
        Effect.forkScoped,
      );

      const readResponseText = (
        response: { readonly stream: Stream.Stream<Uint8Array, HttpClientError.HttpClientError> },
        maxBytes: number,
      ): Effect.Effect<
        string,
        ModelRouterUpstreamBodyTooLarge | HttpClientError.HttpClientError
      > => {
        const parts: Array<Uint8Array> = [];
        let total = 0;
        return response.stream.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              total += chunk.byteLength;
              if (total > maxBytes) {
                return yield* Effect.fail(new ModelRouterUpstreamBodyTooLarge());
              }
              parts.push(chunk);
            }),
          ),
          Effect.map(() => textDecoder.decode(concatBytes(parts))),
        );
      };

      const relayHeaders = (
        headers: Record<string, string | undefined>,
      ): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const [name, value] of Object.entries(headers)) {
          if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
          out[name] = value;
        }
        return out;
      };

      const handleModels = (inbound: ModelProxyProtocol) =>
        Effect.map(Ref.get(snapshotRef), (snapshot) => {
          const models = routedModelIds(snapshot);
          if (inbound === "anthropic") {
            return HttpServerResponse.jsonUnsafe({
              data: models.map((id) => ({
                type: "model",
                id,
                display_name: id,
                created_at: "2024-01-01T00:00:00Z",
              })),
              first_id: models[0] ?? null,
              has_more: false,
              last_id: models.at(-1) ?? null,
            });
          }
          return HttpServerResponse.jsonUnsafe({
            object: "list",
            data: models.map((id) => ({
              id,
              object: "model",
              created: 0,
              owned_by: "t3-router",
            })),
          });
        });

      const handleChat = Effect.fn("ModelRouterProxy.chat")(function* (
        inbound: ModelProxyProtocol,
      ) {
        const createdSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const bodyExit = yield* Effect.exit(
          readBodyBytes(
            request.stream,
            MAX_REQUEST_BODY_BYTES,
            Effect.die(new ModelRouterBodyTooLarge()),
          ),
        );
        if (Exit.isFailure(bodyExit)) {
          return yield* errorResponse(inbound, 413, "request body exceeds the model router limit");
        }
        const parsed = parseJsonText(textDecoder.decode(bodyExit.value));
        if (!Predicate.isObject(parsed)) {
          return yield* errorResponse(inbound, 400, "request body must be a JSON object");
        }
        const model = Predicate.isString(parsed.model) ? parsed.model : undefined;
        if (model === undefined || model.length === 0) {
          return yield* errorResponse(inbound, 400, "request is missing the model field");
        }
        const resolved = resolveModelRoute(yield* Ref.get(snapshotRef), model, inbound);
        if (resolved._tag === "UnknownModel") {
          return yield* errorResponse(inbound, 404, `no route for model "${model}"`);
        }
        if (resolved._tag === "UnresolvedTarget") {
          return yield* errorResponse(
            inbound,
            502,
            `route for model "${model}" points at an unreachable target`,
          );
        }
        const upstream = resolved.upstream;
        const wantsStream = parsed.stream === true;
        const sameProtocol = upstream.protocol === inbound;

        let upstreamBody: Uint8Array;
        if (!sameProtocol) {
          const translated =
            inbound === "anthropic"
              ? anthropicRequestToOpenAI(parsed, upstream.upstreamModel)
              : openAIRequestToAnthropic(parsed, upstream.upstreamModel);
          upstreamBody = encodeBodyJson({ ...translated, stream: wantsStream });
        } else if (upstream.upstreamModel !== model) {
          // Pass-through, except the slug the route renames.
          upstreamBody = encodeBodyJson({ ...parsed, model: upstream.upstreamModel });
        } else {
          // Byte-faithful pass-through of the buffered request.
          upstreamBody = bodyExit.value;
        }

        const upstreamPath =
          upstream.protocol === "anthropic" && upstream.kind === "connection"
            ? "/v1/messages"
            : upstream.protocol === "anthropic"
              ? "/messages"
              : "/chat/completions";
        const headers: Record<string, string> = {
          "content-type": "application/json",
          // Pass-through relays raw bytes; upstream compression would
          // desynchronize them from the relayed headers.
          "accept-encoding": "identity",
          accept: wantsStream ? "text/event-stream" : "application/json",
        };
        if (upstream.apiKey !== undefined) {
          if (upstream.protocol === "anthropic") {
            headers["x-api-key"] = upstream.apiKey;
            headers["anthropic-version"] = ANTHROPIC_VERSION;
          } else {
            headers.authorization = `Bearer ${upstream.apiKey}`;
          }
        }
        const upstreamRequest = HttpClientRequest.make("POST")(
          `${upstream.baseUrl.replace(/\/+$/, "")}${upstreamPath}`,
        ).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyUint8Array(upstreamBody),
        );

        const responseExit = yield* Effect.exit(httpClient.execute(upstreamRequest));
        if (Exit.isFailure(responseExit)) {
          return yield* errorResponse(inbound, 502, "model router could not reach the upstream");
        }
        const response = responseExit.value;
        const status = response.status;
        if (status < 200 || status >= 300) {
          // Transparent relay of the upstream failure, sanitized: any
          // occurrence of the upstream key is redacted before the body
          // reaches the harness.
          const text = yield* readResponseText(response, MAX_ERROR_BODY_BYTES).pipe(
            Effect.catchCause(() => Effect.succeed("")),
          );
          const sanitized =
            upstream.apiKey !== undefined && upstream.apiKey.length > 0
              ? text.replaceAll(upstream.apiKey, "***")
              : text;
          return yield* Effect.succeed(
            HttpServerResponse.text(sanitized, {
              status,
              ...(response.headers["content-type"] !== undefined
                ? { contentType: response.headers["content-type"] }
                : {}),
            }),
          );
        }

        const isEventStream =
          response.headers["content-type"]?.includes("text/event-stream") ?? false;

        if (sameProtocol) {
          // Unbuffered byte relay — the whole point of same-protocol routing.
          return yield* Effect.succeed(
            HttpServerResponse.stream(response.stream, {
              status,
              headers: relayHeaders(response.headers),
            }),
          );
        }

        if (!isEventStream) {
          // Cross-protocol, non-streaming upstream: buffer, translate, and
          // wrap into the inbound expectation (synthetic SSE when the
          // harness asked to stream).
          const textExit = yield* Effect.exit(readResponseText(response, MAX_RESPONSE_BODY_BYTES));
          if (Exit.isFailure(textExit)) {
            return yield* errorResponse(
              inbound,
              502,
              "model router upstream response could not be read",
            );
          }
          const upstreamJson = parseJsonText(textExit.value);
          if (!Predicate.isObject(upstreamJson)) {
            return yield* errorResponse(
              inbound,
              502,
              "model router upstream sent an unreadable response",
            );
          }
          const translated =
            inbound === "anthropic"
              ? openAIResponseToAnthropic(upstreamJson)
              : anthropicResponseToOpenAI(upstreamJson, createdSeconds);
          if (!wantsStream) {
            return yield* Effect.succeed(HttpServerResponse.jsonUnsafe(translated));
          }
          const events =
            inbound === "anthropic"
              ? anthropicMessageToStreamEvents(translated)
              : openAICompletionToChunkSequence(translated);
          const body =
            events
              .map((event) => encodeSseFrame(event as { event?: string; data: unknown }))
              .join("") + (inbound === "openai" ? "data: [DONE]\n\n" : "");
          return yield* Effect.succeed(
            HttpServerResponse.text(body, { contentType: "text/event-stream" }),
          );
        }

        // Cross-protocol SSE: translate frame by frame, never buffering the
        // stream. The tail flushes translator state once upstream closes.
        const sse = makeSseFrameTranslator(inbound, upstream.upstreamModel, createdSeconds);
        const downstream = response.stream.pipe(
          Stream.decodeText(),
          Stream.flatMap((text) => Stream.fromIterable(sse.push(text))),
        );
        const tail = Stream.suspend(() => Stream.fromIterable(sse.done()));
        return yield* Effect.succeed(
          HttpServerResponse.stream(
            Stream.map(Stream.concat(downstream, tail), (text) => textEncoder.encode(text)),
            { status, contentType: "text/event-stream" },
          ),
        );
      });

      const handler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        const pathname = Option.isNone(url) ? "" : url.value.pathname;
        if (request.method === "GET") {
          const match = MODELS_PATH.exec(pathname);
          if (match !== null) {
            return yield* handleModels(match[1] === "anthropic" ? "anthropic" : "openai");
          }
        } else if (request.method === "POST") {
          if (CHAT_COMPLETIONS_PATH.test(pathname)) return yield* handleChat("openai");
          if (MESSAGES_PATH.test(pathname)) return yield* handleChat("anthropic");
        }
        return yield* Effect.succeed(HttpServerResponse.text("Not Found", { status: 404 }));
      });

      const bound = yield* Effect.exit(
        Layer.build(
          HttpRouter.serve(HttpRouter.add("*", "*", handler), {
            disableListenLog: true,
            disableLogger: true,
            // provideMerge keeps the transport's HttpServer in the built
            // context so the bound port can be read below.
          }).pipe(Layer.provideMerge(httpServerLayer(options.port))),
        ),
      );

      if (Exit.isFailure(bound)) {
        // Port bind failure must never take the server down: the router is
        // disabled, and instances routed through it degrade to native
        // orphans (resolveInstanceBackend treats a missing connection as
        // native).
        yield* Effect.logWarning("Model router disabled: loopback listener failed to bind", {
          port: options.port,
          errors: Cause.prettyErrors(bound.cause).map((error) => error.message),
        });
        return ModelRouterProxy.of({ baseUrl: undefined });
      }
      const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(bound.value));
      const address = server.address;
      const port = typeof address !== "string" && "port" in address ? address.port : options.port;
      return ModelRouterProxy.of({ baseUrl: `http://127.0.0.1:${port}` });
    }),
  );

/**
 * Runtime-selected loopback transport, mirroring server.ts: Bun gets
 * BunHttpServer, everything else Node with the response-write guard that
 * keeps a disconnected harness from escalating to process shutdown.
 */
const httpServerLayer = (port: number) =>
  Layer.unwrap(
    Effect.gen(function* () {
      if (typeof Bun !== "undefined") {
        const BunHttpServer = yield* Effect.promise(
          () => import("@effect/platform-bun/BunHttpServer"),
        );
        return BunHttpServer.layer({ port, hostname: "127.0.0.1" });
      }
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(() => guardHttpResponseWriteErrors(NodeHttp.createServer()), {
        host: "127.0.0.1",
        port,
      });
    }),
  );

/** Live layer: derives the deterministic port from the T3 home base dir. */
export const ModelRouterProxyLive: Layer.Layer<
  ModelRouterProxy,
  never,
  ServerSettingsService | HttpClient.HttpClient | ServerConfig.ServerConfig
> = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, (config) =>
    modelRouterProxyLayer({ port: deriveModelRouterPort(config.baseDir) }),
  ),
);
