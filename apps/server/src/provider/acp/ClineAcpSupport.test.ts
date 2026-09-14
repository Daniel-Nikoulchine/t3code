import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyClineAcpAutoApprove,
  applyClineAcpModeSelection,
  applyClineAcpModelSelection,
  buildClineAcpSpawnInput,
  CLINE_AUTH_METHOD_ID,
  clineAcpPermissionArgs,
  resolveClineModeId,
  resolveClineModelId,
} from "./ClineAcpSupport.ts";

describe("resolveClineModelId", () => {
  it("treats empty and the default product slug as keep-current", () => {
    expect(resolveClineModelId(undefined)).toBeUndefined();
    expect(resolveClineModelId("   ")).toBeUndefined();
    expect(resolveClineModelId("default")).toBeUndefined();
    expect(resolveClineModelId("  default  ")).toBeUndefined();
  });

  it("passes concrete model ids through trimmed", () => {
    expect(resolveClineModelId("  anthropic/claude-sonnet-5  ")).toBe("anthropic/claude-sonnet-5");
  });
});

describe("clineAcpPermissionArgs", () => {
  it("leaves approval to the permission UI unless T3 is Full access", () => {
    expect(clineAcpPermissionArgs()).toEqual([]);
    expect(clineAcpPermissionArgs("approval-required")).toEqual([]);
    expect(clineAcpPermissionArgs("auto-accept-edits")).toEqual([]);
    expect(clineAcpPermissionArgs("auto")).toEqual([]);
  });

  it("maps Full access onto Cline auto-approve", () => {
    expect(clineAcpPermissionArgs("full-access")).toEqual(["--auto-approve", "true"]);
  });
});

describe("buildClineAcpSpawnInput", () => {
  it("spawns the Cline CLI in ACP mode", () => {
    const spawn = buildClineAcpSpawnInput({ binaryPath: "/usr/local/bin/cline" }, "/tmp/project", {
      SOME_ENV: "kept",
    });

    expect(spawn).toEqual({
      command: "/usr/local/bin/cline",
      args: ["--acp"],
      cwd: "/tmp/project",
      env: { SOME_ENV: "kept" },
    });
  });

  it("falls back to PATH lookup and forwards Full access", () => {
    const spawn = buildClineAcpSpawnInput(
      { binaryPath: "" },
      "/tmp/project",
      undefined,
      "full-access",
    );
    expect(spawn.command).toBe("cline");
    expect(spawn.args).toEqual(["--auto-approve", "true", "--acp"]);
  });

  it("documents the default ACP auth method", () => {
    expect(CLINE_AUTH_METHOD_ID).toBe("cline");
  });
});

describe("resolveClineModeId", () => {
  it("maps T3 interaction modes onto Cline plan/act", () => {
    expect(resolveClineModeId("plan")).toBe("plan");
    expect(resolveClineModeId("default")).toBe("act");
    expect(resolveClineModeId(undefined)).toBeUndefined();
    expect(resolveClineModeId(null)).toBeUndefined();
  });
});

describe("applyClineAcpModelSelection", () => {
  const makeRecordingRuntime = () => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setModel: (model: string) =>
        Effect.sync(() => {
          modelCalls.push(model);
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("sets the model through the model config option", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyClineAcpModelSelection({
        runtime,
        model: "anthropic/claude-sonnet-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["anthropic/claude-sonnet-5"]);
    }),
  );

  it.effect("skips the RPC for the default product slug", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      yield* applyClineAcpModelSelection({
        runtime,
        model: "default",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("propagates failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model");
      const runtime = {
        setModel: (_model: string) => failure,
      };
      const error = yield* Effect.flip(
        applyClineAcpModelSelection({
          runtime,
          model: "does/not-exist",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("applyClineAcpModeSelection", () => {
  it.effect("applies plan and act through setMode", () =>
    Effect.gen(function* () {
      const modeCalls: Array<string> = [];
      const runtime = {
        setMode: (modeId: string) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => modeCalls.push(modeId));
            return {};
          }),
      };
      yield* applyClineAcpModeSelection({
        runtime,
        interactionMode: "plan",
        mapError: (cause) => cause.message,
      });
      yield* applyClineAcpModeSelection({
        runtime,
        interactionMode: "default",
        mapError: (cause) => cause.message,
      });
      expect(modeCalls).toEqual(["plan", "act"]);
    }),
  );

  it.effect("skips setMode without an interaction mode", () =>
    Effect.gen(function* () {
      const modeCalls: Array<string> = [];
      const runtime = {
        setMode: (modeId: string) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => modeCalls.push(modeId));
            return {};
          }),
      };
      yield* applyClineAcpModeSelection({
        runtime,
        interactionMode: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modeCalls).toEqual([]);
    }),
  );
});

describe("applyClineAcpAutoApprove", () => {
  const makeRecordingRuntime = () => {
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    const runtime = {
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => configCalls.push({ configId, value }));
          return { configOptions: [] };
        }),
    };
    return { runtime, configCalls };
  };

  it.effect("sends the string form Cline accepts, never a JSON boolean", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime();
      yield* applyClineAcpAutoApprove({ runtime, runtimeMode: "full-access" });
      yield* applyClineAcpAutoApprove({ runtime, runtimeMode: "approval-required" });
      // Live-verified against cline 3.0.61: a JSON boolean yields -32602
      // Invalid params, the "true"/"false" strings succeed.
      expect(configCalls).toEqual([
        { configId: "auto_approve", value: "true" },
        { configId: "auto_approve", value: "false" },
      ]);
    }),
  );

  it.effect("skips the toggle without a runtime mode", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime();
      yield* applyClineAcpAutoApprove({ runtime, runtimeMode: undefined });
      expect(configCalls).toEqual([]);
    }),
  );

  it.effect("swallows unknown-option failures so older CLIs still start", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("Unknown config option");
      const runtime = {
        setConfigOption: (_configId: string, _value: string | boolean) => failure,
      };
      yield* applyClineAcpAutoApprove({ runtime, runtimeMode: "full-access" });
    }),
  );
});
