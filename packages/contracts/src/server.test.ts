import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  isProviderProxied,
  resolveEnvironmentMachineKind,
  ServerConfig,
  ServerProvider,
  ServerProviders,
  ServerTestModelBackendRequest,
  ServerTestModelBackendResult,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings } from "./settings.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);
const decodeUpsertKeybindingResult = Schema.decodeUnknownSync(ServerUpsertKeybindingResult);
const decodeAvailableEditors = Schema.decodeUnknownSync(ServerConfig.fields.availableEditors);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes provider snapshot backend metadata", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      backend: {
        kind: "openai-compatible",
        displayName: "OmniRoute",
        viaProxy: true,
        capabilitiesDegraded: true,
      },
    });

    expect(parsed.backend?.kind).toBe("openai-compatible");
    expect(parsed.backend?.displayName).toBe("OmniRoute");
    expect(parsed.backend?.viaProxy).toBe(true);
    expect(parsed.backend?.capabilitiesDegraded).toBe(true);
    expect(parsed.backend?.nativeFallback).toBeUndefined();
  });

  it("decodes the silent native-fallback marker", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      backend: { kind: "native", viaProxy: false, nativeFallback: true },
    });

    expect(parsed.backend?.kind).toBe("native");
    expect(parsed.backend?.nativeFallback).toBe(true);
    expect(isProviderProxied(parsed)).toBe(false);
  });

  it("decodes legacy provider snapshot without backend as native", () => {
    const parsed = decodeServerProvider(baseProviderSnapshot);

    expect(parsed.backend).toBeUndefined();
    expect(isProviderProxied(parsed)).toBe(false);
  });

  it("treats absent and explicit-native backends as not proxied", () => {
    const legacy = decodeServerProvider(baseProviderSnapshot);
    const native = decodeServerProvider({
      ...baseProviderSnapshot,
      backend: { kind: "native", viaProxy: false },
    });
    const proxied = decodeServerProvider({
      ...baseProviderSnapshot,
      backend: { kind: "openai-compatible", viaProxy: true },
    });

    expect(isProviderProxied(legacy)).toBe(false);
    expect(isProviderProxied(native)).toBe(false);
    expect(isProviderProxied(proxied)).toBe(true);
  });

  it("decodes optional legacy model metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          isLegacy: true,
          capabilities: null,
        },
      ],
    });

    expect(parsed.models[0]?.isLegacy).toBe(true);
  });
});

describe("server config forward compatibility", () => {
  it("drops config issues with kinds this build does not know", () => {
    const parsed = decodeUpsertKeybindingResult({
      keybindings: [],
      issues: [
        { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
        { kind: "keybindings.future-issue", message: "From a newer server" },
      ],
    });

    expect(parsed.issues).toEqual([
      { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
    ]);
  });

  it("drops editor ids this build does not know", () => {
    const parsed = decodeAvailableEditors(["zed", "some-future-editor", "vscode"]);

    expect(parsed).toEqual(["zed", "vscode"]);
  });

  // A provider status this build has never seen (a new ServerProviderState,
  // ServerProviderAuthStatus, etc. member) previously failed the whole
  // `providers` array, taking every other provider down with it and, since
  // `providers` sits inside `ServerConfig`, failing the whole config decode —
  // an older client would drop its connection over one provider it can't
  // render. Dropping just that element keeps every other provider working.
  it("drops providers this build cannot decode instead of failing the whole array", () => {
    const decodedBase = decodeServerProvider(baseProviderSnapshot);

    const parsed = decodeServerProviders([
      baseProviderSnapshot,
      { ...baseProviderSnapshot, instanceId: "future", status: "some-future-status" },
    ]);

    expect(parsed).toEqual([decodedBase]);
  });

  it("drops usage windows this build cannot decode instead of failing the provider", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      usageLimits: {
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [
          { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
          { id: "future", kind: "some-future-kind", label: "Future", usedPercent: 1 },
          { id: "bad", kind: "weekly", label: "Weekly", usedPercent: 120 },
        ],
      },
    });

    expect(parsed.usageLimits?.windows).toEqual([
      { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
    ]);
  });

  it("leaves backendLastVerifiedAt absent for never-verified providers", () => {
    const parsed = decodeServerProvider(baseProviderSnapshot);

    expect(parsed.backendLastVerifiedAt).toBeUndefined();
  });

  it("carries backendLastVerifiedAt for verified providers", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      backendLastVerifiedAt: "2026-09-13T00:00:00.000Z",
    });

    expect(parsed.backendLastVerifiedAt).toBe("2026-09-13T00:00:00.000Z");
  });
});

describe("ServerTestModelBackend", () => {
  const decodeRequest = Schema.decodeUnknownSync(ServerTestModelBackendRequest);
  const decodeResult = Schema.decodeUnknownSync(ServerTestModelBackendResult);

  it("decodes a native backend probe request", () => {
    expect(decodeRequest({ backend: { kind: "native" } })).toEqual({
      backend: { kind: "native" },
    });
  });

  it("decodes an openai-compatible backend probe request", () => {
    expect(
      decodeRequest({
        backend: {
          kind: "openai-compatible",
          baseUrl: "https://gateway.example/v1",
          apiKeyEnv: "GATEWAY_API_KEY",
        },
      }),
    ).toEqual({
      backend: {
        kind: "openai-compatible",
        baseUrl: "https://gateway.example/v1",
        apiKeyEnv: "GATEWAY_API_KEY",
      },
    });
  });

  it("rejects an openai-compatible backend without baseUrl", () => {
    expect(() => decodeRequest({ backend: { kind: "openai-compatible" } })).toThrow();
  });

  it("decodes a successful probe result with model count", () => {
    expect(
      decodeResult({ ok: true, modelCount: 3, checkedAt: "2026-09-13T00:00:00.000Z" }),
    ).toEqual({ ok: true, modelCount: 3, checkedAt: "2026-09-13T00:00:00.000Z" });
  });

  it("decodes a failed probe result with a short error", () => {
    expect(
      decodeResult({
        ok: false,
        error: "request failed with status 500",
        checkedAt: "2026-09-13T00:00:00.000Z",
      }),
    ).toEqual({
      ok: false,
      error: "request failed with status 500",
      checkedAt: "2026-09-13T00:00:00.000Z",
    });
  });
});

describe("resolveEnvironmentMachineKind", () => {
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
  const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
  const descriptor = (platform: Record<string, unknown>) =>
    decodeDescriptor({
      environmentId: "env-1",
      label: "Box",
      platform: { os: "linux", arch: "x64", ...platform },
      serverVersion: "1.0.0",
      capabilities: {},
    });

  it("prefers the user's pick over what the server detected", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({ environmentIcon: "laptop" }),
      }),
    ).toBe("laptop");
  });

  it("uses detection when nothing is picked", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({}),
      }),
    ).toBe("mac-mini");
  });

  it("falls back to a server for older servers and before connect", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({}),
        settings: decodeSettings({}),
      }),
    ).toBe("server");
    expect(resolveEnvironmentMachineKind(null)).toBe("server");
  });

  it("drops a machine kind this build does not know instead of failing the descriptor", () => {
    const parsed = descriptor({ machine: "toaster" });

    expect(parsed.platform.machine).toBeUndefined();
    expect(
      resolveEnvironmentMachineKind({ environment: parsed, settings: decodeSettings({}) }),
    ).toBe("server");
  });
});
