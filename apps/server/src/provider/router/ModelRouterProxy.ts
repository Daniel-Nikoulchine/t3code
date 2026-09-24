/**
 * ModelRouterProxy — the built-in local translation proxy behind the
 * `t3-router` backend kind. A loopback-only HTTP listener inside the server
 * process: harnesses point their `*_BASE_URL` at it, it routes by the
 * requested model slug (settings.modelRouterRoutes) to a connection or a
 * native vendor API, and translates Anthropic Messages ↔ OpenAI Chat
 * Completions when the wire protocols differ.
 *
 * Routing is strict: an unknown slug is a 404, an upstream failure relays the
 * upstream status, and there is deliberately no fallback or rerouting.
 * `codex-oauth` routes carry no stored key: the proxy mints a bearer per
 * request through the named Codex harness's own login
 * (see CodexOAuthCredentials) and sends the ChatGPT account binding with it.
 * Minted tokens are redacted from relayed errors like stored keys.
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
import type {
  ModelProxyProtocol,
  ProviderInstanceEnvironment,
  ServerSettings,
} from "@t3tools/contracts";
import { CodexSettings, defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
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
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { resolveCodexLaunchArgs } from "../Layers/codexLaunchArgs.ts";
import { resolveCodexOAuthCredentials } from "./CodexOAuthCredentials.ts";
import { deriveModelRouterPort } from "./modelRouterPort.ts";
import {
  resolveModelRoute,
  resolveOpencodeGoSessionHeader,
  routedModelIds,
  type CodexOAuthAccount,
  type ModelRouterSnapshot,
} from "./modelRouterRouting.ts";
import {
  buildUpstreamHeaders,
  redactSecrets,
  resolveUpstreamPath,
  resolveUpstreamRequestBody,
} from "./modelRouterRequest.ts";
import {
  anthropicMessageToStreamEvents,
  anthropicRequestToOpenAI,
  anthropicResponseToOpenAI,
  chatCompletionsRequestToResponses,
  createAnthropicToOpenAIChunkTranslator,
  createOpenAIToAnthropicChunkTranslator,
  createResponsesToOpenAIChunkTranslator,
  createSseParser,
  encodeSseFrame,
  openAICompletionToChunkSequence,
  openAIRequestToAnthropic,
  openAIResponseToAnthropic,
  responsesResponseToChatCompletion,
  type SseFrame,
} from "./modelRouterTranslation.ts";

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

const EMPTY_SNAPSHOT: ModelRouterSnapshot = {
  routes: {},
  connections: {},
  credentials: {},
  codexAccounts: {},
};

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
  codexAccounts: codexAccountsFromSettings(settings),
});

/**
 * Spawn inputs per Codex harness login, mirroring what `CodexDriver` passes
 * to `withCodexAppServerClient`: the expanded binary path, the effective
 * home, launch args, and the instance's merged environment (own-login env,
 * never the model-backend overlay).
 *
 * The effective home mirrors `resolveCodexHomeLayout` without the `Path`
 * service: values are absolute or `~`-rooted in practice, so expansion is
 * the whole resolution (`path.resolve` there only anchors relative paths to
 * the same `process.cwd()` the mint below spawns in).
 */
const codexAccountFromConfig = (
  config: CodexSettings,
  environment: ProviderInstanceEnvironment | undefined,
): CodexOAuthAccount => {
  const processEnv = mergeProviderInstanceEnvironment(environment);
  const shadowHome = config.shadowHomePath.trim();
  const home = config.homePath.trim();
  const homePath =
    shadowHome.length > 0
      ? expandHomePath(shadowHome)
      : home.length > 0
        ? expandHomePath(home)
        : undefined;
  return {
    binaryPath: expandHomePath(config.binaryPath).trim() || "codex",
    ...(homePath === undefined ? {} : { homePath }),
    launchArgs: resolveCodexLaunchArgs(config.launchArgs, processEnv),
    environment: processEnv,
  };
};

const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/**
 * Collect the Codex harness logins the proxy may mint OAuth tokens from:
 * explicit `providerInstances` entries with the codex driver (keyed by
 * instance id), plus the legacy `providers.codex` blob under the default
 * instance id when no explicit entry claims that slot — the same precedence
 * the registry hydration uses.
 */
const codexAccountsFromSettings = (settings: ServerSettings): Record<string, CodexOAuthAccount> => {
  const accounts: Record<string, CodexOAuthAccount> = {};
  for (const [instanceId, entry] of Object.entries(settings.providerInstances ?? {})) {
    if (entry.driver !== "codex") continue;
    const decoded = decodeCodexSettings(entry.config ?? {});
    if (Option.isSome(decoded)) {
      accounts[instanceId] = codexAccountFromConfig(decoded.value, entry.environment);
    }
  }
  const legacyInstanceId = String(defaultInstanceIdForDriver(ProviderDriverKind.make("codex")));
  if (accounts[legacyInstanceId] === undefined && settings.providers.codex !== undefined) {
    accounts[legacyInstanceId] = codexAccountFromConfig(settings.providers.codex, undefined);
  }
  return accounts;
};

/**
 * Pull the final `response` object plus the accumulated `output_item.done`
 * payloads out of a Responses SSE stream (the `response.completed` event
 * carries it whole). Lets the proxy answer a non-streaming harness while
 * the ChatGPT backend — which only streams — still gets `stream: true`.
 * Items accumulate separately because a tool-call-only turn can complete
 * with an empty `output` while the items only arrived as stream events.
 */
const extractResponsesResult = (
  sseText: string,
): { readonly response: Record<string, unknown>; readonly items: Array<unknown> } | undefined => {
  let completed: Record<string, unknown> | undefined;
  const items: Array<unknown> = [];
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice("data: ".length);
    if (data === "[DONE]") continue;
    const parsed = parseJsonText(data);
    if (!Predicate.isObject(parsed)) continue;
    if (parsed.type === "response.completed" && Predicate.isObject(parsed.response)) {
      completed = parsed.response as Record<string, unknown>;
    } else if (parsed.type === "response.output_item.done" && "item" in parsed) {
      items.push(parsed.item);
    }
  }
  return completed === undefined ? undefined : { response: completed, items };
};

/** Usage counts off a `response.completed` event for chunk annotation. */
const responsesUsageOf = (event: Record<string, unknown>): Record<string, unknown> | undefined => {
  const usage = Predicate.isObject(event.response)
    ? (event.response as Record<string, unknown>).usage
    : undefined;
  if (!Predicate.isObject(usage)) return undefined;
  const record = usage as Record<string, unknown>;
  return {
    prompt_tokens: typeof record.input_tokens === "number" ? record.input_tokens : 0,
    completion_tokens: typeof record.output_tokens === "number" ? record.output_tokens : 0,
    total_tokens: typeof record.total_tokens === "number" ? record.total_tokens : 0,
  };
};

/**
 * Frame-level relay for translated OAuth traffic: Responses SSE in,
 * inbound-protocol SSE out. Anthropic harnesses chain through the existing
 * OpenAI→Anthropic chunk translator, fed with the translated chat chunks
 * (plus usage lifted off the completed event, which translated chunks do
 * not carry).
 */
const makeResponsesSseRelay = (
  inbound: ModelProxyProtocol,
  upstreamModel: string,
  createdSeconds: number,
  includeUsage: boolean,
) => {
  const toChat = createResponsesToOpenAIChunkTranslator({
    id: "chatcmpl_t3_router",
    model: upstreamModel,
    created: createdSeconds,
    ...(includeUsage ? { includeUsage: true } : {}),
  });
  const toAnthropic =
    inbound === "anthropic"
      ? createOpenAIToAnthropicChunkTranslator({ model: upstreamModel, id: "msg_t3_router" })
      : undefined;
  const sseParser = createSseParser();
  const pushFrame = (data: Record<string, unknown>): ReadonlyArray<string> => {
    const usage = toAnthropic === undefined ? undefined : responsesUsageOf(data);
    const out: Array<string> = [];
    for (const chunkObj of toChat.push(data)) {
      const annotated = usage === undefined ? chunkObj : { ...chunkObj, usage };
      if (toAnthropic === undefined) {
        out.push(encodeSseFrame({ data: annotated }));
      } else {
        for (const event of toAnthropic.push(annotated)) {
          out.push(encodeSseFrame(event as { event?: string; data: unknown }));
        }
      }
    }
    return out;
  };
  return {
    /** Feed raw upstream text; returns encoded downstream frames. */
    push: (text: string): ReadonlyArray<string> => {
      const out: Array<string> = [];
      for (const frame of sseParser.push(text)) {
        if (frame.data === "[DONE]") continue;
        const data = parseJsonText(frame.data);
        if (!Predicate.isObject(data)) continue;
        out.push(...pushFrame(data as Record<string, unknown>));
      }
      return out;
    },
    /** Flush translator state once the upstream stream closes. */
    done: (): ReadonlyArray<string> => {
      const out: Array<string> = [];
      const tail = toChat.end();
      if (toAnthropic === undefined) {
        for (const chunkObj of tail) out.push(encodeSseFrame({ data: chunkObj }));
        out.push("data: [DONE]\n\n");
      } else {
        for (const chunkObj of tail) {
          for (const event of toAnthropic.push(chunkObj)) {
            out.push(encodeSseFrame(event as { event?: string; data: unknown }));
          }
        }
        for (const event of toAnthropic.end()) {
          out.push(encodeSseFrame(event as { event?: string; data: unknown }));
        }
      }
      return out;
    },
  };
};

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
const RESPONSES_PATH = /^\/(?:openai|anthropic)?\/?(?:v1\/)?responses$/;
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
}): Layer.Layer<
  ModelRouterProxy,
  never,
  ServerSettingsService | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    ModelRouterProxy,
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
      // Captured once: the per-request OAuth mint below re-provides it, so
      // short-lived `codex app-server` spawns never depend on request scope.
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
        responses = false,
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
        const snapshot = yield* Ref.get(snapshotRef);
        const resolved = resolveModelRoute(snapshot, model, inbound);
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
        if (responses && upstream.protocol !== "openai") {
          return yield* errorResponse(
            inbound,
            400,
            "Responses requires an OpenAI-compatible upstream",
          );
        }
        const isCodexOAuth = upstream.kind === "codex-oauth";
        // Routes can force the Responses wire upstream (opencode-go serves
        // some models only on `/responses`); codex-oauth always does.
        // The ChatGPT backend only streams: a non-streaming harness still
        // gets `stream: true` upstream, and the proxy de-streams or
        // translates below.
        const wantsStream = parsed.stream === true;
        const upstreamWantsStream = wantsStream || isCodexOAuth || upstream.responsesUpstream;

        // Per-request OAuth mint through the account's own harness login.
        // Routing guarantees the account exists; the lookup below only
        // guards a settings swap between the two Ref reads.
        let oauthToken: string | undefined;
        let oauthAccountId: string | undefined;
        if (isCodexOAuth) {
          const account = snapshot.codexAccounts[upstream.codexAccountInstanceId ?? ""];
          if (account === undefined) {
            return yield* errorResponse(
              inbound,
              502,
              `route for model "${model}" points at an unreachable target`,
            );
          }
          const minted = yield* Effect.exit(
            resolveCodexOAuthCredentials({
              binaryPath: account.binaryPath,
              ...(account.homePath === undefined ? {} : { homePath: account.homePath }),
              ...(account.launchArgs === undefined ? {} : { launchArgs: account.launchArgs }),
              ...(account.environment === undefined ? {} : { environment: account.environment }),
            }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.scoped,
            ),
          );
          if (Exit.isFailure(minted)) {
            return yield* errorResponse(
              inbound,
              502,
              `codex login for "${upstream.codexAccountInstanceId}" failed — run codex login for that home`,
            );
          }
          oauthToken = minted.value.authToken;
          oauthAccountId = minted.value.chatgptAccountId;
        }
        const sameProtocol = upstream.protocol === inbound;

        const upstreamBody = resolveUpstreamRequestBody({
          parsed,
          rawBody: bodyExit.value,
          inbound,
          responses,
          upstream,
          model,
          wantsStream,
          upstreamWantsStream,
          isCodexOAuth,
        });

        const upstreamPath = resolveUpstreamPath({ responses, upstream });
        // OpenCode Go routes per conversation and rejects requests without
        // a session id ("MissingSessionID", verified live). Pass a
        // harness-supplied id through; otherwise send a stable per-route id
        // so routing and prompt caching still work.
        const goSession = resolveOpencodeGoSessionHeader({
          baseUrl: upstream.baseUrl,
          routeKey: model,
          inboundSessionId: request.headers["x-opencode-session"],
        });
        const headers = buildUpstreamHeaders({
          upstream,
          upstreamWantsStream,
          ...(oauthToken === undefined ? {} : { oauthToken }),
          ...(oauthAccountId === undefined ? {} : { oauthAccountId }),
          ...(goSession === undefined ? {} : { goSession }),
        });
        const upstreamRequest = HttpClientRequest.make("POST")(
          `${upstream.baseUrl.replace(/\/+$/, "")}${upstreamPath}`,
        ).pipe(
          HttpClientRequest.setHeaders(headers),
          // Content type travels as the body arg: setBody overwrites the
          // header from the body, so omitting it sends octet-stream.
          HttpClientRequest.bodyUint8Array(upstreamBody, "application/json"),
        );

        const responseExit = yield* Effect.exit(httpClient.execute(upstreamRequest));
        if (Exit.isFailure(responseExit)) {
          return yield* errorResponse(inbound, 502, "model router could not reach the upstream");
        }
        const response = responseExit.value;
        const status = response.status;
        if (status < 200 || status >= 300) {
          // Transparent relay of the upstream failure, sanitized: any
          // occurrence of the upstream key — or the minted OAuth token — is
          // redacted before the body reaches the harness.
          const text = yield* readResponseText(response, MAX_ERROR_BODY_BYTES).pipe(
            Effect.catchCause(() => Effect.succeed("")),
          );
          const secrets = [
            ...(upstream.apiKey !== undefined && upstream.apiKey.length > 0
              ? [upstream.apiKey]
              : []),
            ...(oauthToken !== undefined && oauthToken.length > 0 ? [oauthToken] : []),
          ];
          const sanitized = redactSecrets(text, secrets);
          return yield* Effect.succeed(
            HttpServerResponse.text(sanitized, {
              status,
              ...(response.headers["content-type"] !== undefined
                ? { contentType: response.headers["content-type"] }
                : {}),
            }),
          );
        }

        if (responses && isCodexOAuth && !wantsStream) {
          // The backend streamed because it had to; the harness asked once.
          const textExit = yield* Effect.exit(readResponseText(response, MAX_RESPONSE_BODY_BYTES));
          if (Exit.isFailure(textExit)) {
            return yield* errorResponse(
              inbound,
              502,
              "model router upstream response could not be read",
            );
          }
          const completed = extractResponsesResult(textExit.value)?.response;
          if (completed === undefined) {
            return yield* errorResponse(
              inbound,
              502,
              "model router upstream sent an unreadable response",
            );
          }
          return yield* Effect.succeed(HttpServerResponse.jsonUnsafe(completed));
        }

        if ((isCodexOAuth || upstream.responsesUpstream) && !responses) {
          // Translated traffic: the upstream always streamed (forced above),
          // the harness gets its own protocol back either way.
          const streamOptions = Predicate.isObject(parsed.stream_options)
            ? (parsed.stream_options as Record<string, unknown>)
            : undefined;
          if (!wantsStream) {
            const textExit = yield* Effect.exit(
              readResponseText(response, MAX_RESPONSE_BODY_BYTES),
            );
            if (Exit.isFailure(textExit)) {
              return yield* errorResponse(
                inbound,
                502,
                "model router upstream response could not be read",
              );
            }
            const result = extractResponsesResult(textExit.value);
            if (result === undefined) {
              return yield* errorResponse(
                inbound,
                502,
                "model router upstream sent an unreadable response",
              );
            }
            if (result.response.status === "failed") {
              const detail = Predicate.isObject(result.response.error)
                ? (result.response.error as Record<string, unknown>).message
                : undefined;
              return yield* errorResponse(
                inbound,
                502,
                typeof detail === "string" && detail.length > 0
                  ? `model router upstream request failed: ${detail.slice(0, 200)}`
                  : "model router upstream request failed",
              );
            }
            const chatCompletion = responsesResponseToChatCompletion(
              result.response,
              result.items.length > 0
                ? result.items
                : ((result.response.output as ReadonlyArray<unknown> | undefined) ?? []),
              upstream.upstreamModel,
              createdSeconds,
            );
            return yield* Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                inbound === "anthropic"
                  ? openAIResponseToAnthropic(chatCompletion)
                  : chatCompletion,
              ),
            );
          }
          const relay = makeResponsesSseRelay(
            inbound,
            upstream.upstreamModel,
            createdSeconds,
            streamOptions?.include_usage === true,
          );
          const downstream = response.stream.pipe(
            Stream.decodeText(),
            Stream.flatMap((text) => Stream.fromIterable(relay.push(text))),
          );
          const tail = Stream.suspend(() => Stream.fromIterable(relay.done()));
          return yield* Effect.succeed(
            HttpServerResponse.stream(
              Stream.map(Stream.concat(downstream, tail), (text) => textEncoder.encode(text)),
              { status, contentType: "text/event-stream" },
            ),
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
          if (RESPONSES_PATH.test(pathname)) return yield* handleChat("openai", true);
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
      if (typeof (globalThis as { readonly Bun?: unknown }).Bun !== "undefined") {
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
  | ServerSettingsService
  | HttpClient.HttpClient
  | ServerConfig.ServerConfig
  | ChildProcessSpawner.ChildProcessSpawner
> = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, (config) =>
    modelRouterProxyLayer({ port: deriveModelRouterPort(config.baseDir) }),
  ),
);
