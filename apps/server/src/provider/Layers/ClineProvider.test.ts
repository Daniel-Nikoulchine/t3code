import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ClineSettings } from "@t3tools/contracts";

import {
  buildClineDiscoveredModelsFromSessionModelState,
  buildInitialClineProviderSnapshot,
  clineModelsFromSettings,
  clineSlashCommands,
  parseClineVersion,
  withClineFreeModels,
} from "./ClineProvider.ts";

const decodeClineSettings = Schema.decodeSync(ClineSettings);

describe("parseClineVersion", () => {
  it("reads the CLI version from --version output", () => {
    expect(parseClineVersion("3.0.61\n")).toBe("3.0.61");
    expect(parseClineVersion("cline version 3.0.61")).toBe("3.0.61");
  });

  it("returns null when no version is present", () => {
    expect(parseClineVersion("no version here")).toBeNull();
  });
});

describe("clineModelsFromSettings", () => {
  it("keeps the default product slug first and appends free models", () => {
    const models = clineModelsFromSettings([]);
    expect(models[0]).toMatchObject({ slug: "default", isDefault: true });
    const slugs = models.map((model) => model.slug);
    // Free models from the Cline API that ACP does not advertise.
    expect(slugs).toContain("nex-agi/nex-n2.5-pro:free");
    expect(slugs).toContain("inclusionai/ling-3.0-flash-vl:free");
    expect(slugs).toContain("nvidia/nemotron-3.5-content-safety:free");
    expect(slugs).toContain("cline-free/muse-spark-1.3-contributor");
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("merges user-configured custom models", () => {
    const models = clineModelsFromSettings(["my-org/custom-model"]);
    expect(models.map((model) => model.slug)).toContain("my-org/custom-model");
    expect(models.find((model) => model.slug === "my-org/custom-model")?.isCustom).toBe(true);
  });
});

describe("withClineFreeModels", () => {
  it("keeps ACP-advertised entries untouched and only fills gaps", () => {
    const advertised = [
      {
        slug: "thinkingmachines/inkling:free",
        name: "Inkling (free)",
        isCustom: false,
        isDefault: true,
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ];
    const models = withClineFreeModels(advertised);
    const inkling = models.filter((model) => model.slug === "thinkingmachines/inkling:free");
    expect(inkling).toHaveLength(1);
    // ACP entry keeps its own name and default flag, no duplicate appended.
    expect(inkling[0]).toMatchObject({ name: "Inkling (free)", isDefault: true });
    expect(models.map((model) => model.slug)).toContain("nex-agi/nex-n2.5-mini:free");
    expect(new Set(models.map((model) => model.slug)).size).toBe(models.length);
  });
});

describe("buildClineDiscoveredModelsFromSessionModelState", () => {
  it("maps ACP models and marks the session current model as default", () => {
    const models = buildClineDiscoveredModelsFromSessionModelState({
      currentModelId: "anthropic/claude-sonnet-5",
      availableModels: [
        { modelId: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
        { modelId: "x-ai/grok-4.6", name: "Grok 4.6" },
      ],
    });
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["anthropic/claude-sonnet-5", true],
      ["x-ai/grok-4.6", false],
    ]);
  });

  it("skips the default alias and dedupes repeated ids", () => {
    const models = buildClineDiscoveredModelsFromSessionModelState({
      currentModelId: "x-ai/grok-4.6",
      availableModels: [
        { modelId: "default", name: "Default" },
        { modelId: "x-ai/grok-4.6", name: "Grok 4.6" },
        { modelId: "x-ai/grok-4.6", name: "Grok 4.6 duplicate" },
      ],
    });
    expect(models.map((model) => model.slug)).toEqual(["x-ai/grok-4.6"]);
  });

  it("returns no models without advertised state", () => {
    expect(buildClineDiscoveredModelsFromSessionModelState(null)).toEqual([]);
    expect(
      buildClineDiscoveredModelsFromSessionModelState({
        currentModelId: "",
        availableModels: [],
      }),
    ).toEqual([]);
  });
});

describe("clineSlashCommands", () => {
  it("normalizes names and carries descriptions with input hints", () => {
    const commands = clineSlashCommands([
      { name: "/compact", description: "Compact context", input: { hint: "optional focus" } },
      { name: "compact", description: "duplicate" },
      { name: "  ", description: "blank" },
    ]);
    expect(commands).toEqual([
      {
        name: "compact",
        description: "Compact context",
        input: { hint: "optional focus" },
      },
    ]);
  });
});

describe("buildInitialClineProviderSnapshot", () => {
  it.effect("reports disabled when the instance is off", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialClineProviderSnapshot(
        decodeClineSettings({ enabled: false }),
      );
      expect(draft.enabled).toBe(false);
      expect(draft.status).toBe("disabled");
      expect(draft.installed).toBe(false);
      expect(draft.models.map((model) => model.slug)).toContain("default");
    }),
  );

  it.effect("reports a pending check when the instance is on", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialClineProviderSnapshot(
        decodeClineSettings({ enabled: true, binaryPath: "cline" }),
      );
      expect(draft.enabled).toBe(true);
      expect(draft.installed).toBe(true);
      expect(draft.status).toBe("warning");
      expect(draft.version).toBeNull();
      expect(draft.message).toMatch(/Checking Cline CLI/);
    }),
  );
});
