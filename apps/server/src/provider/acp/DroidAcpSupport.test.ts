import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  advertisedDroidModelIds,
  buildDroidAcpSpawnInput,
  droidAcpAutonomyArgs,
  resolveDroidAcpBaseModelId,
  resolveDroidAuthMethodId,
  resolveDroidSessionModelId,
} from "./DroidAcpSupport.ts";

describe("Droid ACP support", () => {
  it("spawns the official Droid ACP server with the instance environment", () => {
    expect(
      buildDroidAcpSpawnInput({ binaryPath: "/opt/bin/droid" }, "/workspace", {
        FACTORY_API_KEY: "fk-test",
      }),
    ).toEqual({
      command: "/opt/bin/droid",
      args: ["exec", "--output-format", "acp"],
      cwd: "/workspace",
      env: { FACTORY_API_KEY: "fk-test" },
    });
  });

  it("falls back to the PATH droid binary", () => {
    expect(buildDroidAcpSpawnInput(null, "/workspace").command).toBe("droid");
  });

  it("authenticates with the API key method when FACTORY_API_KEY is set", () => {
    expect(resolveDroidAuthMethodId({ FACTORY_API_KEY: "fk-test" })).toBe("factory-api-key");
    expect(resolveDroidAuthMethodId({ FACTORY_API_KEY: "   " })).toBe("device-pairing");
    expect(resolveDroidAuthMethodId({})).toBe("device-pairing");
    expect(resolveDroidAuthMethodId(undefined)).toBe("device-pairing");
  });

  it("maps T3 runtime modes onto droid exec autonomy flags", () => {
    expect(droidAcpAutonomyArgs("approval-required")).toEqual([]);
    expect(droidAcpAutonomyArgs("auto-accept-edits")).toEqual(["--auto", "low"]);
    expect(droidAcpAutonomyArgs("auto")).toEqual(["--auto", "medium"]);
    expect(droidAcpAutonomyArgs("full-access")).toEqual(["--skip-permissions-unsafe"]);
    expect(droidAcpAutonomyArgs(undefined)).toEqual([]);
  });

  it("carries the runtime mode autonomy flags into the spawn input", () => {
    expect(
      buildDroidAcpSpawnInput({ binaryPath: "droid" }, "/workspace", undefined, "full-access").args,
    ).toEqual(["exec", "--output-format", "acp", "--skip-permissions-unsafe"]);
  });

  it("resolves the base model id and keeps the auto sentinel", () => {
    expect(resolveDroidAcpBaseModelId("auto")).toBe("auto");
    expect(resolveDroidAcpBaseModelId("  ")).toBe("auto");
    expect(resolveDroidAcpBaseModelId(null)).toBe("auto");
    expect(resolveDroidAcpBaseModelId("claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  it("collects the advertised Droid catalog from the session model state", () => {
    const state = {
      currentModelId: "claude-opus-4-7",
      availableModels: [
        { modelId: "claude-opus-4-7", name: "Claude Opus 4.7" },
        { modelId: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
      ],
    } satisfies EffectAcpSchema.SessionModelState;
    expect(advertisedDroidModelIds(state)).toEqual(new Set(["claude-opus-4-7", "gpt-5.3-codex"]));
    expect(advertisedDroidModelIds(null)).toBeUndefined();
    expect(advertisedDroidModelIds({ currentModelId: "", availableModels: [] })).toBeUndefined();
  });

  it("keeps the session model for the auto sentinel", () => {
    const advertised = new Set(["claude-opus-4-7", "auto"]);
    expect(resolveDroidSessionModelId("auto", advertised)).toBeUndefined();
    expect(resolveDroidSessionModelId("  ", advertised)).toBeUndefined();
    expect(resolveDroidSessionModelId(null, advertised)).toBeUndefined();
  });

  it("passes known Droid ids through and canonicalizes casing", () => {
    const advertised = new Set(["claude-opus-4-7", "MiniMaxAI/MiniMax-M3"]);
    expect(resolveDroidSessionModelId("claude-opus-4-7", advertised)).toBe("claude-opus-4-7");
    expect(resolveDroidSessionModelId("minimaxai/minimax-m3", advertised)).toBe(
      "MiniMaxAI/MiniMax-M3",
    );
  });

  it("sends the id as-is when Droid reported no catalog", () => {
    expect(resolveDroidSessionModelId("claude-opus-4-7", undefined)).toBe("claude-opus-4-7");
    expect(resolveDroidSessionModelId("claude-opus-4-7", new Set())).toBe("claude-opus-4-7");
  });

  it("falls back to the session model for anything Droid does not advertise", () => {
    const advertised = new Set(["claude-opus-4-7"]);
    expect(resolveDroidSessionModelId("opencode/does-not-exist-9", advertised)).toBeUndefined();
  });
});
