import { describe, expect, it } from "vite-plus/test";

import {
  buildKiloAcpSpawnInput,
  currentKiloModelFromSessionSetup,
  resolveKiloModelId,
} from "./KiloAcpSupport.ts";

describe("Kilo ACP support", () => {
  it("starts the official Kilo ACP server with the instance environment", () => {
    expect(
      buildKiloAcpSpawnInput({ binaryPath: "/opt/bin/kilo" }, "/workspace", {
        SOME_KEY: "some-value",
      }),
    ).toEqual({
      command: "/opt/bin/kilo",
      args: ["acp"],
      cwd: "/workspace",
      env: { SOME_KEY: "some-value" },
    });
  });

  it("falls back to kilo on PATH", () => {
    expect(buildKiloAcpSpawnInput({ binaryPath: "" }, "/workspace")).toEqual({
      command: "kilo",
      args: ["acp"],
      cwd: "/workspace",
    });
  });

  it("keeps Kilo's configured model for the auto/default sentinels", () => {
    expect(resolveKiloModelId("auto")).toBeUndefined();
    expect(resolveKiloModelId(" AUTO ")).toBeUndefined();
    expect(resolveKiloModelId("default")).toBeUndefined();
    expect(resolveKiloModelId(" Default ")).toBeUndefined();
    expect(resolveKiloModelId("")).toBeUndefined();
    expect(resolveKiloModelId(null)).toBeUndefined();
    expect(resolveKiloModelId(" anthropic/claude-sonnet-4-20250514 ")).toBe(
      "anthropic/claude-sonnet-4-20250514",
    );
  });

  it("reads the current model from the models payload when present", () => {
    expect(
      currentKiloModelFromSessionSetup({
        sessionId: "ses-1",
        models: {
          currentModelId: "kilo/anthropic/claude-opus-4.7",
          availableModels: [],
        },
      } as never),
    ).toBe("kilo/anthropic/claude-opus-4.7");
  });

  it("falls back to the model select currentValue (real kilo session/new shape)", () => {
    expect(
      currentKiloModelFromSessionSetup({
        sessionId: "ses-1",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "kilo/google/gemini-3-pro-image",
            options: [],
          },
        ],
      } as never),
    ).toBe("kilo/google/gemini-3-pro-image");
    expect(currentKiloModelFromSessionSetup({ sessionId: "ses-1" } as never)).toBeUndefined();
  });
});
