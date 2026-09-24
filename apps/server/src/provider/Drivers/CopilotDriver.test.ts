import { describe, expect, it } from "@effect/vitest";

import { resolveCopilotBackendEnvironment } from "./CopilotDriver.ts";

describe("resolveCopilotBackendEnvironment", () => {
  it("points the CLI's BYOK mode at an openai-protocol backend with its key", () => {
    expect(
      resolveCopilotBackendEnvironment(
        { kind: "openai-compatible", baseUrl: "http://127.0.0.1:3773/openai", apiKey: "k" },
        {},
      ),
    ).toEqual({
      COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:3773/openai",
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_API_KEY: "k",
    });
  });

  it("resolves the key through apiKeyEnv and omits it when empty", () => {
    expect(
      resolveCopilotBackendEnvironment(
        {
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:3773/openai",
          apiKeyEnv: "CP_KEY",
        },
        { CP_KEY: "secret" },
      ).COPILOT_PROVIDER_API_KEY,
    ).toBe("secret");
    expect(
      resolveCopilotBackendEnvironment(
        {
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:3773/openai",
          apiKeyEnv: "MISSING",
        },
        {},
      ),
    ).toEqual({
      COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:3773/openai",
      COPILOT_PROVIDER_TYPE: "openai",
    });
  });

  it("leaves Anthropic-only backends on the instance's GitHub login (no live proof there)", () => {
    expect(
      resolveCopilotBackendEnvironment(
        { kind: "openai-compatible", baseUrl: "http://x/v1", protocols: ["anthropic"] },
        {},
      ),
    ).toEqual({});
  });

  it("stays empty without a backend or without a base URL", () => {
    expect(resolveCopilotBackendEnvironment(undefined, {})).toEqual({});
    expect(resolveCopilotBackendEnvironment({ kind: "native" }, {})).toEqual({});
    expect(resolveCopilotBackendEnvironment({ kind: "openai-compatible" }, {})).toEqual({});
  });
});
