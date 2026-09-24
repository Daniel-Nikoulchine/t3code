import { describe, expect, it } from "vite-plus/test";

import {
  buildMinimaxThinkingCapabilities,
  minimaxCustomDisplayName,
  minimaxCustomProviderSubProvider,
  minimaxModelsFromSessionSetup,
  minimaxSlashCommands,
} from "./MinimaxProvider.ts";

describe("minimaxModelsFromSessionSetup", () => {
  it("reads custom-provider models from the model select (mcode returns models:null)", () => {
    expect(
      minimaxModelsFromSessionSetup({
        models: null,
        configOptions: [
          { type: "select", id: "permissionMode", currentValue: "auto", options: [] },
          {
            type: "select",
            id: "model",
            currentValue: "m:minimax:MiniMax-M3:v:",
            options: [
              { value: "m:minimax:MiniMax-M3:v:", name: "MiniMax-M3" },
              {
                value: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
                name: "gpt-5.6-luna · thinking",
              },
              { value: "  ", name: "blank" },
              {
                value: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
                name: "dup",
              },
            ],
          },
        ],
      } as never),
    ).toEqual([
      {
        slug: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
        name: "gpt-5.6-luna",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("marks the select current value as default when it is a custom entry", () => {
    const models = minimaxModelsFromSessionSetup({
      models: null,
      configOptions: [
        {
          type: "select",
          id: "model",
          currentValue: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
          options: [
            {
              value: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
              name: "gpt-5.6-luna · thinking",
            },
          ],
        },
      ],
    } as never);
    expect(models).toEqual([
      {
        slug: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
        name: "gpt-5.6-luna",
        isCustom: false,
        isDefault: true,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("drops availableModels ghosts the live select no longer lists", () => {
    const models = minimaxModelsFromSessionSetup({
      models: {
        availableModels: [
          {
            modelId: "m:custom_provider%3At3-backend:opencode-go%2Fmuse-spark-1.3-contributor:v:",
            name: "ghost",
          },
        ],
        currentModelId: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
      },
      configOptions: [
        {
          type: "select",
          id: "model",
          currentValue: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
          options: [
            {
              value: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
              name: "gpt-5.6-luna · thinking",
            },
          ],
        },
      ],
    } as never);
    expect(models.map((model) => model.slug)).toEqual([
      "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
    ]);
    expect(models).toHaveLength(1);
  });

  it("drops plain custom :v: ghosts the live select lists but rejects", () => {
    const models = minimaxModelsFromSessionSetup({
      models: null,
      configOptions: [
        {
          type: "select",
          id: "model",
          currentValue: "m:custom_provider%3At3-backend:opencode-go%2Fkimi-k3:v:thinking",
          options: [
            {
              value: "m:custom_provider%3At3-backend:opencode-go%2Fkimi-k3:v:",
              name: "opencode-go/kimi-k3",
            },
            {
              value: "m:custom_provider%3At3-backend:opencode-go%2Fkimi-k3:v:thinking",
              name: "opencode-go/kimi-k3 · thinking",
            },
          ],
        },
      ],
    } as never);
    expect(models.map((model) => model.slug)).toEqual([
      "m:custom_provider%3At3-backend:opencode-go%2Fkimi-k3:v:thinking",
    ]);
  });

  it("attaches the discovery effort levels as a reasoning picker on the default model", () => {
    const models = minimaxModelsFromSessionSetup({
      models: null,
      configOptions: [
        {
          type: "select",
          id: "model",
          currentValue: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
          options: [
            {
              value: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
              name: "gpt-5.6-luna · thinking",
            },
            {
              value: "m:custom_provider%3At3-backend:opencode-go%2Fkimi-k3:v:thinking",
              name: "opencode-go/kimi-k3 · thinking",
            },
          ],
        },
        {
          id: "thinkingEffort",
          type: "select",
          currentValue: "off",
          options: [
            { value: "off", name: "Off" },
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    } as never);
    expect(models).toHaveLength(2);
    const def = models.find((model) => model.isDefault === true);
    expect(def?.slug).toBe("m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking");
    expect(def?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
      "reasoningEffort",
    ]);
    const other = models.find((model) => model.isDefault !== true);
    expect(other?.capabilities?.optionDescriptors ?? []).toEqual([]);
  });

  it("builds the picker from advertised levels with the live current value", () => {
    const caps = buildMinimaxThinkingCapabilities({
      levels: [
        { value: "off", name: "Off" },
        { value: "high", name: "High" },
      ],
      current: "high",
    });
    const descriptor = caps.optionDescriptors?.[0];
    expect(descriptor?.id).toBe("reasoningEffort");
    expect(descriptor?.type).toBe("select");
    expect(descriptor?.currentValue).toBe("high");
  });

  it("advertises no reasoning descriptor without a live effort select", () => {
    const models = minimaxModelsFromSessionSetup({
      models: null,
      configOptions: [
        {
          type: "select",
          id: "model",
          currentValue: "",
          options: [
            {
              value: "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
              name: "gpt-5.6-luna · thinking",
            },
          ],
        },
      ],
    } as never);
    expect(models).toHaveLength(1);
    expect(models[0]?.capabilities?.optionDescriptors ?? []).toEqual([]);
  });

  it("returns no models without a models payload or model select", () => {
    expect(minimaxModelsFromSessionSetup({} as never)).toEqual([]);
  });
});

describe("minimaxSlashCommands", () => {
  it("dedupes and strips slashes", () => {
    expect(
      minimaxSlashCommands([
        { name: "/compact", description: "Compact it" },
        { name: "compact", description: "dup" },
        { name: "  ", description: "blank" },
      ]),
    ).toEqual([{ name: "compact", description: "Compact it" }]);
  });
});

describe("minimaxCustomProviderSubProvider", () => {
  it("names only the upstream serving backend for connection-routed thinking variants", () => {
    expect(
      minimaxCustomProviderSubProvider(
        "m:custom_provider%3At3-backend:opencode-go%2Fmuse-spark-1.3-contributor:v:thinking",
      ),
    ).toBe("opencode-go");
  });

  it("omits the harness t3-backend bucket for bare backend models", () => {
    expect(
      minimaxCustomProviderSubProvider("m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking"),
    ).toBeUndefined();
  });

  it("omits a stale bucket segment in the inner model id", () => {
    expect(
      minimaxCustomProviderSubProvider(
        "m:custom_provider%3At3-backend:t3-backend%2Fprobe-go:v:thinking",
      ),
    ).toBeUndefined();
  });

  it("leaves native minimax models unmarked", () => {
    expect(minimaxCustomProviderSubProvider("m:minimax:MiniMax-M3:v:thinking")).toBeUndefined();
    expect(minimaxCustomProviderSubProvider("m:minimax:MiniMax-M3:v:")).toBeUndefined();
  });

  it("returns undefined for unparseable ids instead of throwing", () => {
    expect(minimaxCustomProviderSubProvider("")).toBeUndefined();
    expect(minimaxCustomProviderSubProvider("not-a-model")).toBeUndefined();
    expect(minimaxCustomProviderSubProvider("m:custom_provider:")).toBeUndefined();
    expect(minimaxCustomProviderSubProvider("m:custom_provider%3A")).toBeUndefined();
    expect(minimaxCustomProviderSubProvider("m:custom_provider%ZZbroken")).toBeUndefined();
  });

  it("strips the connection prefix and thinking suffix from custom display names", () => {
    expect(
      minimaxCustomDisplayName(
        "m:custom_provider%3At3-backend:opencode-go%2Fdeepseek-v4-flash:v:thinking",
        "opencode-go/deepseek-v4-flash · thinking",
      ),
    ).toBe("deepseek-v4-flash");
    expect(
      minimaxCustomDisplayName(
        "m:custom_provider%3At3-backend:gpt-5.6-luna:v:thinking",
        "gpt-5.6-luna · thinking",
      ),
    ).toBe("gpt-5.6-luna");
  });

  it("leaves native and undecorated names untouched", () => {
    expect(minimaxCustomDisplayName("m:minimax:MiniMax-M3:v:thinking", "MiniMax-M3")).toBe(
      "MiniMax-M3",
    );
    expect(
      minimaxCustomDisplayName("m:minimax:MiniMax-M3:v:thinking", "MiniMax-M3 · thinking"),
    ).toBe("MiniMax-M3 · thinking");
    expect(minimaxCustomDisplayName("not-a-model", "  ")).toBe("not-a-model");
    expect(
      minimaxCustomDisplayName(
        "m:custom_provider%3At3-backend:opencode-go%2F:v:thinking",
        "opencode-go/",
      ),
    ).toBe("opencode-go/");
  });

  it("serves bare names for discovered custom entries", () => {
    const models = minimaxModelsFromSessionSetup({
      models: null,
      configOptions: [
        {
          type: "select",
          id: "model",
          currentValue: "m:minimax:MiniMax-M3:v:",
          options: [
            { value: "m:minimax:MiniMax-M3:v:", name: "MiniMax-M3" },
            {
              value: "m:custom_provider%3At3-backend:opencode-go%2Fdeepseek-v4-flash:v:thinking",
              name: "opencode-go/deepseek-v4-flash · thinking",
            },
          ],
        },
      ],
    } as never);
    // Native entries come from availableModels only; the select lists custom
    // entries here, each carrying the backend subtitle.
    expect(models).toHaveLength(1);
    expect(models[0]?.slug).toBe(
      "m:custom_provider%3At3-backend:opencode-go%2Fdeepseek-v4-flash:v:thinking",
    );
    expect(models[0]?.name).toBe("deepseek-v4-flash");
    expect(models[0]?.subProvider).toBe("opencode-go");
  });
});
