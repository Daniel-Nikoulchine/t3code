import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildHermesDiscoveredModelsFromSessionModelState,
  hermesModelsFromSettings,
  hermesSlashCommands,
  parseHermesVersion,
} from "./HermesProvider.ts";

describe("Hermes provider metadata", () => {
  it("reads the product version instead of Hermes' release date", () => {
    expect(parseHermesVersion("Hermes Agent v0.20.0 (2026.8.3)")).toBe("0.20.0");
  });

  it("marks Hermes' configured model as the live default", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "openrouter:anthropic/claude-sonnet-4.6",
      availableModels: [
        {
          modelId: "openrouter:anthropic/claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
        },
        { modelId: "openai:gpt-5.4", name: "GPT-5.4" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map(({ slug, isDefault }) => ({ slug, isDefault }))).toEqual([
      { slug: "openrouter:anthropic/claude-sonnet-4.6", isDefault: true },
      { slug: "openai:gpt-5.4", isDefault: undefined },
    ]);
  });

  it("splits advertised 'Provider · model' names into subProvider", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "nous:deepseek/deepseek-v4-flash",
      availableModels: [
        {
          modelId: "nous:deepseek/deepseek-v4-flash",
          name: "Nous Portal · deepseek/deepseek-v4-flash",
        },
        {
          modelId: "nvidia:deepseek-ai/deepseek-v4-flash-0731",
          name: "NVIDIA NIM · deepseek-ai/deepseek-v4-flash-0731",
        },
        { modelId: "nous:z-ai/glm-5.3-flash", name: "Nous Portal · z-ai/glm-5.3-flash" },
        { modelId: "openai-codex:gpt-5.5", name: "Bare Name Without Separator" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map(({ slug, name, subProvider }) => ({ slug, name, subProvider }))).toEqual([
      {
        slug: "nous:deepseek/deepseek-v4-flash",
        name: "deepseek/deepseek-v4-flash",
        subProvider: "Nous Portal",
      },
      {
        slug: "nvidia:deepseek-ai/deepseek-v4-flash-0731",
        name: "deepseek-ai/deepseek-v4-flash-0731",
        subProvider: "NVIDIA NIM",
      },
      {
        slug: "nous:z-ai/glm-5.3-flash",
        name: "z-ai/glm-5.3-flash",
        subProvider: "Nous Portal",
      },
      {
        slug: "openai-codex:gpt-5.5",
        name: "Bare Name Without Separator",
        subProvider: undefined,
      },
    ]);
  });

  it("folds bare custom:<provider>:<model> aliases into their identical native sibling", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "b-ai:deepseek-v4-flash",
      availableModels: [
        { modelId: "b-ai:deepseek-v4-flash", name: "b.ai · deepseek-v4-flash" },
        { modelId: "custom:b-ai:deepseek-v4-flash", name: "deepseek-v4-flash" },
        {
          modelId: "custom:orcarouter:deepseek/deepseek-v4-flash",
          name: "deepseek/deepseek-v4-flash",
        },
        { modelId: "custom:solo-provider:gpt-9", name: "gpt-9" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(
      models.map(({ slug, name, subProvider, aliases }) => ({ slug, name, subProvider, aliases })),
    ).toEqual([
      {
        slug: "b-ai:deepseek-v4-flash",
        name: "deepseek-v4-flash",
        subProvider: "b.ai",
        aliases: ["custom:b-ai:deepseek-v4-flash"],
      },
      {
        slug: "custom:orcarouter:deepseek/deepseek-v4-flash",
        name: "deepseek/deepseek-v4-flash",
        subProvider: "orcarouter",
        aliases: undefined,
      },
      {
        slug: "custom:solo-provider:gpt-9",
        name: "gpt-9",
        subProvider: "solo-provider",
        aliases: undefined,
      },
    ]);
  });

  it("marks the native sibling as default when the alias carries the current model", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "custom:b-ai:deepseek-v4-flash",
      availableModels: [
        { modelId: "custom:b-ai:deepseek-v4-flash", name: "deepseek-v4-flash" },
        { modelId: "b-ai:deepseek-v4-flash", name: "b.ai · deepseek-v4-flash" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models).toEqual([
      expect.objectContaining({
        slug: "b-ai:deepseek-v4-flash",
        isDefault: true,
        aliases: ["custom:b-ai:deepseek-v4-flash"],
      }),
    ]);
  });

  it("keeps the built-in default entry when Hermes routes through its default model", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "default",
      availableModels: [
        {
          modelId: "openrouter:anthropic/claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
        },
        { modelId: "openai:gpt-5.4", name: "GPT-5.4" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map(({ slug, isDefault }) => ({ slug, isDefault }))).toEqual([
      { slug: "default", isDefault: true },
      { slug: "openrouter:anthropic/claude-sonnet-4.6", isDefault: undefined },
      { slug: "openai:gpt-5.4", isDefault: undefined },
    ]);
  });

  it("merges exact provider:model custom ids without duplicates", () => {
    const models = hermesModelsFromSettings([
      " openrouter:anthropic/claude-sonnet-4.6 ",
      "openrouter:anthropic/claude-sonnet-4.6",
    ]);
    expect(models.map((model) => model.slug)).toEqual([
      "default",
      "openrouter:anthropic/claude-sonnet-4.6",
    ]);
  });

  it("normalizes advertised slash command names and hints", () => {
    expect(
      hermesSlashCommands([
        { name: "/model", description: "Switch model", input: { hint: "provider:model" } },
      ]),
    ).toEqual([{ name: "model", description: "Switch model", input: { hint: "provider:model" } }]);
  });

  it("tolerates advertised commands without an input hint", () => {
    expect(
      hermesSlashCommands([
        {
          name: "steer",
          description: "Redirect active work",
          input: {},
        } as unknown as EffectAcpSchema.AvailableCommand,
      ]),
    ).toEqual([{ name: "steer", description: "Redirect active work" }]);
  });

  it("strips all leading slashes from advertised slash command names", () => {
    expect(
      hermesSlashCommands([
        { name: "//steer", description: "Redirect active work", input: { hint: "" } },
      ]),
    ).toEqual([{ name: "steer", description: "Redirect active work" }]);
  });

  it("leaves malformed custom: slugs without a provider segment alone", () => {
    const models = buildHermesDiscoveredModelsFromSessionModelState({
      currentModelId: "openai:gpt-5.4",
      availableModels: [
        { modelId: "custom:lonely", name: "lonely" },
        { modelId: "openai:gpt-5.4", name: "GPT-5.4" },
      ],
    } satisfies EffectAcpSchema.SessionModelState);

    expect(models.map(({ slug, name, subProvider }) => ({ slug, name, subProvider }))).toEqual([
      { slug: "custom:lonely", name: "lonely", subProvider: undefined },
      { slug: "openai:gpt-5.4", name: "GPT-5.4", subProvider: undefined },
    ]);
  });
});
