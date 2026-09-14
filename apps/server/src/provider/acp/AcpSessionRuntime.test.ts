import { describe, expect, it } from "vite-plus/test";

import { resolveAcpSpawnEnvironment } from "./AcpSessionRuntime.ts";

const BACKEND_BASE_URL = "http://127.0.0.1:20128/v1";

describe("AcpSessionRuntime backend spawn env", () => {
  it("merges the backend overlay over the spawn env", () => {
    const env = resolveAcpSpawnEnvironment(
      {
        command: "cursor-agent",
        args: ["acp"],
        cwd: "/workspace",
        env: {
          OPENAI_BASE_URL: "http://instance:9999/v1",
          T3_CUSTOM_KEEP: "kept",
        },
        backend: { kind: "openai-compatible", baseUrl: BACKEND_BASE_URL },
      },
      {},
    );

    // Backend overlay wins on OPENAI_*/ANTHROPIC_* keys...
    expect(env?.OPENAI_BASE_URL).toBe(BACKEND_BASE_URL);
    expect(env?.ANTHROPIC_BASE_URL).toBe(BACKEND_BASE_URL);
    // ...while unrelated spawn env is preserved.
    expect(env?.T3_CUSTOM_KEEP).toBe("kept");
  });

  it("leaves the spawn env untouched without a backend", () => {
    const spawnEnv = { OPENAI_BASE_URL: "http://instance:9999/v1" };
    expect(
      resolveAcpSpawnEnvironment(
        { command: "droid", args: ["exec", "--output-format", "acp"], env: spawnEnv },
        {},
      ),
    ).toBe(spawnEnv);
    expect(
      resolveAcpSpawnEnvironment(
        { command: "droid", args: ["exec", "--output-format", "acp"] },
        {},
      ),
    ).toBeUndefined();
  });
});
