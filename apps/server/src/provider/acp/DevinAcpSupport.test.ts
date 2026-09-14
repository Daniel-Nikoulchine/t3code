import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  currentDevinModelIdFromSessionSetup,
  devinAcpSpawnArgs,
  resolveDevinAcpBaseModelId,
  resolveDevinAuthMethodId,
} from "./DevinAcpSupport.ts";

describe("resolveDevinAcpBaseModelId", () => {
  it("falls back to the Devin product slug for empty input", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBe("devin-default");
    expect(resolveDevinAcpBaseModelId("   ")).toBe("devin-default");
    expect(resolveDevinAcpBaseModelId("  opus  ")).toBe("opus");
  });
});

describe("devinAcpSpawnArgs", () => {
  it("starts plain acp when no T3 runtime mode is set", () => {
    expect(devinAcpSpawnArgs()).toEqual(["acp"]);
  });

  it("maps T3 runtime modes onto Devin permission modes", () => {
    expect(devinAcpSpawnArgs("approval-required")).toEqual(["--permission-mode", "normal", "acp"]);
    expect(devinAcpSpawnArgs("auto-accept-edits")).toEqual([
      "--permission-mode",
      "accept-edits",
      "acp",
    ]);
    expect(devinAcpSpawnArgs("auto")).toEqual(["--permission-mode", "smart", "acp"]);
    expect(devinAcpSpawnArgs("full-access")).toEqual(["--permission-mode", "dangerous", "acp"]);
  });
});

describe("buildDevinAcpSpawnInput", () => {
  it("uses the configured binary and passes the model through", () => {
    const spawn = buildDevinAcpSpawnInput(
      { binaryPath: "/usr/local/bin/devin" },
      "/tmp/project",
      { FOO: "bar" },
      "full-access",
      "opus",
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/devin",
      args: ["--permission-mode", "dangerous", "acp", "--model", "opus"],
      cwd: "/tmp/project",
      env: { FOO: "bar" },
    });
  });

  it("falls back to devin on PATH without a model", () => {
    const spawn = buildDevinAcpSpawnInput(null, "/tmp/project");
    expect(spawn.command).toBe("devin");
    expect(spawn.args).toEqual(["acp"]);
  });
});

describe("resolveDevinAuthMethodId", () => {
  it("prefers the API key method when WINDSURF_API_KEY is set", () => {
    expect(resolveDevinAuthMethodId({ WINDSURF_API_KEY: "secret" })).toBe("devin_api_key");
    expect(resolveDevinAuthMethodId({})).toBe("devin_login");
    expect(resolveDevinAuthMethodId(undefined)).toBe("devin_login");
  });
});

describe("currentDevinModelIdFromSessionSetup", () => {
  it("returns the trimmed current model id", () => {
    expect(
      currentDevinModelIdFromSessionSetup({
        sessionId: "s",
        modes: null,
        models: { currentModelId: "  opus  ", availableModels: [] },
      } as never),
    ).toBe("opus");
    expect(currentDevinModelIdFromSessionSetup({ sessionId: "s" } as never)).toBeUndefined();
  });
});

describe("applyDevinAcpModelSelection", () => {
  const mapError = (cause: unknown) => cause as Error;

  it.effect("keeps the current model for the product slug", () =>
    Effect.gen(function* () {
      let calls = 0;
      const runtime = {
        setSessionModel: (_model: string) =>
          Effect.succeed({} as EffectAcpSchema.SetSessionModelResponse).pipe(
            Effect.tap(() => Effect.sync(() => calls++)),
          ),
      };
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "opus",
        requestedModelId: "devin-default",
        mapError,
      });
      expect(result).toBe("opus");
      expect(calls).toBe(0);
    }),
  );

  it.effect("sets the requested model when it differs", () =>
    Effect.gen(function* () {
      let seen: string | undefined;
      const runtime = {
        setSessionModel: (model: string) =>
          Effect.succeed({} as EffectAcpSchema.SetSessionModelResponse).pipe(
            Effect.tap(() => Effect.sync(() => (seen = model))),
          ),
      };
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "opus",
        requestedModelId: "sonnet",
        mapError,
      });
      expect(result).toBe("sonnet");
      expect(seen).toBe("sonnet");
    }),
  );
});
