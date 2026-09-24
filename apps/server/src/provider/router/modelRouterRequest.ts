/**
 * ModelRouterRequest — the pure request-build phase of the model router.
 *
 * `handleChat` in `ModelRouterProxy` used to inline upstream body selection,
 * path selection, header assembly, and error redaction between route
 * resolution and the upstream fetch. Those four decisions are pure given the
 * resolved route and the parsed inbound body, so they live here with unit
 * tests; the proxy keeps routing, OAuth minting, fetching, and relaying.
 * Strictness is unchanged: same bodies, paths, headers, and redactions.
 *
 * @module provider/router/modelRouterRequest
 */
import type { ModelProxyProtocol } from "@t3tools/contracts";

import type { ModelRouterUpstream } from "./modelRouterRouting.ts";
import {
  anthropicRequestToOpenAI,
  chatCompletionsRequestToResponses,
  openAIRequestToAnthropic,
} from "./modelRouterTranslation.ts";

export const ANTHROPIC_VERSION = "2023-06-01";

const textEncoder = new TextEncoder();

/** Encode a JSON body for the wire (kept outside Effect code). */
export const encodeBodyJson = (value: Record<string, unknown>): Uint8Array =>
  textEncoder.encode(JSON.stringify(value));

/**
 * The exact bytes to POST upstream. Translated traffic (Responses-forced or
 * cross-protocol) goes through the wire translators with the route's model
 * slug and the forced stream flag; same-protocol renames only touch slug
 * and stream flag; otherwise the buffered bytes pass through untouched.
 */
export function resolveUpstreamRequestBody(input: {
  readonly parsed: Record<string, unknown>;
  readonly rawBody: Uint8Array;
  readonly inbound: ModelProxyProtocol;
  readonly responses: boolean;
  readonly upstream: ModelRouterUpstream;
  /** Inbound model slug (route key) for the rename check. */
  readonly model: string;
  readonly wantsStream: boolean;
  readonly upstreamWantsStream: boolean;
  readonly isCodexOAuth: boolean;
}): Uint8Array {
  const {
    parsed,
    rawBody,
    inbound,
    responses,
    upstream,
    model,
    wantsStream,
    upstreamWantsStream,
    isCodexOAuth,
  } = input;
  if ((isCodexOAuth || upstream.responsesUpstream) && !responses) {
    // Chat-shaped harnesses ride the Responses endpoint through
    // translation; the backend serves nothing else.
    const chatBody =
      inbound === "anthropic" ? anthropicRequestToOpenAI(parsed, upstream.upstreamModel) : parsed;
    const translated = chatCompletionsRequestToResponses(
      { ...chatBody, model: upstream.upstreamModel },
      upstream.upstreamModel,
    );
    return encodeBodyJson({ ...translated, stream: upstreamWantsStream });
  }
  if (upstream.protocol !== inbound) {
    const translated =
      inbound === "anthropic"
        ? anthropicRequestToOpenAI(parsed, upstream.upstreamModel)
        : openAIRequestToAnthropic(parsed, upstream.upstreamModel);
    return encodeBodyJson({ ...translated, stream: upstreamWantsStream });
  }
  if (upstreamWantsStream !== wantsStream || upstream.upstreamModel !== model) {
    // Pass-through, except the slug the route renames and the stream
    // flag the ChatGPT backend insists on.
    return encodeBodyJson({
      ...parsed,
      model: upstream.upstreamModel,
      ...(upstreamWantsStream !== wantsStream ? { stream: upstreamWantsStream } : {}),
    });
  }
  // Byte-faithful pass-through of the buffered request.
  return rawBody;
}

/**
 * The operation path for the upstream POST. Responses-forced traffic always
 * lands on `/responses`; Anthropic splits by target kind (connections follow
 * the harness contract, vendors the versioned path); OpenAI appends chat
 * completions either way.
 */
export function resolveUpstreamPath(input: {
  readonly responses: boolean;
  readonly upstream: ModelRouterUpstream;
}): string {
  const { responses, upstream } = input;
  if (responses || upstream.kind === "codex-oauth" || upstream.responsesUpstream)
    return "/responses";
  if (upstream.protocol === "anthropic" && upstream.kind === "connection") return "/v1/messages";
  if (upstream.protocol === "anthropic") return "/messages";
  return "/chat/completions";
}

/**
 * Headers for the upstream POST. OAuth bearers win over stored keys;
 * Anthropic keys travel as `x-api-key` with the version pin, OpenAI keys as
 * bearer. Pass-through relays raw bytes, so compression stays off.
 */
export function buildUpstreamHeaders(input: {
  readonly upstream: ModelRouterUpstream;
  readonly upstreamWantsStream: boolean;
  readonly oauthToken?: string | undefined;
  readonly oauthAccountId?: string | undefined;
  readonly goSession?: string | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept-encoding": "identity",
    accept: input.upstreamWantsStream ? "text/event-stream" : "application/json",
  };
  if (input.oauthToken !== undefined) {
    headers.authorization = `Bearer ${input.oauthToken}`;
    if (input.oauthAccountId !== undefined) {
      headers["chatgpt-account-id"] = input.oauthAccountId;
    }
  } else if (input.upstream.apiKey !== undefined) {
    if (input.upstream.protocol === "anthropic") {
      headers["x-api-key"] = input.upstream.apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    } else {
      headers.authorization = `Bearer ${input.upstream.apiKey}`;
    }
  }
  if (input.goSession !== undefined) {
    headers["x-opencode-session"] = input.goSession;
  }
  return headers;
}

/**
 * Redact every secret occurrence before an upstream failure reaches the
 * harness. Replacement is literal and total.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string>): string {
  let sanitized = text;
  for (const secret of secrets) {
    sanitized = sanitized.replaceAll(secret, "***");
  }
  return sanitized;
}
