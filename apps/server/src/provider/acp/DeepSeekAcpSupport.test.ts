import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDeepSeekAcpModelSelection,
  buildDeepSeekAcpSpawnInput,
  currentDeepSeekSelectionFromConfigOptions,
  deepseekAcpSpawnArgs,
  displayDeepSeekModelSlug,
  flattenDeepSeekModelOptionEntries,
  isValidDeepSeekReasoningEffortToken,
  resolveDeepSeekAcpBaseModelId,
  resolveDeepSeekModelOptionValue,
} from "./DeepSeekAcpSupport.ts";

const FLASH_PAIR = '["deepseek-official","deepseek-v4-flash"]';
const PRO_PAIR = '["deepseek-official","deepseek-v4-pro"]';

// Mirrors the grouped `model` + `reasoning_effort` options of `dsh --profile acp`.
const groupedConfigOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: FLASH_PAIR,
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: FLASH_PAIR, name: "DeepSeek-V4-Flash" },
          { value: PRO_PAIR, name: "DeepSeek-V4-Pro" },
        ],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "off", name: "Off" },
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
] as const;

type ModelSelectionRuntime = {
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly getConfigOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
};

describe("resolveDeepSeekAcpBaseModelId", () => {
  it("normalizes empty and custom DeepSeek model ids", () => {
    expect(resolveDeepSeekAcpBaseModelId(undefined)).toBe("deepseek-v4-flash");
    expect(resolveDeepSeekAcpBaseModelId("   ")).toBe("deepseek-v4-flash");
    expect(resolveDeepSeekAcpBaseModelId("  deepseek-test-custom-model  ")).toBe(
      "deepseek-test-custom-model",
    );
  });
});

describe("deepseekAcpSpawnArgs", () => {
  it("serves the shipped acp profile regardless of T3 runtime mode", () => {
    expect(deepseekAcpSpawnArgs()).toEqual(["--profile", "acp"]);
    expect(deepseekAcpSpawnArgs("approval-required")).toEqual(["--profile", "acp"]);
    expect(deepseekAcpSpawnArgs("auto-accept-edits")).toEqual(["--profile", "acp"]);
    expect(deepseekAcpSpawnArgs("auto")).toEqual(["--profile", "acp"]);
    expect(deepseekAcpSpawnArgs("full-access")).toEqual(["--profile", "acp"]);
  });
});

describe("buildDeepSeekAcpSpawnInput", () => {
  it("spawns dsh with the acp profile and passes the environment through", () => {
    const spawn = buildDeepSeekAcpSpawnInput({ binaryPath: "/usr/local/bin/dsh" }, "/tmp/project", {
      DEEPSEEK_API_KEY: "secret",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/dsh",
      args: ["--profile", "acp"],
      cwd: "/tmp/project",
      env: {
        DEEPSEEK_API_KEY: "secret",
      },
    });
  });

  it("defaults to dsh on PATH when no binary path is configured", () => {
    const spawn = buildDeepSeekAcpSpawnInput({ binaryPath: "" }, "/tmp/project", undefined);
    expect(spawn.command).toBe("dsh");
    expect(spawn.args).toEqual(["--profile", "acp"]);
  });
});

describe("isValidDeepSeekReasoningEffortToken", () => {
  it("accepts future ACP tokens and rejects malformed metadata values", () => {
    expect(isValidDeepSeekReasoningEffortToken("high")).toBe(true);
    expect(isValidDeepSeekReasoningEffortToken("max")).toBe(true);
    expect(isValidDeepSeekReasoningEffortToken("not a token")).toBe(false);
    expect(isValidDeepSeekReasoningEffortToken("-leading-dash")).toBe(false);
    expect(isValidDeepSeekReasoningEffortToken("x".repeat(33))).toBe(false);
  });
});

describe("flattenDeepSeekModelOptionEntries", () => {
  it("flattens grouped provider routes", () => {
    expect(
      flattenDeepSeekModelOptionEntries(
        groupedConfigOptions as unknown as ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      ),
    ).toEqual([
      { value: FLASH_PAIR, name: "DeepSeek-V4-Flash" },
      { value: PRO_PAIR, name: "DeepSeek-V4-Pro" },
    ]);
  });

  it("returns an empty list without a model option", () => {
    expect(flattenDeepSeekModelOptionEntries([])).toEqual([]);
    expect(flattenDeepSeekModelOptionEntries(undefined)).toEqual([]);
  });
});

describe("resolveDeepSeekModelOptionValue", () => {
  const options =
    groupedConfigOptions as unknown as ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

  it("passes exact route values through", () => {
    expect(resolveDeepSeekModelOptionValue(FLASH_PAIR, options)).toBe(FLASH_PAIR);
  });

  it("resolves friendly slugs to their route pair", () => {
    expect(resolveDeepSeekModelOptionValue("deepseek-v4-flash", options)).toBe(FLASH_PAIR);
    expect(resolveDeepSeekModelOptionValue("deepseek-v4-pro", options)).toBe(PRO_PAIR);
  });

  it("resolves display names to their route pair", () => {
    expect(resolveDeepSeekModelOptionValue("DeepSeek-V4-Pro", options)).toBe(PRO_PAIR);
  });

  it("sends unknown slugs raw so the server validates them", () => {
    expect(resolveDeepSeekModelOptionValue("deepseek-future-x", options)).toBe("deepseek-future-x");
    expect(resolveDeepSeekModelOptionValue("deepseek-v4-flash", [])).toBe("deepseek-v4-flash");
  });
});

describe("displayDeepSeekModelSlug", () => {
  it("collapses route pairs to their model element", () => {
    expect(displayDeepSeekModelSlug(FLASH_PAIR)).toBe("deepseek-v4-flash");
    expect(displayDeepSeekModelSlug("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(displayDeepSeekModelSlug(undefined)).toBeUndefined();
  });
});

describe("currentDeepSeekSelectionFromConfigOptions", () => {
  it("reads the live model and effort from session config", () => {
    expect(
      currentDeepSeekSelectionFromConfigOptions(
        groupedConfigOptions as unknown as ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      ),
    ).toEqual({ modelId: FLASH_PAIR, reasoningEffort: "high" });
  });

  it("returns undefined without config options", () => {
    expect(currentDeepSeekSelectionFromConfigOptions(undefined)).toEqual({
      modelId: undefined,
      reasoningEffort: undefined,
    });
  });
});

describe("applyDeepSeekAcpModelSelection", () => {
  const makeRecordingRuntime = (
    failure?: EffectAcpErrors.AcpError,
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = groupedConfigOptions as unknown as ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ): {
    readonly runtime: ModelSelectionRuntime;
    readonly modelCalls: Array<string>;
    readonly configCalls: Array<{ configId: string; value: string | boolean }>;
  } => {
    const modelCalls: Array<string> = [];
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    const runtime: ModelSelectionRuntime = {
      setModel: (model: string): Effect.Effect<void, EffectAcpErrors.AcpError> =>
        Effect.gen(function* () {
          modelCalls.push(model);
          if (failure !== undefined) {
            return yield* failure;
          }
        }),
      setConfigOption: (
        configId: string,
        value: string | boolean,
      ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
        Effect.gen(function* () {
          configCalls.push({ configId, value });
          if (failure !== undefined) {
            return yield* failure;
          }
          return { configOptions: [] };
        }),
      getConfigOptions: Effect.succeed(configOptions),
    };
    return { runtime, modelCalls, configCalls };
  };

  it.effect("resolves a friendly slug to its route pair when the model differs", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyDeepSeekAcpModelSelection({
        runtime,
        currentModelId: FLASH_PAIR,
        requestedModelId: "deepseek-v4-pro",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([PRO_PAIR]);
      expect(configCalls).toEqual([]);
      expect(result).toEqual({ wiredModelId: PRO_PAIR, displayModelId: "deepseek-v4-pro" });
    }),
  );

  it.effect("skips setModel when the friendly slug already matches the session route", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyDeepSeekAcpModelSelection({
        runtime,
        currentModelId: FLASH_PAIR,
        requestedModelId: "deepseek-v4-flash",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([]);
      expect(result).toEqual({ wiredModelId: FLASH_PAIR, displayModelId: "deepseek-v4-flash" });
    }),
  );

  it.effect("applies reasoning effort through the reasoning_effort config option", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyDeepSeekAcpModelSelection({
        runtime,
        currentModelId: FLASH_PAIR,
        currentReasoningEffort: "high",
        requestedModelId: "deepseek-v4-flash",
        requestedReasoningEffort: "low",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([{ configId: "reasoning_effort", value: "low" }]);
      expect(result.wiredModelId).toBe(FLASH_PAIR);
    }),
  );

  it.effect("does not clear reasoning when same-model selection omits effort", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyDeepSeekAcpModelSelection({
        runtime,
        currentModelId: FLASH_PAIR,
        currentReasoningEffort: "high",
        requestedModelId: "deepseek-v4-flash",
        requestedReasoningEffort: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([]);
      expect(result.wiredModelId).toBe(FLASH_PAIR);
    }),
  );

  it.effect("drops malformed effort values instead of sending them", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime();
      const result = yield* applyDeepSeekAcpModelSelection({
        runtime,
        currentModelId: FLASH_PAIR,
        currentReasoningEffort: "high",
        requestedModelId: "deepseek-v4-flash",
        requestedReasoningEffort: "not a token",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(configCalls).toEqual([]);
      expect(result.wiredModelId).toBe(FLASH_PAIR);
    }),
  );

  it.effect("skips reasoning updates when the model declares no effort option", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls, configCalls } = makeRecordingRuntime(undefined, []);
      const result = yield* applyDeepSeekAcpModelSelection({
        runtime,
        currentModelId: FLASH_PAIR,
        currentReasoningEffort: "high",
        requestedModelId: "deepseek-v4-flash",
        requestedReasoningEffort: "low",
        mapError: (cause) => cause.message,
      });
      // Without advertised options the slug goes over the wire raw; there is
      // still no reasoning option to update.
      expect(modelCalls).toEqual(["deepseek-v4-flash"]);
      expect(configCalls).toEqual([]);
      expect(result.wiredModelId).toBe("deepseek-v4-flash");
    }),
  );

  it.effect("propagates config update failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyDeepSeekAcpModelSelection({
          runtime,
          currentModelId: FLASH_PAIR,
          requestedModelId: "deepseek-v4-pro",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
