import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";

import {
  buildDevinModelsFromSessionModelState,
  buildInitialDevinProviderSnapshot,
  checkDevinProviderStatus,
  devinModelsFromSettings,
  parseDevinAuthStatusOutput,
  parseDevinModelsCliOutput,
} from "./DevinProvider.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

describe("parseDevinModelsCliOutput", () => {
  it("reads a JSON array of model slugs", () => {
    const parsed = parseDevinModelsCliOutput(JSON.stringify(["opus", "sonnet", "swe-1-6-fast"]));
    expect(parsed.models.map((model) => model.slug)).toEqual(["opus", "sonnet", "swe-1-6-fast"]);
  });

  it("reads objects with id/name fields and default markers", () => {
    const parsed = parseDevinModelsCliOutput(
      JSON.stringify({
        models: [
          { id: "opus", name: "Opus", default: true },
          { id: "sonnet", name: "Sonnet" },
        ],
      }),
    );
    expect(parsed.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["opus", true],
      ["sonnet", false],
    ]);
  });

  it("returns an empty catalog for non-JSON output", () => {
    expect(parseDevinModelsCliOutput("not json").models).toEqual([]);
    expect(parseDevinModelsCliOutput("").models).toEqual([]);
  });
});

describe("parseDevinAuthStatusOutput", () => {
  it("detects logged-in output with an email", () => {
    const parsed = parseDevinAuthStatusOutput("You are logged in as dev@example.com");
    expect(parsed.authenticated).toBe(true);
    expect(parsed.email).toBe("dev@example.com");
  });

  it("detects logged-out output", () => {
    expect(
      parseDevinAuthStatusOutput("You are not logged in. Run `devin auth login`.").authenticated,
    ).toBe(false);
  });

  it("returns unknown for unrecognized output", () => {
    expect(parseDevinAuthStatusOutput("devin 1.2.3").authenticated).toBeNull();
  });
});

describe("buildDevinModelsFromSessionModelState", () => {
  it("marks the agent's current model as default", () => {
    const models = buildDevinModelsFromSessionModelState({
      currentModelId: "opus",
      availableModels: [
        { modelId: "opus", name: "Opus" },
        { modelId: "sonnet", name: "Sonnet" },
      ],
    });
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["opus", true],
      ["sonnet", false],
    ]);
  });

  it("returns an empty list without model state", () => {
    expect(buildDevinModelsFromSessionModelState(null)).toEqual([]);
    expect(buildDevinModelsFromSessionModelState(undefined)).toEqual([]);
  });
});

describe("devinModelsFromSettings", () => {
  it("merges custom models onto the Devin default", () => {
    const models = devinModelsFromSettings(["my-model"]);
    expect(models.map((model) => model.slug)).toContain("devin-default");
    expect(models.map((model) => model.slug)).toContain("my-model");
  });
});

describe("buildInitialDevinProviderSnapshot", () => {
  it.effect("reports disabled when Devin is off", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(decodeDevinSettings({}));
      expect(snapshot.enabled).toBe(false);
    }),
  );

  it.effect("reports a pending check when Devin is on", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDevinProviderSnapshot(
        decodeDevinSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
    }),
  );
});

it.layer(NodeServices.layer)("checkDevinProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(
        decodeDevinSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/devin-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports disabled without probing when Devin is off", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(decodeDevinSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );
});
