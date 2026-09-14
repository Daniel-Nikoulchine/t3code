import type { ReactElement } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
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
  testModelBackend: Symbol("testModelBackend"),
}));

const commands = vi.hoisted(() => ({
  testBackend: vi.fn(),
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
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => commands.testBackend,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    settingsState.readEnvironmentIds.push(environmentId);
    return settingsState.value;
  },
  useUpdateEnvironmentSettings: () => settingsState.updateSettings,
}));

import { EnvironmentProviderBackends } from "./ProviderBackendsPanel";
import { ModelCatalogSection } from "./ModelCatalogSection";
import { ModelRouterSection } from "./ModelRouterSection";
import { ProviderCredentialsSection } from "./ProviderCredentialsSection";

const environmentId = EnvironmentId.make("remote-device");
const codexId = ProviderInstanceId.make("codex");

function provider(): ServerProvider {
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

function isHeaderText(text: string) {
  return (element: ReactElement<Record<string, unknown>>) => element.props.children === text;
}

function invoke(element: ReactElement<Record<string, unknown>>): unknown {
  return (element.type as (props: Record<string, unknown>) => unknown)(element.props);
}

describe("EnvironmentProviderBackends", () => {
  beforeEach(() => {
    hooks.reset();
    atoms.providers = null;
    settingsState.value = baseSettings();
    settingsState.readEnvironmentIds = [];
    settingsState.updateSettings.mockReset();
    commands.testBackend.mockReset();
  });

  it("renders connections, API keys, and the models matrix for one environment", () => {
    atoms.providers = [provider()];
    const panel = renderPanel();

    // The connections section lives in this component's own body; the
    // credential, catalog, and routing sections are child components,
    // checked by the environment data handed to them.
    expect(
      visitElements(panel, (element) => element.props.id === "provider-backends"),
    ).not.toBeNull();
    const credentialsSection = visitElements(
      panel,
      (element) => element.type === ProviderCredentialsSection,
    );
    expect(credentialsSection?.props.connections).toHaveProperty("main");
    const catalogSection = visitElements(panel, (element) => element.type === ModelCatalogSection);
    expect(catalogSection?.props.environmentId).toBe(environmentId);
    const routerSection = visitElements(panel, (element) => element.type === ModelRouterSection);
    expect(routerSection?.props.environmentId).toBe(environmentId);
    expect(settingsState.readEnvironmentIds).toContain(environmentId);
  });

  it("derives the matrix from provider snapshots plus the instance links", () => {
    atoms.providers = [provider()];
    const matrix = invoke(
      visitElements(renderPanel(), (element) => element.type === ModelCatalogSection)!,
    );
    // codex serves the snapshot model natively (subscription-bound auth) and
    // the connection-served model via its link — no gap chips.
    expect(visitElements(matrix, isHeaderText("GPT-5.2"))).not.toBeNull();
    expect(visitElements(matrix, isHeaderText("claude-sonnet-4"))).not.toBeNull();
    expect(visitElements(matrix, isHeaderText("Subscription"))).not.toBeNull();
    expect(visitElements(matrix, isHeaderText("Needs API key"))).toBeNull();
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

  it("removes a route through the whole-map patch, keeping other routes", () => {
    atoms.providers = [provider()];
    settingsState.value = {
      ...baseSettings(),
      modelRouterRoutes: {
        "gpt-5.2": { target: { kind: "connection", connectionId: "main" } },
        "claude-sonnet-4": { target: { kind: "connection", connectionId: "main" } },
      },
    } as unknown as UnifiedSettings;
    const section = visitElements(renderPanel(), (element) => element.type === ModelRouterSection);
    if (!section) throw new Error("Routing section was not rendered");
    hooks.reset();
    const sectionTree = invoke(section);
    const row = visitElements(
      sectionTree,
      (element) => element.props.route !== undefined && element.props.onRemove !== undefined,
    );
    if (!row) throw new Error("Route row was not rendered");
    hooks.reset();
    let rowTree = invoke(row);
    const remove = visitElements(rowTree, (element) => element.props.children === "Remove");
    (remove?.props.onClick as (() => void) | undefined)?.();
    rowTree = invoke(row);
    const confirm = visitElements(
      rowTree,
      (element) =>
        element.props.children === "Remove route" && typeof element.props.onClick === "function",
    );
    (confirm?.props.onClick as (() => void) | undefined)?.();

    expect(settingsState.updateSettings).toHaveBeenCalledExactlyOnceWith({
      modelRouterRoutes: {
        "claude-sonnet-4": { target: { kind: "connection", connectionId: "main" } },
      },
    });
  });

  it("keeps every section readable and write-free when read only", () => {
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
