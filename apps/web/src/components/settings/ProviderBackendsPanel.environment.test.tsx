import type { ReactElement, ReactNode } from "react";
import {
  ModelBackendConnectionId,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ModelCredentialId,
  ModelVendor,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelProxyConfig,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { MODEL_CREDENTIAL_VALUE_REDACTED } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: null as ReadonlyArray<ServerProvider> | null,
  providersAtom: Symbol("providers"),
  refreshProviders: Symbol("refreshProviders"),
  testModelBackend: Symbol("testModelBackend"),
  updateSettings: Symbol("updateSettings"),
}));

type TestEnvironment = {
  environmentId: EnvironmentId;
  label: string;
  connection: { phase: "connected" | "disconnected" };
  serverConfig: { settings: UnifiedSettings } | null;
};

const environmentState = vi.hoisted(() => ({
  environments: [] as TestEnvironment[],
}));

const commands = vi.hoisted(() => ({
  testBackend: vi.fn(),
  refreshProviders: vi.fn(),
  persistSettings: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  readEnvironmentIds: [] as EnvironmentId[],
  updateSettings: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atoms.providers,
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => atoms.providersAtom,
    testModelBackend: atoms.testModelBackend,
    refreshProviders: atoms.refreshProviders,
    updateSettings: atoms.updateSettings,
  },
}));

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: environmentState.environments, isReady: true }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.refreshProviders) return commands.refreshProviders;
    if (atom === atoms.testModelBackend) return commands.testBackend;
    if (atom === atoms.updateSettings) return commands.persistSettings;
    throw new Error("Unexpected atom command");
  },
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: () => settingsState.updateSettings,
}));

import { EnvironmentProviderBackends } from "./ProviderBackendsPanel";
import { AddBackendConnectionDialog } from "./AddBackendConnectionDialog";

import { ProviderAuthSection } from "./ProviderAuthSection";
import { UsageProviderSettings } from "./UsageProviderSettings";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");

function provider(overrides?: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    // A plan-style auth type classifies as subscription-bound in the catalog.
    auth: { status: "authenticated", type: "subscription" },
    checkedAt: "2026-07-24T12:00:00.000Z",
    models: [{ slug: "gpt-5.2", name: "GPT-5.2", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function baseSettings(): UnifiedSettings {
  // Branded record keys cannot be written as plain literal keys, so the
  // fixture asserts through a cast like `providerBackend.logic.test.ts` does.
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [codexId]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        connectionId: "main",
      },
    },
    modelBackendConnections: {
      main: {
        baseUrl: "https://proxy.example/v1",
        displayName: "My proxy",
        protocols: ["openai", "anthropic"],
        apiKeyCredentialId: "anthropic-work",
        models: ["claude-sonnet-4"],
      },
    },
    modelCredentials: {
      "anthropic-work": {
        displayName: "Anthropic work key",
        vendor: "anthropic",
        value: MODEL_CREDENTIAL_VALUE_REDACTED,
        lastFour: "ab12",
      },
    },
    modelRouterRoutes: {
      "gpt-5.2": { target: { kind: "connection", connectionId: "main" } },
    },
  } as unknown as UnifiedSettings;
}

function renderPanel(options?: {
  readonly readOnly?: boolean;
}): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return EnvironmentProviderBackends({
    environmentId,
    environmentLabel: "Remote device",
    ...(options?.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  }) as ReactElement<Record<string, unknown>>;
}

function invoke(element: ReactElement<Record<string, unknown>>): unknown {
  return (element.type as (props: Record<string, unknown>) => unknown)(element.props);
}

function connectedEnvironment(id: string, settings = baseSettings()): TestEnvironment {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connection: { phase: "connected" },
    serverConfig: { settings },
  };
}

function button(tree: ReactNode, label: string) {
  const element = visitElements(
    tree,
    (entry) =>
      typeof entry.props.onClick === "function" &&
      (entry.props.children === label ||
        (Array.isArray(entry.props.children) && entry.props.children.includes(label))),
  );
  if (!element) throw new Error(`Button not found: ${label}`);
  return element;
}

function click(tree: ReactNode, label: string) {
  return (button(tree, label).props.onClick as () => Promise<void> | void)();
}

function changeInput(tree: ReactNode, id: string, value: string) {
  const input = visitElements(tree, (entry) => entry.props.id === id);
  if (!input) throw new Error(`Input not found: ${id}`);
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

function addDialog(settings = baseSettings()) {
  const onOpenChange = vi.fn();
  const render = () => {
    hooks.beginRender();
    return AddBackendConnectionDialog({
      open: true,
      onOpenChange,
      environmentId,
      environmentLabel: "Remote device",
      connections: settings.modelBackendConnections,
      credentials: settings.modelCredentials,
    });
  };
  const presets = visitElements(
    render(),
    (entry) => entry.props["aria-label"] === "Provider template",
  );
  (presets!.props.onValueChange as (value: string) => void)("custom");
  void click(render(), "Next");
  changeInput(render(), "backend-connection-id", "new-provider");
  changeInput(render(), "backend-connection-url", "https://new.example/v1");
  return { render, onOpenChange };
}

const newCredential = {
  displayName: "new-provider API key",
  vendor: ModelVendor.make("custom"),
  value: "test-only-plaintext-key",
};
const newConnection = {
  baseUrl: "https://new.example/v1",
  protocols: ["openai"],
  apiKeyCredentialId: ModelCredentialId.make("new-provider-key"),
};

describe("EnvironmentProviderBackends", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    settingsState.value = baseSettings();
    settingsState.readEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    commands.testBackend.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { ok: true, protocols: ["openai"], checkedAt: "2026-07-24T12:00:00.000Z" },
    });
    commands.persistSettings.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    commands.refreshProviders.mockReset();
    environmentState.environments = [connectedEnvironment(environmentId)];
  });
  it.each([["openai"], ["anthropic"], ["openai", "anthropic"]])(
    "saves detected protocols %j instead of the old selection",
    async (...protocols) => {
      const onOpenChange = vi.fn();
      commands.testBackend.mockResolvedValue({
        _tag: "Success",
        value: {
          ok: true,
          protocols,
          checkedAt: "2026-07-24T12:00:00.000Z",
        },
      });
      const settings = baseSettings();
      hooks.beginRender();
      const dialog = AddBackendConnectionDialog({
        open: true,
        onOpenChange,
        environmentId,
        environmentLabel: "Remote device",
        connections: settings.modelBackendConnections,
        credentials: settings.modelCredentials,
        editingId: "main",
      });
      const save = visitElements(dialog, (element) => element.props.children === "Save changes");
      expect(save).not.toBeNull();
      await (save!.props.onClick as () => Promise<void>)();
      expect(commands.testBackend).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId,
          input: expect.objectContaining({ apiKeyCredentialId: "anthropic-work" }),
        }),
      );
      expect(commands.persistSettings).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          patch: {
            modelBackendConnections: {
              ...settings.modelBackendConnections,
              main: {
                ...settings.modelBackendConnections[ModelBackendConnectionId.make("main")],
                protocols,
              },
            },
          },
        },
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it.each([true, false])("handles inconclusive detection with reachable=%s", async (ok) => {
    commands.testBackend.mockResolvedValue({
      _tag: "Success",
      value: {
        ok,
        protocols: [],
        checkedAt: "2026-07-24T12:00:00.000Z",
      },
    });
    const onOpenChange = vi.fn();
    const settings = baseSettings();
    const render = () => {
      hooks.beginRender();
      return AddBackendConnectionDialog({
        open: true,
        onOpenChange,
        environmentId,
        environmentLabel: "Remote device",
        connections: settings.modelBackendConnections,
        credentials: settings.modelCredentials,
        editingId: "main",
      });
    };
    const save = visitElements(render(), (element) => element.props.children === "Save changes");
    await (save!.props.onClick as () => Promise<void>)();
    if (ok) {
      expect(commands.persistSettings).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { patch: { modelBackendConnections: settings.modelBackendConnections } },
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
      return;
    }
    expect(commands.persistSettings).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      visitElements(
        render(),
        (element) =>
          element.props.role === "alert" &&
          String(element.props.children).includes("Could not detect"),
      ),
    ).not.toBeNull();
  });

  it("renders connections, API keys, and routing for one environment", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();

    // The connections section is the tab's only section; API keys are
    // created inline from the Add-provider dialog.
    expect(
      visitElements(panel, (element) => element.props.id === "provider-backends"),
    ).not.toBeNull();
    expect(settingsState.readEnvironmentIds).toContain(environmentId);
  });

  it("shows the connection list beside the selected connection editor", () => {
    atoms.providers = [provider()];
    settingsState.value = {
      ...baseSettings(),
      modelBackendConnections: {
        ...(baseSettings().modelBackendConnections as Record<string, ModelProxyConfig>),
        second: {
          baseUrl: "https://other.example/v1",
          displayName: "Other",
          protocols: ["openai"],
        },
      },
    } as unknown as UnifiedSettings;
    const panel = renderPanel();
    // Both connections appear in the list ...
    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Select My proxy"),
    ).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props["aria-label"] === "Select Other"),
    ).not.toBeNull();
    // ... but only the selected (first) connection renders its editor row.
    expect(
      visitElements(
        panel,
        (element) =>
          element.props.connectionId === "main" && element.props.connection !== undefined,
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        panel,
        (element) =>
          element.props.connectionId === "second" && element.props.connection !== undefined,
      ),
    ).toBeNull();
  });

  it("lists a signed-in account above the connections and adjusts the empty state", () => {
    atoms.providers = [provider()];
    settingsState.value = {
      ...baseSettings(),
      modelBackendConnections: {},
      modelCredentials: {},
      modelRouterRoutes: {},
    } as unknown as UnifiedSettings;
    const panel = renderPanel();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-backends"),
    ).not.toBeNull();
    // The OAuth account renders through ProviderAuthSection ...
    expect(
      visitElements(
        panel,
        (element) => element.type === ProviderAuthSection && element.props.readOnly === false,
      ),
    ).not.toBeNull();
    // ... and the empty state no longer claims nothing was added.
    expect(
      visitElements(panel, (element) => element.props.title === "No API connections added."),
    ).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.title === "No API providers added."),
    ).toBeNull();
    const addButton = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Add provider",
    );
    expect(addButton).not.toBeNull();
  });

  it("keeps the plain empty state while no account is signed in", () => {
    atoms.providers = [provider({ auth: { status: "unauthenticated" } })];
    settingsState.value = {
      ...baseSettings(),
      modelBackendConnections: {},
      modelCredentials: {},
      modelRouterRoutes: {},
    } as unknown as UnifiedSettings;
    const panel = renderPanel();
    expect(
      visitElements(panel, (element) => element.props.title === "No API providers added."),
    ).not.toBeNull();
    expect(visitElements(panel, (element) => element.type === ProviderAuthSection)).toBeNull();
  });

  it("keeps provider-side settings on this tab: usage hubs and the probe interval", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();
    // Usage hubs and the provider probe cadence belong to the API providers
    // (not the harness instances), so the Harness tab renders neither.
    expect(
      visitElements(panel, (element) => element.type === UsageProviderSettings),
    ).not.toBeNull();
    expect(
      visitElements(panel, (element) => element.props.id === "provider-health-check-interval"),
    ).not.toBeNull();
    expect(visitElements(panel, (element) => element.props.title === "Advanced")).not.toBeNull();
  });

  it("flags a connection whose stored key is gone", () => {
    atoms.providers = [provider()];
    settingsState.value = { ...baseSettings(), modelCredentials: {} };
    const row = visitElements(
      renderPanel(),
      (element) => element.props.connection !== undefined && element.props.onRemove !== undefined,
    );
    expect(row?.props.credential).toBeUndefined();
    expect((row?.props.connection as ModelProxyConfig | undefined)?.apiKeyCredentialId).toBe(
      "anthropic-work",
    );
  });

  it("removes a connection through the whole-map patch", () => {
    atoms.providers = [provider()];
    const row = visitElements(
      renderPanel(),
      (element) => element.props.connection !== undefined && element.props.onRemove !== undefined,
    );
    if (!row) throw new Error("Connection row was not rendered");
    hooks.reset();
    let rowTree = invoke(row);
    const remove = visitElements(rowTree, (element) => element.props.children === "Remove");
    (remove?.props.onClick as (() => void) | undefined)?.();
    rowTree = invoke(row);
    const confirm = visitElements(
      rowTree,
      (element) =>
        element.props.children === "Remove provider" && typeof element.props.onClick === "function",
    );
    (confirm?.props.onClick as (() => void) | undefined)?.();

    expect(settingsState.updateSettings).toHaveBeenCalledExactlyOnceWith({
      modelBackendConnections: {},
    });
  });

  it("fans a staged new key out to connected environments with per-environment ids", async () => {
    environmentState.environments = [
      connectedEnvironment("device-a", {
        ...baseSettings(),
        modelBackendConnections: {},
        modelCredentials: {},
        modelRouterRoutes: {},
      } as unknown as UnifiedSettings),
      connectedEnvironment("device-b", {
        ...baseSettings(),
        modelBackendConnections: {
          main: {
            baseUrl: "https://proxy.example/v1",
            displayName: "My proxy",
            protocols: ["openai", "anthropic"],
            apiKeyCredentialId: "new-provider-key",
            models: ["claude-sonnet-4"],
          },
        },
        modelCredentials: {
          "new-provider-key": {
            displayName: "Existing key",
            vendor: ModelVendor.make("openai"),
            value: MODEL_CREDENTIAL_VALUE_REDACTED,
            lastFour: "zz99",
          },
        },
        modelRouterRoutes: {},
      } as unknown as UnifiedSettings),
    ];
    const { render, onOpenChange } = addDialog();
    changeInput(render(), "backend-connection-credential", newCredential.value);
    await click(render(), "Add provider");
    expect(commands.persistSettings).toHaveBeenCalledTimes(3);
    expect(commands.persistSettings).toHaveBeenNthCalledWith(1, {
      environmentId,
      input: {
        patch: {
          modelCredentials: {
            ...baseSettings().modelCredentials,
            "new-provider-key": newCredential,
          },
          modelBackendConnections: {
            ...baseSettings().modelBackendConnections,
            "new-provider": newConnection,
          },
        },
      },
    });
    expect(commands.persistSettings).toHaveBeenNthCalledWith(2, {
      environmentId: environmentState.environments[0]!.environmentId,
      input: {
        patch: {
          modelCredentials: { "new-provider-key": newCredential },
          modelBackendConnections: { "new-provider": newConnection },
        },
      },
    });
    const targetSettings = environmentState.environments[1]!.serverConfig!.settings;
    expect(commands.persistSettings).toHaveBeenNthCalledWith(3, {
      environmentId: environmentState.environments[1]!.environmentId,
      input: {
        patch: {
          modelCredentials: {
            ...targetSettings.modelCredentials,
            "new-provider-key-2": newCredential,
          },
          modelBackendConnections: {
            ...targetSettings.modelBackendConnections,
            "new-provider": {
              ...newConnection,
              apiKeyCredentialId: "new-provider-key-2",
            },
          },
        },
      },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("excludes disconnected environments from the new-key fanout", async () => {
    environmentState.environments = [
      { ...connectedEnvironment("device-a"), connection: { phase: "disconnected" } },
    ];
    const { render, onOpenChange } = addDialog();
    changeInput(render(), "backend-connection-credential", newCredential.value);
    await click(render(), "Add provider");
    expect(commands.persistSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ environmentId }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("retries only the environments whose copy failed", async () => {
    environmentState.environments = [
      connectedEnvironment("device-a"),
      connectedEnvironment("device-b"),
    ];
    commands.persistSettings
      .mockResolvedValueOnce({ _tag: "Success", value: undefined })
      .mockRejectedValueOnce(new Error("transport down"))
      .mockResolvedValueOnce({ _tag: "Success", value: undefined });
    const { render, onOpenChange } = addDialog();
    changeInput(render(), "backend-connection-credential", newCredential.value);
    await click(render(), "Add provider");
    expect(commands.persistSettings).toHaveBeenCalledTimes(3);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      visitElements(
        render(),
        (element) =>
          element.props.role === "alert" &&
          String(element.props.children).includes("Could not copy to: device-a"),
      ),
    ).not.toBeNull();
    commands.persistSettings.mockClear();
    commands.persistSettings.mockResolvedValue({ _tag: "Success", value: undefined });
    await click(render(), "Retry failed machines");
    expect(commands.persistSettings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ environmentId: environmentState.environments[0]!.environmentId }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open with an error when the local save fails", async () => {
    commands.persistSettings.mockRejectedValue(new Error("server rejected"));
    const { render, onOpenChange } = addDialog();
    changeInput(render(), "backend-connection-credential", newCredential.value);
    await click(render(), "Add provider");
    expect(
      visitElements(
        render(),
        (element) =>
          element.props.role === "alert" &&
          String(element.props.children).includes("Could not save the provider"),
      ),
    ).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("replaces a key without changing credentials shared by other connections", async () => {
    const settings = baseSettings();
    const render = () => {
      hooks.beginRender();
      return AddBackendConnectionDialog({
        open: true,
        onOpenChange: vi.fn(),
        environmentId,
        environmentLabel: "Remote device",
        connections: settings.modelBackendConnections,
        credentials: settings.modelCredentials,
        editingId: "main",
      });
    };
    changeInput(render(), "backend-connection-credential", " replacement-key ");
    await click(render(), "Save changes");
    expect(commands.testBackend).toHaveBeenCalledWith({
      environmentId,
      input: { backend: expect.objectContaining({ apiKey: "replacement-key" }) },
    });
    expect(commands.persistSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        patch: {
          modelCredentials: {
            ...settings.modelCredentials,
            "main-key": {
              displayName: "My proxy API key",
              vendor: "custom",
              value: "replacement-key",
            },
          },
          modelBackendConnections: {
            ...settings.modelBackendConnections,
            main: {
              ...settings.modelBackendConnections[ModelBackendConnectionId.make("main")],
              protocols: ["openai"],
              apiKeyCredentialId: "main-key",
            },
          },
        },
      },
    });
  });

  it.each(["Test connection", "Fetch models"])(
    "uses the inline key for %s without saving",
    async (action) => {
      const { render } = addDialog();
      changeInput(render(), "backend-connection-credential", `  ${newCredential.value}  `);
      await click(render(), action);
      expect(commands.testBackend).toHaveBeenCalledWith({
        environmentId,
        input: {
          backend: expect.objectContaining({
            kind: "openai-compatible",
            baseUrl: newConnection.baseUrl,
            apiKey: newCredential.value,
          }),
        },
      });
      expect(commands.persistSettings).not.toHaveBeenCalled();
    },
  );

  it("keeps the tab readable and write-free when read only", () => {
    atoms.providers = [provider()];
    const panel = renderPanel({ readOnly: true });

    expect(
      visitElements(panel, (element) => element.props.title === "Limited permissions"),
    ).not.toBeNull();
    expect(
      visitElements(
        panel,
        (element) =>
          Array.isArray(element.props.children) && element.props.children.includes("Add provider"),
      ),
    ).toBeNull();
    const row = visitElements(
      panel,
      (element) => element.props.connection !== undefined && element.props.onRemove !== undefined,
    );
    expect(row?.props.readOnly).toBe(true);
  });
});
