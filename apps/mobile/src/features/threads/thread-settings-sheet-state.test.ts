import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  canCommitPendingModel,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
  providerChoiceSubtitle,
  providerFilterChoices,
  resolveComboTargetDisplay,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  it("matches visible model and provider terms", () => {
    const model = modelOption("gpt-next");

    expect(modelMatchesCatalogQuery({ model, groupLabel: "GPT Next", query: "NEXT" })).toBe(true);
    // The pairing's provider label is searchable even though groups are models.
    expect(modelMatchesCatalogQuery({ model, groupLabel: "GPT Next", query: "codex" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, groupLabel: "GPT Next", query: "claude" })).toBe(
      false,
    );
  });

  it("treats whitespace-only catalog searches as empty", () => {
    expect(
      modelMatchesCatalogQuery({
        model: modelOption("gpt-next"),
        groupLabel: "GPT Next",
        query: "   ",
      }),
    ).toBe(true);
  });

  it("matches the upstream provider's display name", () => {
    const model = {
      ...modelOption("opencode/claude-fable-5"),
      label: "Claude Fable 5",
      subtitle: "OpenCode Zen",
    };

    expect(modelMatchesCatalogQuery({ model, groupLabel: "Claude Fable 5", query: " ZEN " })).toBe(
      true,
    );
    expect(
      modelMatchesCatalogQuery({ model, groupLabel: "Claude Fable 5", query: "copilot" }),
    ).toBe(false);
  });

  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { key: "gemini-native", label: "Gemini Native", models: [pending] };

    expect(canCommitPendingModel(pending, [group])).toBe(true);
    expect(canCommitPendingModel(pending, [])).toBe(false);
    expect(
      canCommitPendingModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });

  it("labels combo targets from the rendered catalog", () => {
    const groups = [
      {
        key: "gpt-5.4",
        label: "GPT-5.4",
        models: [
          {
            ...modelOption("gpt-5.4"),
            key: "opencode_proxy:gpt-5.4",
            providerKey: "opencode_proxy",
            providerLabel: "OpenCode Proxy",
            selection: {
              instanceId: ProviderInstanceId.make("opencode_proxy"),
              model: "gpt-5.4",
            },
          },
        ],
      },
    ];

    expect(
      resolveComboTargetDisplay(
        { instanceId: ProviderInstanceId.make("opencode_proxy"), model: "gpt-5.4" },
        groups,
      ),
    ).toEqual({ title: "gpt-5.4", subtitle: "OpenCode Proxy" });
  });

  it("falls back to raw slugs for combo targets missing from the catalog", () => {
    expect(
      resolveComboTargetDisplay(
        { instanceId: ProviderInstanceId.make("opencode_proxy"), model: "gpt-unknown" },
        [],
      ),
    ).toEqual({ title: "gpt-unknown", subtitle: "opencode_proxy" });
  });

  it("enumerates distinct providers with pairing counts", () => {
    const claude = {
      ...modelOption("fable"),
      key: "claude:fable",
      providerKey: "claude",
      providerLabel: "Claude",
      selection: { instanceId: ProviderInstanceId.make("claude"), model: "fable", options: [] },
    };
    const groups = [
      { key: "gpt-5.4", label: "GPT-5.4", models: [modelOption("gpt-5.4")] },
      {
        key: "fable",
        label: "Fable",
        models: [
          claude,
          {
            ...claude,
            key: "claude-personal:fable",
            providerKey: "claude-personal",
            providerLabel: "Claude Personal",
            selection: {
              instanceId: ProviderInstanceId.make("claude-personal"),
              model: "fable",
              options: [],
            },
          },
        ],
      },
      { key: "gpt-5.5", label: "GPT-5.5", models: [modelOption("gpt-5.5")] },
    ];

    expect(providerFilterChoices(groups)).toEqual([
      { key: "codex", label: "Codex", modelCount: 2 },
      { key: "claude", label: "Claude", modelCount: 1 },
      { key: "claude-personal", label: "Claude Personal", modelCount: 1 },
    ]);
  });

  it("labels provider filter rows with singular and plural counts", () => {
    expect(providerChoiceSubtitle(1)).toBe("1 model");
    expect(providerChoiceSubtitle(12)).toBe("12 models");
  });
});
