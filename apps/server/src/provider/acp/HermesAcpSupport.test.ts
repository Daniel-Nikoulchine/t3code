import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  advertisedHermesModelIds,
  buildHermesAcpSpawnInput,
  resolveHermesModelId,
  resolveHermesSessionModelId,
} from "./HermesAcpSupport.ts";

describe("Hermes ACP support", () => {
  it("starts the official Hermes ACP server with the instance environment", () => {
    expect(
      buildHermesAcpSpawnInput({ binaryPath: "/opt/bin/hermes" }, "/workspace", {
        HERMES_HOME: "/tmp/hermes",
      }),
    ).toEqual({
      command: "/opt/bin/hermes",
      args: ["acp"],
      cwd: "/workspace",
      env: { HERMES_HOME: "/tmp/hermes" },
    });
  });

  it("keeps Hermes' configured model for the default sentinel", () => {
    expect(resolveHermesModelId("default")).toBeUndefined();
    expect(resolveHermesModelId(" openrouter:anthropic/claude-sonnet-4.6 ")).toBe(
      "openrouter:anthropic/claude-sonnet-4.6",
    );
  });

  it("collects the advertised Hermes catalog from the session model state", () => {
    const state = {
      currentModelId: "b-ai:deepseek-v4-flash",
      availableModels: [
        { modelId: "b-ai:deepseek-v4-flash", name: "b.ai · deepseek-v4-flash" },
        { modelId: "bynara:muse-spark-1.3-contributor-free", name: "bynara · ..." },
      ],
    } satisfies EffectAcpSchema.SessionModelState;
    expect(advertisedHermesModelIds(state)).toEqual(
      new Set(["b-ai:deepseek-v4-flash", "bynara:muse-spark-1.3-contributor-free"]),
    );
    expect(advertisedHermesModelIds(null)).toBeUndefined();
    expect(advertisedHermesModelIds({ currentModelId: "", availableModels: [] })).toBeUndefined();
  });

  it("passes known Hermes ids and the default sentinel through", () => {
    const advertised = new Set(["b-ai:glm-5.3-flash", "default"]);
    expect(resolveHermesSessionModelId("b-ai:glm-5.3-flash", advertised)).toBe(
      "b-ai:glm-5.3-flash",
    );
    expect(resolveHermesSessionModelId("default", advertised)).toBeUndefined();
    expect(resolveHermesSessionModelId("  ", advertised)).toBeUndefined();
  });

  it("sends the id as-is when Hermes reported no catalog", () => {
    expect(resolveHermesSessionModelId("b-ai:glm-5.3-flash", undefined)).toBe("b-ai:glm-5.3-flash");
    expect(resolveHermesSessionModelId("b-ai:glm-5.3-flash", new Set())).toBe("b-ai:glm-5.3-flash");
  });

  it("passes every provider variant of a multi-provider model through untouched", () => {
    const advertised = new Set([
      "b-ai:glm-5.3-flash",
      "nous:z-ai/glm-5.3-flash",
      "bynara:glm-5.3-flash",
      "custom:b-ai:glm-5.3-flash",
    ]);
    // Each advertised `provider:model` choice is sent byte-for-byte; the
    // resolver never rewrites a known id to another provider.
    for (const choice of advertised) {
      expect(resolveHermesSessionModelId(choice, advertised)).toBe(choice);
    }
  });

  it("canonicalizes casing to the advertised Hermes choice", () => {
    // Provider namespaces are case-sensitive downstream (`MiniMaxAI`
    // works where `minimax` 404s), so the advertised casing wins.
    const advertised = new Set(["b-ai:MiniMaxAI/MiniMax-M3"]);
    expect(resolveHermesSessionModelId("B-AI:minimaxai/minimax-m3", advertised)).toBe(
      "b-ai:MiniMaxAI/MiniMax-M3",
    );
  });

  it("falls back to the session model for anything Hermes does not advertise", () => {
    const advertised = new Set([
      "b-ai:minimax-m3",
      "nous:minimax/minimax-m3",
      "bynara:muse-spark-1.3-contributor-free",
    ]);
    // Stale provider that no longer exists.
    expect(resolveHermesSessionModelId("gmi:MiniMaxAI/MiniMax-M3", advertised)).toBeUndefined();
    // Unknown provider slug.
    expect(resolveHermesSessionModelId("opencode/does-not-exist-9", advertised)).toBeUndefined();
    // Cross-provider pick, even when the bare name matches exactly one
    // advertised entry: same bare name is not the same model, and Hermes
    // misroutes it (observed 401 via opencode-zen for a stale
    // `tokenrouter:…/glm-5.3-free` pick).
    expect(
      resolveHermesSessionModelId("tokenrouter:z-ai/glm-5.3-free", advertised),
    ).toBeUndefined();
    expect(
      resolveHermesSessionModelId("opencode/muse-spark-1.3-contributor-free", advertised),
    ).toBeUndefined();
    // Bare names are never sent: Hermes' own name detection misroutes them
    // the same way (observed 401 `Model glm-5.3-free is not supported`).
    expect(resolveHermesSessionModelId("glm-5.3-flash", advertised)).toBeUndefined();
    expect(
      resolveHermesSessionModelId("muse-spark-1.3-contributor-free", advertised),
    ).toBeUndefined();
  });
});
