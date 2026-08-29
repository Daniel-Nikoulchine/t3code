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

  it("labels bare custom:<provider>:<model> aliases from their labeled siblings", () => {
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

    expect(models.map(({ slug, name, subProvider }) => ({ slug, name, subProvider }))).toEqual([
      {
        slug: "b-ai:deepseek-v4-flash",
        name: "deepseek-v4-flash",
        subProvider: "b.ai",
      },
      {
        slug: "custom:b-ai:deepseek-v4-flash",
        name: "deepseek-v4-flash",
        subProvider: "b.ai",
      },
      {
        slug: "custom:orcarouter:deepseek/deepseek-v4-flash",
        name: "deepseek/deepseek-v4-flash",
        subProvider: "orcarouter",
      },
      {
        slug: "custom:solo-provider:gpt-9",
        name: "gpt-9",
        subProvider: "solo-provider",
      },
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
});
