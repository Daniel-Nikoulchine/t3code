import { describe, expect, it } from "@effect/vitest";

import {
  buildMinimaxAcpSpawnInput,
  currentMinimaxModelFromSessionSetup,
  MINIMAX_AUTH_METHOD_ID,
  MINIMAX_THINKING_EFFORT_CONFIG_ID,
  minimaxThinkingEffortFromSessionSetup,
  parseMinimaxVersion,
  resolveMinimaxModelId,
} from "./MinimaxAcpSupport.ts";

describe("minimax ACP identity", () => {
  it("uses the documented auth method id and acp spawn", () => {
    expect(MINIMAX_AUTH_METHOD_ID).toBe("minimax-code-login");
    expect(buildMinimaxAcpSpawnInput({ binaryPath: "" }, "/tmp/project", undefined)).toEqual({
      command: "mcode",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("parses the bare semver version", () => {
    expect(parseMinimaxVersion("0.4.12\n")).toBe("0.4.12");
    expect(parseMinimaxVersion("nope")).toBeNull();
  });
});

describe("resolveMinimaxModelId", () => {
  it("treats empty and the default product slug as keep-current", () => {
    expect(resolveMinimaxModelId(undefined)).toBeUndefined();
    expect(resolveMinimaxModelId("   ")).toBeUndefined();
    expect(resolveMinimaxModelId("default")).toBeUndefined();
  });

  it("passes concrete model ids through trimmed", () => {
    expect(resolveMinimaxModelId("  MiniMax-M3  ")).toBe("MiniMax-M3");
  });
});

describe("currentMinimaxModelFromSessionSetup", () => {
  it("prefers the models payload, then the model select", () => {
    expect(
      currentMinimaxModelFromSessionSetup({
        models: { currentModelId: "MiniMax-M3" },
      } as never),
    ).toBe("MiniMax-M3");
    expect(
      currentMinimaxModelFromSessionSetup({
        configOptions: [{ id: "model", type: "select", currentValue: "MiniMax-M2.5" }],
      } as never),
    ).toBe("MiniMax-M2.5");
    expect(currentMinimaxModelFromSessionSetup({} as never)).toBeUndefined();
  });
});

describe("minimaxThinkingEffortFromSessionSetup", () => {
  const effortSelect = {
    id: MINIMAX_THINKING_EFFORT_CONFIG_ID,
    type: "select",
    currentValue: "off",
    options: [
      { value: "off", name: "Off" },
      { value: "minimal", name: "Minimal" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "xhigh", name: "Xhigh" },
      { value: "max", name: "Max" },
    ],
  };
  it("reads the advertised levels and current value (live shape)", () => {
    expect(
      minimaxThinkingEffortFromSessionSetup({ configOptions: [effortSelect] } as never),
    ).toEqual({
      options: [
        { value: "off", name: "Off" },
        { value: "minimal", name: "Minimal" },
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Xhigh" },
        { value: "max", name: "Max" },
      ],
      current: "off",
    });
  });

  it("returns undefined without the select, with wrong type, or with no options", () => {
    expect(minimaxThinkingEffortFromSessionSetup({} as never)).toBeUndefined();
    expect(
      minimaxThinkingEffortFromSessionSetup({
        configOptions: [{ ...effortSelect, type: "boolean" }],
      } as never),
    ).toBeUndefined();
    expect(
      minimaxThinkingEffortFromSessionSetup({
        configOptions: [{ ...effortSelect, options: [] }],
      } as never),
    ).toBeUndefined();
  });
});
