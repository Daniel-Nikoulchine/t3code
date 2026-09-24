import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderInstanceRows } from "./providerInstanceRows";

const codexDriver = ProviderDriverKind.make("codex");
const codexId = ProviderInstanceId.make("codex");
const customId = ProviderInstanceId.make("codex_work");
const cursorDriver = ProviderDriverKind.make("cursor");
const cursorId = ProviderInstanceId.make("cursor");

function cursorSnapshot(): ServerProvider {
  return {
    instanceId: cursorId,
    driver: cursorDriver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "current",
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      updateCommand: "cursor-agent update",
      canUpdate: false,
      checkedAt: "2026-07-24T12:00:00.000Z",
      message: "Up to date.",
    },
  };
}

describe("buildProviderInstanceRows", () => {
  it("synthesizes clean default slots from the legacy providers blob", () => {
    const rows = buildProviderInstanceRows({
      settings: DEFAULT_UNIFIED_SETTINGS,
      serverProviders: [],
    });
    const codex = rows.find((row) => row.instanceId === codexId);
    expect(codex).toMatchObject({
      instanceId: codexId,
      driver: codexDriver,
      isDefault: true,
      isDirty: false,
    });
    expect(codex?.instance.driver).toBe(codexDriver);
    // The legacy in-config enabled flag is lifted to the envelope; the rows
    // carry no cursor slot until the server reports the driver.
    expect(rows.some((row) => row.instanceId === cursorId)).toBe(false);
  });

  it("prefers the explicit envelope and marks the slot dirty", () => {
    const rows = buildProviderInstanceRows({
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [codexId]: { driver: codexDriver, enabled: false },
        },
      },
      serverProviders: [],
    });
    expect(rows.find((row) => row.instanceId === codexId)).toMatchObject({
      instance: { driver: codexDriver, enabled: false },
      isDefault: true,
      isDirty: true,
    });
  });

  it("marks a diverged legacy blob dirty without an explicit envelope", () => {
    const defaultCodex = DEFAULT_UNIFIED_SETTINGS.providers.codex;
    const rows = buildProviderInstanceRows({
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providers: {
          ...DEFAULT_UNIFIED_SETTINGS.providers,
          codex: { ...defaultCodex, enabled: !defaultCodex.enabled },
        },
      },
      serverProviders: [],
    });
    expect(rows.find((row) => row.instanceId === codexId)).toMatchObject({ isDirty: true });
  });

  it("renders custom instances alongside the default slot", () => {
    const rows = buildProviderInstanceRows({
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [customId]: { driver: codexDriver, enabled: true },
        },
      },
      serverProviders: [],
    });
    expect(rows.find((row) => row.instanceId === codexId)).toMatchObject({ isDefault: true });
    expect(rows.find((row) => row.instanceId === customId)).toMatchObject({
      driver: codexDriver,
      isDefault: false,
    });
  });

  it("reveals the cursor slot once the server reports it", () => {
    const rows = buildProviderInstanceRows({
      settings: DEFAULT_UNIFIED_SETTINGS,
      serverProviders: [cursorSnapshot()],
    });
    expect(rows.find((row) => row.instanceId === cursorId)).toMatchObject({
      driver: cursorDriver,
      isDefault: true,
    });
  });

  it("renders every known driver including Pi, Hermes, and DeepSeek", () => {
    const piDriver = ProviderDriverKind.make("pi");
    const piId = ProviderInstanceId.make("pi");
    const hermesDriver = ProviderDriverKind.make("hermes");
    const hermesId = ProviderInstanceId.make("hermes");
    const deepseekDriver = ProviderDriverKind.make("deepseek");
    const deepseekId = ProviderInstanceId.make("deepseek");
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [piId]: { driver: piDriver, enabled: true },
        [hermesId]: { driver: hermesDriver, enabled: true },
        [deepseekId]: { driver: deepseekDriver, enabled: true },
      },
    };
    const snapshotFor = (
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
    ): ServerProvider => ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "unknown" },
      checkedAt: "2026-07-24T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    });
    const serverProviders: ReadonlyArray<ServerProvider> = [
      snapshotFor(piId, piDriver),
      snapshotFor(hermesId, hermesDriver),
      snapshotFor(deepseekId, deepseekDriver),
    ];
    const harnessRows = buildProviderInstanceRows({ settings, serverProviders });
    expect(harnessRows.some((row) => row.driver === piDriver)).toBe(true);
    expect(harnessRows.some((row) => row.driver === hermesDriver)).toBe(true);
    expect(harnessRows.some((row) => row.driver === deepseekDriver)).toBe(true);
    expect(harnessRows.some((row) => row.instanceId === codexId)).toBe(true);
  });
});
