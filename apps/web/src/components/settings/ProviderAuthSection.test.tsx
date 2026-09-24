import type { FunctionComponent, ReactElement } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  authState: vi.fn(() => "auth"),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  cancelAuth: vi.fn(),
  logoutAuth: vi.fn(),
  confirm: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useEffect: () => undefined,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: setup.authState,
    startProviderAuth: setup.startAuth,
    completeProviderAuth: setup.completeAuth,
    cancelProviderAuth: setup.cancelAuth,
    logoutProviderAuth: setup.logoutAuth,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string) => ({
    data: atom === "auth" ? setup.auth : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    shell: { openExternal: setup.openExternal },
    dialogs: { confirm: setup.confirm },
  }),
}));

vi.mock("../../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: (...args: Array<unknown>) => setup.copy(...args),
}));

import { ProviderAuthSection } from "./ProviderAuthSection";

const environmentId = EnvironmentId.make("remote-codex");
const instanceId = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");
const claudeDriver = ProviderDriverKind.make("claudeAgent");

const WAITING_CODEX: ProviderAuthState = {
  instanceId,
  phase: "waiting",
  flowId: "flow-1",
  authorizationUrl: "https://auth.openai.com/codex/device",
  userCode: "ESK2-2VIU7",
  expiresAt: "2026-09-02T00:15:00.000Z",
  message: null,
};

const WAITING_CLAUDE: ProviderAuthState = {
  instanceId,
  phase: "waiting",
  flowId: "flow-2",
  authorizationUrl: "https://claude.com/cai/oauth/authorize?code=true",
  expiresAt: "2026-09-02T00:10:00.000Z",
  message: null,
};

function provider(authStatus: ServerProvider["auth"]["status"] = "unknown"): ServerProvider {
  return {
    instanceId,
    driver: codexDriver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: authStatus },
    checkedAt: "2026-09-02T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    setup: { canAuthenticate: true, canInstall: false },
  };
}

function renderSection(
  options: {
    readonly driver?: ProviderDriverKind;
    readonly auth?: ProviderAuthState | null;
    readonly provider?: ServerProvider;
    readonly readOnly?: boolean;
    readonly onRefreshStatus?: (() => void) | undefined;
  } = {},
) {
  hooks.beginRender();
  setup.auth = options.auth ?? null;
  return ProviderAuthSection({
    environmentId,
    environmentLabel: "Remote device",
    instanceId,
    driver: options.driver ?? codexDriver,
    displayName: "Codex",
    provider: options.provider ?? provider(),
    readOnly: options.readOnly ?? false,
    onRefreshStatus: options.onRefreshStatus,
  }) as ReactElement<Record<string, unknown>>;
}

function invoke(element: ReactElement<Record<string, unknown>>): unknown {
  return (element.type as FunctionComponent<Record<string, unknown>>)(element.props);
}

function buttonText(view: unknown): Array<string> {
  const found: Array<string> = [];
  visitElements(view, (element) => {
    if (typeof element.props.children === "string" && typeof element.props.onClick === "function") {
      found.push(element.props.children);
    }
    return false;
  });
  return found;
}

function viewText(view: unknown): string {
  const parts: Array<string> = [];
  visitElements(view, (element) => {
    if (typeof element.props.children === "string") parts.push(element.props.children);
    return false;
  });
  return parts.join(" ");
}

describe("ProviderAuthSection", () => {
  beforeEach(() => {
    hooks.reset();
    vi.clearAllMocks();
    for (const command of [
      setup.startAuth,
      setup.completeAuth,
      setup.cancelAuth,
      setup.logoutAuth,
    ]) {
      command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    }
    setup.confirm.mockReset().mockResolvedValue(false);
    setup.openExternal.mockReset().mockResolvedValue(undefined);
    setup.copy.mockReset().mockResolvedValue(undefined);
  });

  it("offers in-app sign-in while idle", () => {
    const buttons = buttonText(
      invoke(renderSection({ auth: { ...WAITING_CODEX, phase: "idle", flowId: null } })),
    );
    expect(buttons).toContain("Sign in with ChatGPT");
  });

  it("shows the device code and sign-in link while waiting", () => {
    const view = invoke(renderSection({ auth: WAITING_CODEX }));
    const text = viewText(view);
    expect(text).toContain("ESK2-2VIU7");
    expect(buttonText(view)).toContain("Open sign-in page");
  });

  it("shows the paste-code form for Claude while waiting", () => {
    const view = invoke(
      renderSection({ driver: claudeDriver, auth: WAITING_CLAUDE, provider: provider() }),
    );
    const input = visitElements(
      view,
      (element) => element.props.id === `provider-auth-code-${instanceId}`,
    );
    expect(input).not.toBeNull();
    expect(viewText(view)).not.toContain("ESK2-2VIU7");
  });

  it("starts sign-in through the selected environment", () => {
    const view = invoke(renderSection({ auth: { ...WAITING_CODEX, phase: "idle", flowId: null } }));
    const target = visitElements(
      view,
      (element) =>
        element.props.children === "Sign in with ChatGPT" &&
        typeof element.props.onClick === "function",
    );
    if (!target) throw new Error("Missing sign-in button");
    (target.props.onClick as () => void)();
    expect(setup.startAuth).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId },
    });
  });

  it("signs out after confirming", async () => {
    setup.confirm.mockResolvedValue(true);
    const view = invoke(renderSection({ auth: null, provider: provider("authenticated") }));
    const target = visitElements(
      view,
      (element) =>
        element.props.children === "Sign out" && typeof element.props.onClick === "function",
    );
    if (!target) throw new Error("Missing sign-out button");
    (target.props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    expect(setup.logoutAuth).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId },
    });
  });

  it("refreshes provider status after signing out", async () => {
    setup.confirm.mockResolvedValue(true);
    const onRefreshStatus = vi.fn();
    const view = invoke(
      renderSection({ auth: null, provider: provider("authenticated"), onRefreshStatus }),
    );
    const target = visitElements(
      view,
      (element) =>
        element.props.children === "Sign out" && typeof element.props.onClick === "function",
    );
    if (!target) throw new Error("Missing sign-out button");
    (target.props.onClick as () => void)();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(setup.logoutAuth).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId },
    });
    expect(onRefreshStatus).toHaveBeenCalledTimes(1);
  });

  it("stays read-only without actions", () => {
    const view = renderSection({ readOnly: true });
    expect(viewText(view)).toContain("Setup unavailable");
    expect(buttonText(view)).toEqual([]);
  });
});
