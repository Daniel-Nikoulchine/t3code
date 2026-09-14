import { describe, expect, it } from "@effect/vitest";

import {
  COPILOT_DEFAULT_MODEL_SLUG,
  COPILOT_KNOWN_MODELS,
  copilotAcpSpawnArgs,
  buildCopilotAcpSpawnInput,
  isValidCopilotEffortToken,
  normalizeCopilotEffort,
  resolveCopilotAcpBaseModelId,
} from "./CopilotAcpSupport.ts";

describe("resolveCopilotAcpBaseModelId", () => {
  it("defaults empty selections to auto", () => {
    expect(resolveCopilotAcpBaseModelId(null)).toBe(COPILOT_DEFAULT_MODEL_SLUG);
    expect(resolveCopilotAcpBaseModelId(undefined)).toBe(COPILOT_DEFAULT_MODEL_SLUG);
    expect(resolveCopilotAcpBaseModelId("  ")).toBe(COPILOT_DEFAULT_MODEL_SLUG);
  });

  it("passes known slugs through and strips variant suffixes", () => {
    expect(resolveCopilotAcpBaseModelId("gpt-5.4")).toBe("gpt-5.4");
    expect(resolveCopilotAcpBaseModelId("gpt-5.4[high]")).toBe("gpt-5.4");
    expect(resolveCopilotAcpBaseModelId("  auto  ")).toBe("auto");
  });
});

describe("copilot effort", () => {
  it("accepts the CLI effort levels case-insensitively", () => {
    for (const level of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(isValidCopilotEffortToken(level)).toBe(true);
      expect(normalizeCopilotEffort(level.toUpperCase())).toBe(level);
    }
  });

  it("rejects unknown levels", () => {
    expect(isValidCopilotEffortToken("ultra")).toBe(false);
    expect(normalizeCopilotEffort("ultra")).toBeUndefined();
    expect(normalizeCopilotEffort(null)).toBeUndefined();
  });
});

describe("copilotAcpSpawnArgs", () => {
  it("always starts in ACP mode with no extra flags by default", () => {
    expect(copilotAcpSpawnArgs({})).toEqual(["--acp"]);
  });

  it("passes model and effort through", () => {
    expect(copilotAcpSpawnArgs({ model: "gpt-5.4", effort: "max" })).toEqual([
      "--acp",
      "--model",
      "gpt-5.4",
      "--effort",
      "max",
    ]);
  });

  it("drops invalid effort values", () => {
    expect(copilotAcpSpawnArgs({ effort: "ultra" })).toEqual(["--acp"]);
  });
});

describe("buildCopilotAcpSpawnInput", () => {
  it("falls back to the copilot binary on PATH", () => {
    const input = buildCopilotAcpSpawnInput(null, "/tmp", undefined, { model: "auto" });
    expect(input.command).toBe("copilot");
    expect(input.args).toEqual(["--acp", "--model", "auto"]);
    expect(input.cwd).toBe("/tmp");
  });

  it("honors a custom binary path", () => {
    const input = buildCopilotAcpSpawnInput({ binaryPath: "/opt/copilot" }, "/tmp");
    expect(input.command).toBe("/opt/copilot");
  });
});

describe("COPILOT_KNOWN_MODELS", () => {
  it("advertises auto as the default entry", () => {
    expect(COPILOT_KNOWN_MODELS[0]).toMatchObject({ slug: "auto" });
    expect(COPILOT_KNOWN_MODELS.length).toBeGreaterThan(20);
  });
});
