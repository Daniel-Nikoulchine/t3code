import { describe, expect, it } from "@effect/vitest";

import { resolveDeepSeekBackendEnvironment } from "./DeepSeekDriver.ts";

describe("resolveDeepSeekBackendEnvironment", () => {
  it("points dsh at an openai-protocol backend with its key", () => {
    expect(
      resolveDeepSeekBackendEnvironment(
        { kind: "openai-compatible", baseUrl: "http://127.0.0.1:3773/openai", apiKey: "k" },
        {},
      ),
    ).toEqual({
      DEEPSEEK_BASE_URL: "http://127.0.0.1:3773/openai",
      DEEPSEEK_API_KEY: "k",
    });
  });

  it("resolves the key through apiKeyEnv and omits it when empty", () => {
    expect(
      resolveDeepSeekBackendEnvironment(
        {
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:3773/openai",
          apiKeyEnv: "DS_KEY",
        },
        { DS_KEY: "secret" },
      ).DEEPSEEK_API_KEY,
    ).toBe("secret");
    expect(
      resolveDeepSeekBackendEnvironment(
        {
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:3773/openai",
          apiKeyEnv: "MISSING",
        },
        {},
      ),
    ).toEqual({ DEEPSEEK_BASE_URL: "http://127.0.0.1:3773/openai" });
  });

  it("leaves anthropic-only backends alone; dsh speaks chat completions", () => {
    expect(
      resolveDeepSeekBackendEnvironment(
        { kind: "openai-compatible", baseUrl: "http://x/v1", protocols: ["anthropic"] },
        {},
      ),
    ).toEqual({});
  });

  it("stays empty without a backend", () => {
    expect(resolveDeepSeekBackendEnvironment(undefined, {})).toEqual({});
    expect(resolveDeepSeekBackendEnvironment({ kind: "native" }, {})).toEqual({});
  });
});
