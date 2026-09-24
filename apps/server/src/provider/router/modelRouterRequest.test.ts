import { describe, expect, it } from "vite-plus/test";

import type { ModelRouterUpstream } from "./modelRouterRouting.ts";
import {
  buildUpstreamHeaders,
  redactSecrets,
  resolveUpstreamPath,
  resolveUpstreamRequestBody,
} from "./modelRouterRequest.ts";

const textEncoder = new TextEncoder();
const rawBody = textEncoder.encode(JSON.stringify({ model: "route-key", stream: false }));

const connectionUpstream = (overrides: Partial<ModelRouterUpstream> = {}): ModelRouterUpstream => ({
  kind: "connection",
  baseUrl: "http://127.0.0.1:20128/v1",
  apiKey: undefined,
  protocol: "openai",
  upstreamModel: "upstream-model",
  responsesUpstream: false,
  ...overrides,
});

const parsed = (model: string, extra: Record<string, unknown> = {}) => ({ model, ...extra });

describe("resolveUpstreamRequestBody", () => {
  it("passes bytes through untouched when slug and stream already match", () => {
    const upstream = connectionUpstream({ upstreamModel: "route-key" });
    const body = resolveUpstreamRequestBody({
      parsed: parsed("route-key", { stream: false }),
      rawBody,
      inbound: "openai",
      responses: false,
      upstream,
      model: "route-key",
      wantsStream: false,
      upstreamWantsStream: false,
      isCodexOAuth: false,
    });
    expect(body).toBe(rawBody);
  });

  it("renames the slug and forces stream without touching anything else", () => {
    const upstream = connectionUpstream({ upstreamModel: "upstream-model" });
    const body = resolveUpstreamRequestBody({
      parsed: parsed("route-key", { stream: false, temperature: 0.5 }),
      rawBody,
      inbound: "openai",
      responses: false,
      upstream,
      model: "route-key",
      wantsStream: false,
      upstreamWantsStream: true,
      isCodexOAuth: false,
    });
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      model: "upstream-model",
      stream: true,
      temperature: 0.5,
    });
  });

  it("forces stream for Responses-forced chat traffic", () => {
    const upstream = connectionUpstream({
      upstreamModel: "upstream-model",
      responsesUpstream: true,
    });
    const body = resolveUpstreamRequestBody({
      parsed: parsed("route-key", { messages: [] }),
      rawBody,
      inbound: "openai",
      responses: false,
      upstream,
      model: "route-key",
      wantsStream: false,
      upstreamWantsStream: true,
      isCodexOAuth: false,
    });
    const decoded = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    expect(decoded.stream).toBe(true);
    expect(decoded.model).toBe("upstream-model");
  });
});

describe("resolveUpstreamPath", () => {
  it("pins Responses-forced traffic to /responses", () => {
    expect(
      resolveUpstreamPath({
        responses: false,
        upstream: connectionUpstream({ kind: "codex-oauth", responsesUpstream: false }),
      }),
    ).toBe("/responses");
    expect(
      resolveUpstreamPath({
        responses: false,
        upstream: connectionUpstream({ responsesUpstream: true }),
      }),
    ).toBe("/responses");
  });

  it("splits Anthropic by target kind and keeps OpenAI on chat completions", () => {
    expect(
      resolveUpstreamPath({
        responses: false,
        upstream: connectionUpstream({ protocol: "anthropic" }),
      }),
    ).toBe("/v1/messages");
    expect(
      resolveUpstreamPath({
        responses: false,
        upstream: connectionUpstream({ kind: "vendor", protocol: "anthropic" }),
      }),
    ).toBe("/messages");
    expect(resolveUpstreamPath({ responses: false, upstream: connectionUpstream() })).toBe(
      "/chat/completions",
    );
  });
});

describe("buildUpstreamHeaders", () => {
  it("prefers the minted OAuth bearer over stored keys", () => {
    const headers = buildUpstreamHeaders({
      upstream: connectionUpstream({ apiKey: "stored" }),
      upstreamWantsStream: true,
      oauthToken: "minted",
      oauthAccountId: "account-1",
    });
    expect(headers.authorization).toBe("Bearer minted");
    expect(headers["chatgpt-account-id"]).toBe("account-1");
    expect(headers.accept).toBe("text/event-stream");
  });

  it("sends Anthropic keys as x-api-key with the version pin", () => {
    const headers = buildUpstreamHeaders({
      upstream: connectionUpstream({ protocol: "anthropic", apiKey: "key" }),
      upstreamWantsStream: false,
    });
    expect(headers["x-api-key"]).toBe("key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
  });

  it("forwards the OpenCode Go session id only when present", () => {
    const without = buildUpstreamHeaders({
      upstream: connectionUpstream(),
      upstreamWantsStream: false,
    });
    expect(without["x-opencode-session"]).toBeUndefined();
    const withSession = buildUpstreamHeaders({
      upstream: connectionUpstream(),
      upstreamWantsStream: false,
      goSession: "route:session",
    });
    expect(withSession["x-opencode-session"]).toBe("route:session");
  });
});

describe("redactSecrets", () => {
  it("replaces every occurrence of every secret", () => {
    expect(redactSecrets("key sk-1 and sk-1 again, plus sk-2", ["sk-1", "sk-2"])).toBe(
      "key *** and *** again, plus ***",
    );
    expect(redactSecrets("untouched", [])).toBe("untouched");
  });
});
