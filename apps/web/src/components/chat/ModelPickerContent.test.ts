import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LogicalModel } from "@t3tools/client-runtime/model-catalog";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  adjacentModelPickerProvider,
  buildLogicalModelPickerItems,
  isModelPickerHarnessOptionDisabled,
  resolveModelPickerSelectedModel,
  shouldIncludeModelPickerOption,
  shouldOfferModelPickerSetup,
} from "./ModelPickerContent";
import {
  LOGICAL_LEGACY_SECTION_KEY,
  modelPickerLogicalModelKey,
  parseModelPickerLogicalModelKey,
} from "./modelPickerKeys";

function snapshot(input: {
  instanceId: string;
  driver: string;
  status?: ServerProvider["status"];
  models?: ReadonlyArray<ServerProvider["models"][number]>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

function model(slug: string, name: string): ServerProvider["models"][number] {
  return { slug, name, isCustom: false, capabilities: null };
}

function logicalModel(
  modelId: string,
  displayName: string,
  sources: ReadonlyArray<{ instanceId: string; authMode?: "api-key" | "subscription" }>,
): LogicalModel {
  return {
    modelId,
    displayName,
    sources: sources.map((source) => ({
      instanceId: source.instanceId,
      model: modelId,
      via: "native" as const,
      authMode: source.authMode ?? ("api-key" as const),
    })),
    gaps: [],
  };
}

function entry(status: ServerProvider["status"], driver = "opencode") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_work`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("shouldIncludeModelPickerOption", () => {
  it.each(["ready", "error"] as const)(
    "never offers the internal Antigravity default marker as a model when %s",
    (status) => {
      const providerEntry = entry(status, "antigravity");
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: ANTIGRAVITY_DEFAULT_MODEL,
            name: ANTIGRAVITY_DEFAULT_MODEL,
            isUnavailable: true,
          },
          activeInstanceId: providerEntry.instanceId,
          activeModel: ANTIGRAVITY_DEFAULT_MODEL,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["opencode", "error"],
    ["opencode", "warning"],
    ["antigravity", "error"],
    ["antigravity", "warning"],
  ] as const)(
    "keeps only the active synthetic %s row when the provider status is %s",
    (driver, status) => {
      const providerEntry = entry(status, driver);
      const activeInstanceId = providerEntry.instanceId;
      const activeModel = "missing-model";

      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: activeModel,
            name: activeModel,
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(true);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: "stale/model", name: "Stale model" },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: "other/missing",
            name: "Other missing",
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: activeModel, name: activeModel, isUnavailable: true },
          activeInstanceId: ProviderInstanceId.make(`${driver}_personal`),
          activeModel,
        }),
      ).toBe(false);
    },
  );
});

describe("isModelPickerHarnessOptionDisabled", () => {
  it("enables ready harnesses and disables not-ready ones", () => {
    expect(isModelPickerHarnessOptionDisabled({ entry: entry("ready", "codex") })).toBe(false);
    expect(isModelPickerHarnessOptionDisabled({ entry: entry("error", "codex") })).toBe(true);
  });

  it("keeps a not-ready harness selectable when its unavailable model is reachable", () => {
    const providerEntry = entry("error", "codex");
    expect(
      isModelPickerHarnessOptionDisabled({
        entry: providerEntry,
        selectableUnavailableInstanceIds: new Set([providerEntry.instanceId]),
      }),
    ).toBe(false);
  });

  it("disables harnesses locked out by the current thread", () => {
    const providerEntry = entry("ready", "codex");
    expect(
      isModelPickerHarnessOptionDisabled({
        entry: providerEntry,
        lockedDisabledInstanceIds: new Set([providerEntry.instanceId]),
      }),
    ).toBe(true);
  });
});

describe("resolveModelPickerSelectedModel", () => {
  it("follows the catalog default for the marker but keeps an explicit native model", () => {
    const driverKind = ProviderDriverKind.make("antigravity");
    const previousOptions = [
      { slug: "gemini-fast", name: "Gemini Fast", aliases: [ANTIGRAVITY_DEFAULT_MODEL] },
      { slug: "gemini-pro", name: "Gemini Pro" },
    ];
    const nextOptions = [
      { slug: "gemini-fast", name: "Gemini Fast" },
      { slug: "gemini-pro", name: "Gemini Pro", aliases: [ANTIGRAVITY_DEFAULT_MODEL] },
    ];

    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: previousOptions,
      })?.slug,
    ).toBe("gemini-fast");
    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: nextOptions,
      })?.slug,
    ).toBe("gemini-pro");
    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: "gemini-fast",
        options: nextOptions,
      })?.slug,
    ).toBe("gemini-fast");
  });

  it("does not guess the default from the first model in a catalog", () => {
    expect(
      resolveModelPickerSelectedModel({
        driverKind: ProviderDriverKind.make("antigravity"),
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: [{ slug: "gemini-fast", name: "Gemini Fast" }],
      }),
    ).toBeUndefined();
  });
});

describe("buildLogicalModelPickerItems", () => {
  const optionsMap = (entries: ReturnType<typeof deriveProviderInstanceEntries>) =>
    new Map(entries.map((entry) => [entry.instanceId, entry.models] as const));

  it("pools same-slug pairings across instances and marks the active selection", () => {
    const entries = deriveProviderInstanceEntries([
      snapshot({
        instanceId: "codex",
        driver: "codex",
        models: [model("gpt-5.6-sol", "GPT-5.6 Sol")],
      }),
      snapshot({
        instanceId: "codex_personal",
        driver: "codex",
        models: [model("gpt-5.6-sol", "GPT-5.6 Sol")],
      }),
    ]);

    const items = buildLogicalModelPickerItems({
      logicalModels: [
        logicalModel("gpt-5.6-sol", "GPT-5.6 Sol", [
          { instanceId: "codex" },
          { instanceId: "codex_personal" },
        ]),
      ],
      modelOptionsByInstance: optionsMap(entries),
      instanceEntries: entries,
      activeInstanceId: ProviderInstanceId.make("codex_personal"),
      activeModel: "gpt-5.6-sol",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      modelId: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      isLegacy: false,
      isActive: true,
    });
    expect(items[0]?.sources.map((source) => source.instanceId)).toEqual([
      "codex",
      "codex_personal",
    ]);
  });

  it("drops sources on instances that are not picker-ready", () => {
    const entries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "codex", driver: "codex", models: [model("m1", "M1")] }),
      snapshot({
        instanceId: "codex_broken",
        driver: "codex",
        status: "error",
        models: [model("m1", "M1")],
      }),
    ]);

    const items = buildLogicalModelPickerItems({
      logicalModels: [
        logicalModel("m1", "M1", [{ instanceId: "codex" }, { instanceId: "codex_broken" }]),
      ],
      modelOptionsByInstance: optionsMap(entries),
      instanceEntries: entries,
      activeInstanceId: ProviderInstanceId.make("codex"),
      activeModel: "m1",
    });

    expect(items[0]?.sources.map((source) => source.instanceId)).toEqual(["codex"]);
  });

  it("keeps the active selection reachable as a synthetic item when the catalog cannot see it", () => {
    const entries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "opencode_work", driver: "opencode" }),
    ]);
    const modelOptionsByInstance = new Map([
      [
        ProviderInstanceId.make("opencode_work"),
        [{ slug: "missing/model", name: "missing/model", isUnavailable: true }],
      ],
    ]);

    const items = buildLogicalModelPickerItems({
      logicalModels: [],
      modelOptionsByInstance,
      instanceEntries: entries,
      activeInstanceId: ProviderInstanceId.make("opencode_work"),
      activeModel: "missing/model",
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      modelId: "missing/model",
      displayName: "missing/model",
      isActive: true,
      isActiveUnavailable: true,
    });
  });

  it("locks the pool to the locked driver kind", () => {
    const entries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "codex", driver: "codex", models: [model("shared", "Shared")] }),
      snapshot({
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        models: [model("shared", "Shared")],
      }),
    ]);

    const items = buildLogicalModelPickerItems({
      logicalModels: [
        logicalModel("shared", "Shared", [{ instanceId: "codex" }, { instanceId: "claudeAgent" }]),
      ],
      modelOptionsByInstance: optionsMap(entries),
      instanceEntries: entries,
      activeInstanceId: ProviderInstanceId.make("codex"),
      activeModel: "shared",
      lockedProvider: ProviderDriverKind.make("codex"),
    });

    expect(items[0]?.sources.map((source) => source.instanceId)).toEqual(["codex"]);
  });

  it("flags a model legacy when every pairing is legacy", () => {
    const legacy = { ...model("old-model", "Old Model"), isLegacy: true };
    const entries = deriveProviderInstanceEntries([
      snapshot({ instanceId: "codex", driver: "codex", models: [legacy, model("new", "New")] }),
      snapshot({
        instanceId: "codex_personal",
        driver: "codex",
        models: [legacy, model("new", "New")],
      }),
    ]);

    const items = buildLogicalModelPickerItems({
      logicalModels: [
        logicalModel("old-model", "Old Model", [
          { instanceId: "codex" },
          { instanceId: "codex_personal" },
        ]),
        logicalModel("new", "New", [{ instanceId: "codex" }]),
      ],
      modelOptionsByInstance: optionsMap(entries),
      instanceEntries: entries,
      activeInstanceId: ProviderInstanceId.make("codex"),
      activeModel: "new",
    });

    expect(items.find((item) => item.modelId === "old-model")?.isLegacy).toBe(true);
    expect(items.find((item) => item.modelId === "new")?.isLegacy).toBe(false);
  });
});

describe("modelPickerLogicalModelKey", () => {
  it("round-trips logical model keys", () => {
    const key = modelPickerLogicalModelKey("gpt-5.6-sol");
    expect(parseModelPickerLogicalModelKey(key)).toBe("gpt-5.6-sol");
    expect(parseModelPickerLogicalModelKey("model:5:codexgpt")).toBeNull();
    expect(LOGICAL_LEGACY_SECTION_KEY.startsWith("legacy-models:")).toBe(true);
  });
});

describe("shouldOfferModelPickerSetup", () => {
  const availableModel = { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" };

  it("offers setup before an Antigravity account has models", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "antigravity"), [])).toBe(true);
  });

  it("offers setup after sign-out even if a model remains cached", () => {
    const providerEntry = entry("ready", "antigravity");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: { ...providerEntry.snapshot, auth: { status: "unauthenticated" } },
        },
        [availableModel],
      ),
    ).toBe(true);
  });

  it("offers setup when the only model is an unavailable saved selection", () => {
    expect(
      shouldOfferModelPickerSetup(entry("ready", "antigravity"), [
        { ...availableModel, isUnavailable: true },
      ]),
    ).toBe(true);
  });

  it("does not offer setup for a ready account with available models", () => {
    expect(shouldOfferModelPickerSetup(entry("ready", "antigravity"), [availableModel])).toBe(
      false,
    );
  });

  it("does not restore a disabled provider while its status snapshot is stale", () => {
    expect(
      shouldOfferModelPickerSetup({ ...entry("error", "antigravity"), enabled: false }, []),
    ).toBe(false);
  });

  it("keeps providers without integrated setup on their existing path", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "codex"), [])).toBe(false);
  });

  it("uses the environment's setup capability for other drivers", () => {
    const providerEntry = entry("error", "custom_driver");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: {
            ...providerEntry.snapshot,
            setup: { canAuthenticate: true, canInstall: false },
          },
        },
        [],
      ),
    ).toBe(true);
  });
});

describe("adjacentModelPickerProvider", () => {
  const codex = entry("ready", "codex");
  const claude = entry("ready", "claudeAgent");
  const unavailable = entry("error");
  const input = {
    entries: [codex, unavailable, claude],
    disabledInstanceIds: undefined,
    selectableUnavailableInstanceIds: undefined,
  };

  it("wraps through favorites and ready instances, skipping unavailable providers", () => {
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: codex.instanceId, direction: 1 }),
    ).toBe(claude.instanceId);
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: "favorites", direction: -1 }),
    ).toBe(claude.instanceId);
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: claude.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
  });

  it("keeps thread locks and the selected unavailable catalog", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        disabledInstanceIds: new Set([claude.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectableUnavailableInstanceIds: new Set([unavailable.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe(unavailable.instanceId);
  });

  it("handles an empty catalog and a removed selection in either direction", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        entries: [],
        selectedInstanceId: codex.instanceId,
        direction: -1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: -1,
      }),
    ).toBe(claude.instanceId);
  });
});
