import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ModelBackendConfig, ModelBackendConnectionId, ModelProxyConfig } from "./modelBackend.ts";

const decodeModelBackendConfig = Schema.decodeUnknownSync(ModelBackendConfig);
const decodeModelBackendConnectionId = Schema.decodeUnknownSync(ModelBackendConnectionId);
const decodeModelProxyConfig = Schema.decodeUnknownSync(ModelProxyConfig);

describe("ModelBackendConfig", () => {
  it("decodes native backend without baseUrl", () => {
    const decoded = decodeModelBackendConfig({ kind: "native" });
    expect(decoded.kind).toBe("native");
  });

  it("decodes openai-compatible backend with baseUrl", () => {
    const decoded = decodeModelBackendConfig({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKeyEnv: "OMNIROUTE_API_KEY",
    });
    expect(decoded.baseUrl).toContain("20128");
  });

  it("rejects openai-compatible backend without baseUrl", () => {
    expect(() => decodeModelBackendConfig({ kind: "openai-compatible" })).toThrow();
  });

  it("rejects a blank baseUrl (must be trimmed non-empty)", () => {
    expect(() => decodeModelBackendConfig({ kind: "openai-compatible", baseUrl: "   " })).toThrow();
  });
});

describe("ModelBackendConnectionId", () => {
  it.each(["main-proxy", "omniroute", "proxy1", "x", "claudeAgent_proxy"])(
    "accepts user slug %s",
    (id) => {
      expect(decodeModelBackendConnectionId(id)).toBe(id);
    },
  );

  it("trims surrounding whitespace before validating", () => {
    expect(decodeModelBackendConnectionId("  main-proxy  ")).toBe("main-proxy");
  });

  it.each([
    ["empty string", ""],
    ["leading digit", "1proxy"],
    ["leading dash", "-proxy"],
    ["leading underscore", "_proxy"],
    ["whitespace inside", "main proxy"],
    ["dot inside", "main.proxy"],
  ])("rejects %s", (_label, value) => {
    expect(() => decodeModelBackendConnectionId(value)).toThrow();
  });

  it("rejects ids longer than 64 characters", () => {
    expect(() => decodeModelBackendConnectionId("a".repeat(65))).toThrow();
    expect(decodeModelBackendConnectionId("a".repeat(64))).toBe("a".repeat(64));
  });
});

describe("ModelProxyConfig", () => {
  it("preserves a Codex OAuth account reference without storing its token", () => {
    const decoded = decodeModelProxyConfig({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      codexAccountInstanceId: "codex-work",
      models: ["gpt-5.6-luna"],
    });
    expect(decoded).toHaveProperty("codexAccountInstanceId", "codex-work");
  });
  it("decodes a global proxy with baseUrl", () => {
    const decoded = decodeModelProxyConfig({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKeyEnv: "OMNIROUTE_API_KEY",
      displayName: "Omniroute",
    });
    expect(decoded.baseUrl).toContain("20128");
    expect(decoded.apiKeyEnv).toBe("OMNIROUTE_API_KEY");
    expect(decoded.displayName).toBe("Omniroute");
  });

  it("decodes a minimal global proxy without optional fields", () => {
    const decoded = decodeModelProxyConfig({ baseUrl: "http://127.0.0.1:20128/v1" });
    expect(decoded.baseUrl).toContain("20128");
    expect(decoded.apiKeyEnv).toBeUndefined();
    expect(decoded.displayName).toBeUndefined();
  });

  it("rejects a blank baseUrl (must be trimmed non-empty)", () => {
    expect(() => decodeModelProxyConfig({ baseUrl: "   " })).toThrow();
  });

  it("rejects a missing baseUrl (global is always a proxy)", () => {
    expect(() => decodeModelProxyConfig({})).toThrow();
  });

  it("ignores a stale kind field (global is always a proxy, no kind)", () => {
    const decoded = decodeModelProxyConfig({
      baseUrl: "http://127.0.0.1:20128/v1",
      kind: "openai-compatible",
    }) as Record<string, unknown>;
    expect(decoded["kind"]).toBeUndefined();
  });
});
