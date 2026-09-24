import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  buildModelPickerProviderChoices,
  modelPickerOptionBucketKey,
  modelPickerSidebarRowSubtitle,
} from "./ModelPickerSidebar";
import type { ModelEsque } from "./providerIconUtils";

function snapshot(input: {
  instanceId: string;
  driver: string;
  displayName?: string;
  status?: ServerProvider["status"];
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("modelPickerOptionBucketKey", () => {
  it("buckets native and harness-gateway models under the instance id", () => {
    expect(modelPickerOptionBucketKey({ slug: "m1", name: "M1" }, "cline")).toBe("cline");
    expect(
      modelPickerOptionBucketKey(
        { slug: "tencent/m1", name: "M1", subProvider: "tencent" },
        "cline",
      ),
    ).toBe("cline");
    expect(
      modelPickerOptionBucketKey(
        { slug: "kilo/anthropic/m1", name: "M1", subProvider: "kilo/anthropic" },
        "kilo",
      ),
    ).toBe("kilo");
  });

  it("buckets t3-backend models under their normalized upstream", () => {
    expect(
      modelPickerOptionBucketKey(
        { slug: "t3-backend/opencode-go/m1", name: "M1", subProvider: "opencode-go" },
        "minimax",
      ),
    ).toBe("opencode-go");
    expect(
      modelPickerOptionBucketKey(
        {
          slug: "m:custom_provider%3At3-backend:opencode-go%2Fm1:v:",
          name: "M1",
          subProvider: "Open Code Go",
        },
        "minimax",
      ),
    ).toBe("open code go");
  });

  it("falls back to the instance id when a t3-backend model has no upstream", () => {
    expect(modelPickerOptionBucketKey({ slug: "t3-backend/m1", name: "M1" }, "kilo")).toBe("kilo");
  });

  it("never opens a t3-backend row for a stale bucket subProvider", () => {
    expect(
      modelPickerOptionBucketKey(
        { slug: "t3-backend/probe-go", name: "probe-go", subProvider: "t3-backend" },
        "pi",
      ),
    ).toBe("pi");
    expect(
      modelPickerOptionBucketKey(
        { slug: "t3-backend/t3-backend/probe-go", name: "probe-go", subProvider: "T3-Backend" },
        "pi",
      ),
    ).toBe("pi");
  });
});

describe("modelPickerSidebarRowSubtitle", () => {
  it("shows readiness status for disabled choices", () => {
    expect(modelPickerSidebarRowSubtitle({ disabled: true, modelCount: 12 })).toBe("Not ready");
  });

  it("shows model counts for ready choices", () => {
    expect(modelPickerSidebarRowSubtitle({ disabled: false, modelCount: 1 })).toBe("1 model");
    expect(modelPickerSidebarRowSubtitle({ disabled: false, modelCount: 12 })).toBe("12 models");
    expect(modelPickerSidebarRowSubtitle({ disabled: false, modelCount: 0 })).toBe("0 models");
  });
});

describe("buildModelPickerProviderChoices", () => {
  const options = (
    pairs: ReadonlyArray<{ subProvider?: string; name?: string; slug?: string }>,
  ): ReadonlyArray<ModelEsque> =>
    pairs.map((pair, index) => ({
      slug: pair.slug ?? `m${index}`,
      name: pair.name ?? `Model ${index}`,
      ...(pair.subProvider ? { subProvider: pair.subProvider } : {}),
    }));

  it("renders one row per instance even when subProviders differ", () => {
    const instanceEntries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "codex", driver: "codex" }),
      snapshot({ instanceId: "codex_personal", driver: "codex", displayName: "Codex Personal" }),
    ]);
    const modelOptionsByInstance = new Map<string, ReadonlyArray<ModelEsque>>([
      [
        "codex",
        options([
          { subProvider: "OpenRouter", name: "OR A" },
          { subProvider: "openrouter", name: "OR B" },
          { name: "Native" },
        ]),
      ],
      ["codex_personal", options([{ subProvider: "OpenRouter", name: "OR C" }])],
    ]);

    const choices = buildModelPickerProviderChoices({ instanceEntries, modelOptionsByInstance });

    expect(choices.map((choice) => choice.key)).toEqual(["codex", "codex_personal"]);
    expect(choices[0]).toMatchObject({
      label: "Codex",
      modelCount: 3,
      disabled: false,
      driverKind: "codex",
    });
    expect(choices[1]).toMatchObject({
      key: "codex_personal",
      label: "Codex Personal",
      modelCount: 1,
      disabled: false,
    });
  });

  it("marks a bucket disabled until any contributing instance is ready", () => {
    const instanceEntries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "broken", driver: "opencode", status: "error" }),
    ]);
    const modelOptionsByInstance = new Map<string, ReadonlyArray<ModelEsque>>([
      ["broken", options([{ name: "M" }])],
    ]);

    const choices = buildModelPickerProviderChoices({ instanceEntries, modelOptionsByInstance });

    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ key: "broken", disabled: true, modelCount: 1 });
    expect(choices[0]?.tooltip).toContain("Unavailable");
  });

  it("collapses a not-ready instance's subProvider buckets into one instance row", () => {
    const instanceEntries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "kilo", driver: "kilo", status: "error" }),
    ]);
    const modelOptionsByInstance = new Map<string, ReadonlyArray<ModelEsque>>([
      [
        "kilo",
        options([
          { subProvider: "kilo/anthropic", name: "A" },
          { subProvider: "kilo/deepseek", name: "B" },
          { subProvider: "kilo/google", name: "C" },
        ]),
      ],
    ]);

    const choices = buildModelPickerProviderChoices({ instanceEntries, modelOptionsByInstance });

    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({
      key: "kilo",
      label: "Kilo",
      disabled: true,
      modelCount: 3,
    });
    expect(choices[0]?.tooltip).toContain("Unavailable");
  });

  it("renders a ready gateway instance with many subProviders as one row", () => {
    const instanceEntries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "cline", driver: "cline" }),
    ]);
    const modelOptionsByInstance = new Map<string, ReadonlyArray<ModelEsque>>([
      [
        "cline",
        options([
          { subProvider: "ibm-granite", name: "A" },
          { subProvider: "tencent", name: "B" },
          { subProvider: "tencent", name: "C" },
          { subProvider: "~z-ai", name: "D" },
        ]),
      ],
    ]);

    const choices = buildModelPickerProviderChoices({ instanceEntries, modelOptionsByInstance });

    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({
      key: "cline",
      label: "Cline",
      disabled: false,
      modelCount: 4,
    });
  });

  it("keeps an unready instance as its own disabled row next to a ready one", () => {
    const instanceEntries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "codex", driver: "codex" }),
      snapshot({ instanceId: "other", driver: "opencode", status: "error" }),
    ]);
    const modelOptionsByInstance = new Map<string, ReadonlyArray<ModelEsque>>([
      ["codex", options([{ subProvider: "OpenRouter", name: "OR A" }])],
      ["other", options([{ subProvider: "OpenRouter", name: "OR B" }])],
    ]);

    const choices = buildModelPickerProviderChoices({ instanceEntries, modelOptionsByInstance });

    expect(choices.map((choice) => choice.key)).toEqual(["codex", "other"]);
    expect(choices[0]).toMatchObject({ disabled: false, modelCount: 1 });
    expect(choices[1]).toMatchObject({ disabled: true, modelCount: 1 });
  });

  it("splits t3-backend models into their own upstream row next to the instance row", () => {
    const instanceEntries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "minimax", driver: "minimax" }),
    ]);
    const modelOptionsByInstance = new Map<string, ReadonlyArray<ModelEsque>>([
      [
        "minimax",
        options([
          { slug: "minimax:M1", name: "M1" },
          {
            slug: "m:custom_provider%3At3-backend:opencode-go%2Fkimi-k3:v:",
            name: "kimi-k3",
            subProvider: "opencode-go",
          },
          {
            slug: "m:custom_provider%3At3-backend:opencode-go%2Fdeepseek-v4-flash:v:",
            name: "deepseek-v4-flash",
            subProvider: "opencode-go",
          },
        ]),
      ],
    ]);

    const choices = buildModelPickerProviderChoices({ instanceEntries, modelOptionsByInstance });

    expect(choices.map((choice) => choice.key)).toEqual(["minimax", "opencode-go"]);
    expect(choices[0]).toMatchObject({ label: "MiniMax", modelCount: 3, disabled: false });
    expect(choices[1]).toMatchObject({ label: "opencode-go", modelCount: 2, disabled: false });
    expect(choices[1]?.driverKind).toBe("minimax");
  });

  it("limits instance rows to the active harness but keeps upstream rows global", () => {
    const instanceEntries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "minimax", driver: "minimax" }),
      snapshot({ instanceId: "cline", driver: "cline" }),
    ]);
    const modelOptionsByInstance = new Map<string, ReadonlyArray<ModelEsque>>([
      [
        "minimax",
        options([
          { slug: "minimax:M1", name: "M1" },
          {
            slug: "m:custom_provider%3At3-backend:opencode-go%2Fk1:v:",
            name: "K1",
            subProvider: "opencode-go",
          },
        ]),
      ],
      [
        "cline",
        options([
          { slug: "tencent/M2", name: "M2", subProvider: "tencent" },
          { slug: "t3-backend/opencode-go/K2", name: "K2", subProvider: "opencode-go" },
        ]),
      ],
    ]);

    const choices = buildModelPickerProviderChoices({
      instanceEntries,
      modelOptionsByInstance,
      activeInstanceId: "minimax",
    });

    // minimax instance row (native + routed) + global opencode-go row; no
    // cline row, and cline's gateway models do not leak anywhere.
    expect(choices.map((choice) => choice.key)).toEqual(["minimax", "opencode-go"]);
    expect(choices[0]).toMatchObject({ label: "MiniMax", modelCount: 2 });
    expect(choices[1]).toMatchObject({ label: "opencode-go", modelCount: 2 });
  });

  it("excludes an unready harness's routed models from global upstream rows", () => {
    const instanceEntries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "minimax", driver: "minimax" }),
      snapshot({ instanceId: "kilo", driver: "kilo", status: "error" }),
    ]);
    const modelOptionsByInstance = new Map<string, ReadonlyArray<ModelEsque>>([
      [
        "minimax",
        options([
          {
            slug: "t3-backend/opencode-go/K1",
            name: "K1",
            subProvider: "opencode-go",
          },
        ]),
      ],
      [
        "kilo",
        options([{ slug: "t3-backend/opencode-go/K2", name: "K2", subProvider: "opencode-go" }]),
      ],
    ]);

    const choices = buildModelPickerProviderChoices({
      instanceEntries,
      modelOptionsByInstance,
      activeInstanceId: "minimax",
    });

    expect(choices.map((choice) => choice.key)).toEqual(["minimax", "opencode-go"]);
    expect(choices[1]).toMatchObject({ label: "opencode-go", modelCount: 1 });
  });

  it("keeps a setup-only empty instance as its own zero-count row", () => {
    const instanceEntries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "antigravity", driver: "antigravity", status: "error" }),
    ]);

    const choices = buildModelPickerProviderChoices({
      instanceEntries,
      modelOptionsByInstance: new Map(),
      selectableUnavailableInstanceIds: new Set(["antigravity"]),
    });

    expect(choices).toEqual([
      expect.objectContaining({ key: "antigravity", modelCount: 0, disabled: false }),
    ]);
  });
});
