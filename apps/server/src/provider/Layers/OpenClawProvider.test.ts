import { describe, expect, it } from "@effect/vitest";
import { OpenClawSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildInitialOpenClawProviderSnapshot,
  buildOpenClawDiscoveredModelsFromSessionModelState,
  openclawModelsFromSettings,
  openclawSlashCommands,
  parseOpenClawModelsListOutput,
  parseOpenClawVersion,
} from "./OpenClawProvider.ts";

const decodeOpenClawSettings = Schema.decodeSync(OpenClawSettings);
const decodeSettings = (overrides: Record<string, unknown> = {}) =>
  decodeOpenClawSettings({ enabled: true, ...overrides });

describe("parseOpenClawVersion", () => {
  it("parses the real `openclaw --version` output", () => {
    expect(parseOpenClawVersion("OpenClaw 2026.9.4 (3a9d69d)\n")).toBe("2026.9.4");
  });

  it("falls back to a generic semver in the output", () => {
    expect(parseOpenClawVersion("openclaw version 2026.10.1")).toBe("2026.10.1");
  });

  it("returns null when no version is present", () => {
    expect(parseOpenClawVersion("Gateway is not running.\n")).toBeNull();
  });
});

describe("parseOpenClawModelsListOutput", () => {
  it("maps models list entries onto provider models", () => {
    const models = parseOpenClawModelsListOutput(
      JSON.stringify({
        count: 2,
        models: [
          {
            id: "openrouter:anthropic/claude-sonnet-4",
            name: "Claude Sonnet 4",
            provider: "openrouter",
          },
          { id: "default", name: "Default" },
        ],
      }),
    );
    expect(models).toEqual([
      {
        slug: "openrouter:anthropic/claude-sonnet-4",
        name: "Claude Sonnet 4",
        isCustom: false,
        subProvider: "openrouter",
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("returns an empty list for invalid or empty payloads", () => {
    expect(parseOpenClawModelsListOutput("not json")).toEqual([]);
    expect(parseOpenClawModelsListOutput(JSON.stringify({ count: 0, models: [] }))).toEqual([]);
    expect(parseOpenClawModelsListOutput(JSON.stringify({}))).toEqual([]);
    expect(parseOpenClawModelsListOutput(JSON.stringify({ models: [{ name: "no id" }] }))).toEqual(
      [],
    );
  });
});

describe("openclawModelsFromSettings", () => {
  it("exposes the default model plus custom models", () => {
    const models = openclawModelsFromSettings(["my-model"]);
    expect(models.map((model) => model.slug)).toContain("default");
    expect(models.map((model) => model.slug)).toContain("my-model");
    expect(models.find((model) => model.slug === "my-model")?.isCustom).toBe(true);
  });
});

describe("buildOpenClawDiscoveredModelsFromSessionModelState", () => {
  it("returns an empty list without advertised models", () => {
    expect(buildOpenClawDiscoveredModelsFromSessionModelState(null)).toEqual([]);
    expect(
      buildOpenClawDiscoveredModelsFromSessionModelState({
        currentModelId: "default",
        availableModels: [],
      }),
    ).toEqual([]);
  });

  it("maps ACP models and marks the current one as default", () => {
    const models = buildOpenClawDiscoveredModelsFromSessionModelState({
      currentModelId: "openrouter:anthropic/claude-sonnet-4",
      availableModels: [
        {
          modelId: "openrouter:anthropic/claude-sonnet-4",
          name: "Anthropic · Claude Sonnet 4",
          description: "",
        },
        { modelId: "openrouter:openai/gpt-5", name: "OpenAI · GPT 5", description: "" },
      ],
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      slug: "openrouter:anthropic/claude-sonnet-4",
      subProvider: "Anthropic",
      isDefault: true,
    });
  });

  it("dedupes repeated model ids", () => {
    const models = buildOpenClawDiscoveredModelsFromSessionModelState({
      currentModelId: "a",
      availableModels: [
        { modelId: "a", name: "A", description: "" },
        { modelId: "a", name: "A again", description: "" },
      ],
    });
    expect(models).toHaveLength(1);
  });
});

describe("openclawSlashCommands", () => {
  it("strips leading slashes and dedupes", () => {
    expect(
      openclawSlashCommands([
        { name: "/plan", description: "Plan it", input: { hint: "goal" } },
        { name: "plan", description: "Plan it again" },
        { name: "  ", description: "blank" },
      ]),
    ).toEqual([{ name: "plan", description: "Plan it", input: { hint: "goal" } }]);
  });
});

describe("buildInitialOpenClawProviderSnapshot", () => {
  it.effect("marks a disabled instance as disabled", () =>
    Effect.gen(function* () {
      const draft = yield* buildInitialOpenClawProviderSnapshot(decodeSettings({ enabled: false }));
      expect(draft.status).toBe("disabled");
      expect(draft.enabled).toBe(false);
      expect(draft.models.map((model) => model.slug)).toContain("default");
    }),
  );
});
