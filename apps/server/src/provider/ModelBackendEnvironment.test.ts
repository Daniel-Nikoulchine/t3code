import { describe, expect, it } from "@effect/vitest";

import { resolveModelBackendEnvironment } from "./ModelBackendEnvironment.ts";

describe("resolveModelBackendEnvironment", () => {
  it("maps openai-compatible backend to OPENAI/ANTHROPIC overlay", () => {
    const env = resolveModelBackendEnvironment(
      { kind: "openai-compatible", baseUrl: "http://127.0.0.1:20128/v1", apiKeyEnv: "OMNI_KEY" },
      { OMNI_KEY: "secret" },
    );
    expect(env.OPENAI_BASE_URL).toBe("http://127.0.0.1:20128/v1");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20128/v1");
    expect(env.OPENAI_API_KEY).toBe("secret");
    expect(env.ANTHROPIC_API_KEY).toBe("secret");
  });

  it("ignores missing apiKeyEnv variable without adding keys", () => {
    const env = resolveModelBackendEnvironment(
      { kind: "openai-compatible", baseUrl: "http://127.0.0.1:20128/v1", apiKeyEnv: "MISSING_KEY" },
      {},
    );
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("does not mutate baseEnv", () => {
    const baseEnv = { OMNI_KEY: "secret" };
    resolveModelBackendEnvironment(
      { kind: "openai-compatible", baseUrl: "http://127.0.0.1:20128/v1", apiKeyEnv: "OMNI_KEY" },
      baseEnv,
    );
    expect(baseEnv).toEqual({ OMNI_KEY: "secret" });
  });

  it("resolves baseUrl without apiKeyEnv to URL-only overlay", () => {
    expect(
      resolveModelBackendEnvironment(
        { kind: "openai-compatible", baseUrl: "http://127.0.0.1:20128/v1" },
        {},
      ),
    ).toEqual({
      OPENAI_BASE_URL: "http://127.0.0.1:20128/v1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
    });
  });

  it("explicit both protocols reproduce the default dual-pair overlay", () => {
    const backend = {
      kind: "openai-compatible" as const,
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKeyEnv: "OMNI_KEY",
    };
    expect(resolveModelBackendEnvironment(backend, { OMNI_KEY: "secret" })).toEqual(
      resolveModelBackendEnvironment(
        { ...backend, protocols: ["openai", "anthropic"] },
        { OMNI_KEY: "secret" },
      ),
    );
  });

  it("anthropic-only protocols yield only the ANTHROPIC variable pair", () => {
    expect(
      resolveModelBackendEnvironment(
        {
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:20128/v1",
          apiKeyEnv: "OMNI_KEY",
          protocols: ["anthropic"],
        },
        { OMNI_KEY: "secret" },
      ),
    ).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
      ANTHROPIC_API_KEY: "secret",
    });
  });

  it("openai-only protocols yield only the OPENAI variable pair", () => {
    expect(
      resolveModelBackendEnvironment(
        {
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:20128/v1",
          apiKeyEnv: "OMNI_KEY",
          protocols: ["openai"],
        },
        { OMNI_KEY: "secret" },
      ),
    ).toEqual({
      OPENAI_BASE_URL: "http://127.0.0.1:20128/v1",
      OPENAI_API_KEY: "secret",
    });
  });

  it("prefers a resolved credential apiKey over the apiKeyEnv lookup", () => {
    const env = resolveModelBackendEnvironment(
      {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:20128/v1",
        apiKey: "sk-stored-credential",
        apiKeyEnv: "OMNI_KEY",
      },
      { OMNI_KEY: "env-secret" },
    );
    expect(env.OPENAI_API_KEY).toBe("sk-stored-credential");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-stored-credential");
  });

  it("resolves a credential apiKey without an apiKeyEnv indirection", () => {
    expect(
      resolveModelBackendEnvironment(
        {
          kind: "openai-compatible",
          baseUrl: "http://127.0.0.1:20128/v1",
          apiKey: "sk-stored-credential",
        },
        {},
      ),
    ).toEqual({
      OPENAI_BASE_URL: "http://127.0.0.1:20128/v1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1",
      OPENAI_API_KEY: "sk-stored-credential",
      ANTHROPIC_API_KEY: "sk-stored-credential",
    });
  });

  it("native backend resolves to empty overlay", () => {
    expect(resolveModelBackendEnvironment({ kind: "native" }, {})).toEqual({});
  });

  it("undefined backend resolves to empty overlay", () => {
    expect(resolveModelBackendEnvironment(undefined, {})).toEqual({});
  });
});
