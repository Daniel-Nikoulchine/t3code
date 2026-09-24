import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MODEL_CREDENTIAL_VALUE_REDACTED,
  type ModelBackendConnectionId,
  ModelBackendConnections,
  ModelCredentials,
  ModelRouterRoutes,
  T3_ROUTER_CONNECTION_ID,
} from "@t3tools/contracts";

import type { ServerSettings } from "@t3tools/contracts";
import { deriveRegistryConnections } from "../Layers/ProviderInstanceRegistryHydration.ts";
import {
  MODEL_ROUTER_PORT_BASE,
  MODEL_ROUTER_PORT_SPAN,
  deriveModelRouterPort,
} from "./modelRouterPort.ts";
import {
  resolveModelRoute,
  resolveOpencodeGoSessionHeader,
  routedModelIds,
  vendorProtocol,
  type ModelRouterSnapshot,
} from "./modelRouterRouting.ts";

const decodeRoutes = Schema.decodeUnknownSync(ModelRouterRoutes);
const decodeConnections = Schema.decodeUnknownSync(ModelBackendConnections);
const decodeCredentials = Schema.decodeUnknownSync(ModelCredentials);

const makeSnapshot = (input: {
  routes: unknown;
  connections?: unknown;
  credentials?: unknown;
  codexAccounts?: ModelRouterSnapshot["codexAccounts"];
}): ModelRouterSnapshot => ({
  routes: decodeRoutes(input.routes),
  connections: decodeConnections(input.connections ?? {}),
  credentials: decodeCredentials(input.credentials ?? {}),
  codexAccounts: input.codexAccounts ?? {},
});

describe("resolveModelRoute", () => {
  it("resolves a Codex OAuth account route keyless, whatever credentials say", () => {
    const snapshot = makeSnapshot({
      routes: { "gpt-5.6-luna": { target: { kind: "connection", connectionId: "openai-oauth" } } },
      connections: {
        "openai-oauth": {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountInstanceId: "codex",
          apiKeyEnv: "IGNORED",
        },
      },
      codexAccounts: { codex: { binaryPath: "codex" } },
    });
    const resolved = resolveModelRoute(snapshot, "gpt-5.6-luna", "openai", {
      IGNORED: "sk-should-not-leak",
    } as NodeJS.ProcessEnv);
    expect(resolved._tag).toBe("Found");
    if (resolved._tag === "Found") {
      expect(resolved.upstream).toEqual({
        kind: "codex-oauth",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiKey: undefined,
        codexAccountInstanceId: "codex",
        protocol: "openai",
        upstreamModel: "gpt-5.6-luna",
        responsesUpstream: true,
      });
    }
  });

  it("leaves a Codex OAuth route unresolved when the account instance is gone", () => {
    const snapshot = makeSnapshot({
      routes: { "gpt-5.6-luna": { target: { kind: "connection", connectionId: "openai-oauth" } } },
      connections: {
        "openai-oauth": {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          codexAccountInstanceId: "ghost",
        },
      },
      codexAccounts: { codex: { binaryPath: "codex" } },
    });
    expect(resolveModelRoute(snapshot, "gpt-5.6-luna", "openai")._tag).toBe("UnresolvedTarget");
  });

  it("resolves a connection target with a credential key", () => {
    const snapshot = makeSnapshot({
      routes: { "gpt-x": { target: { kind: "connection", connectionId: "main" } } },
      connections: { main: { baseUrl: "http://127.0.0.1:9001/v1", apiKeyCredentialId: "cred" } },
      credentials: { cred: { displayName: "Key", vendor: "openai", value: "sk-live-1" } },
    });
    const resolved = resolveModelRoute(snapshot, "gpt-x", "openai");
    expect(resolved._tag).toBe("Found");
    if (resolved._tag === "Found") {
      expect(resolved.upstream).toEqual({
        kind: "connection",
        baseUrl: "http://127.0.0.1:9001/v1",
        apiKey: "sk-live-1",
        protocol: "openai",
        upstreamModel: "gpt-x",
        responsesUpstream: false,
      });
    }
  });

  it("falls back to apiKeyEnv when the connection has no credential", () => {
    const snapshot = makeSnapshot({
      routes: { m: { target: { kind: "connection", connectionId: "main" } } },
      connections: { main: { baseUrl: "http://gw/v1", apiKeyEnv: "MY_GATEWAY_KEY" } },
    });
    const resolved = resolveModelRoute(snapshot, "m", "openai", {
      MY_GATEWAY_KEY: "env-key-9",
    } as NodeJS.ProcessEnv);
    expect(resolved._tag === "Found" && resolved.upstream.apiKey).toBe("env-key-9");
  });

  it("never treats the redaction sentinel as a key and falls through to env", () => {
    const snapshot = makeSnapshot({
      routes: { m: { target: { kind: "connection", connectionId: "main" } } },
      connections: {
        main: { baseUrl: "http://gw/v1", apiKeyCredentialId: "cred", apiKeyEnv: "FALLBACK" },
      },
      credentials: {
        cred: { displayName: "Key", vendor: "openai", value: MODEL_CREDENTIAL_VALUE_REDACTED },
      },
    });
    const resolved = resolveModelRoute(snapshot, "m", "openai", {
      FALLBACK: "real-env-key",
    } as NodeJS.ProcessEnv);
    expect(resolved._tag === "Found" && resolved.upstream.apiKey).toBe("real-env-key");

    // Without an env fallback there is simply no key — never bullet characters.
    const keyless = resolveModelRoute(snapshot, "m", "openai", {});
    expect(keyless._tag === "Found" && keyless.upstream.apiKey).toBe(undefined);
  });

  it("resolves a vendor target against its preset baseUrl", () => {
    const snapshot = makeSnapshot({
      routes: { m: { target: { kind: "vendor", vendor: "deepseek", credentialId: "cred" } } },
      credentials: { cred: { displayName: "K", vendor: "deepseek", value: "sk-ds" } },
    });
    const resolved = resolveModelRoute(snapshot, "m", "openai");
    expect(resolved._tag === "Found" && resolved.upstream).toEqual({
      kind: "vendor",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-ds",
      protocol: "openai",
      upstreamModel: "m",
      responsesUpstream: false,
    });
  });

  it("honors a vendor baseUrl override and the anthropic vendor protocol", () => {
    const snapshot = makeSnapshot({
      routes: { m: { target: { kind: "vendor", vendor: "anthropic", credentialId: "cred" } } },
      credentials: { cred: { displayName: "K", vendor: "anthropic", value: "sk-ant" } },
    });
    const resolved = resolveModelRoute(snapshot, "m", "anthropic");
    expect(
      resolved._tag === "Found" &&
        resolved.upstream.baseUrl === "https://api.anthropic.com/v1" &&
        resolved.upstream.protocol === "anthropic",
    ).toBe(true);
  });

  it("marks a vendor without preset or baseUrl as unresolved", () => {
    const snapshot = makeSnapshot({
      routes: { m: { target: { kind: "vendor", vendor: "selfhosted", credentialId: "cred" } } },
      credentials: { cred: { displayName: "K", vendor: "selfhosted", value: "sk" } },
    });
    expect(resolveModelRoute(snapshot, "m", "openai")._tag).toBe("UnresolvedTarget");
  });

  it("marks an orphaned connection as unresolved", () => {
    const snapshot = makeSnapshot({
      routes: { m: { target: { kind: "connection", connectionId: "deleted" } } },
    });
    expect(resolveModelRoute(snapshot, "m", "openai")._tag).toBe("UnresolvedTarget");
  });

  it("returns UnknownModel for unrouted slugs", () => {
    expect(resolveModelRoute(makeSnapshot({ routes: {} }), "nope", "openai")._tag).toBe(
      "UnknownModel",
    );
  });

  it("applies the upstreamModel override over the route key", () => {
    const snapshot = makeSnapshot({
      routes: {
        fast: {
          target: { kind: "vendor", vendor: "openai", credentialId: "cred" },
          upstreamModel: "gpt-5.2-mini",
        },
      },
      credentials: { cred: { displayName: "K", vendor: "openai", value: "sk" } },
    });
    const resolved = resolveModelRoute(snapshot, "fast", "openai");
    expect(resolved._tag === "Found" && resolved.upstream.upstreamModel).toBe("gpt-5.2-mini");
  });

  it("carries the upstreamResponses flag, defaulting to false", () => {
    const snapshot = makeSnapshot({
      routes: {
        chatty: { target: { kind: "connection", connectionId: "main" } },
        talky: {
          target: { kind: "connection", connectionId: "main" },
          upstreamResponses: true,
        },
      },
      connections: { main: { baseUrl: "http://127.0.0.1:9001/v1" } },
    });
    const plain = resolveModelRoute(snapshot, "chatty", "openai");
    expect(plain._tag === "Found" && plain.upstream.responsesUpstream).toBe(false);
    const forced = resolveModelRoute(snapshot, "talky", "openai");
    expect(forced._tag === "Found" && forced.upstream.responsesUpstream).toBe(true);
  });

  it("translates only when the connection declares just the other protocol", () => {
    const routes = {
      m: { target: { kind: "connection", connectionId: "main" } },
    } as const;
    const anthropicInbound = resolveModelRoute(
      makeSnapshot({
        routes,
        connections: { main: { baseUrl: "http://gw/anthropic", protocols: ["anthropic"] } },
      }),
      "m",
      "anthropic",
    );
    expect(anthropicInbound._tag === "Found" && anthropicInbound.upstream.protocol).toBe(
      "anthropic",
    );

    const openaiOnly = resolveModelRoute(
      makeSnapshot({
        routes,
        connections: { main: { baseUrl: "http://gw/v1", protocols: ["openai"] } },
      }),
      "m",
      "anthropic",
    );
    expect(openaiOnly._tag === "Found" && openaiOnly.upstream.protocol).toBe("openai");
  });
});

describe("vendorProtocol", () => {
  it("maps only anthropic to the anthropic protocol", () => {
    expect(vendorProtocol("anthropic")).toBe("anthropic");
    expect(vendorProtocol("openai")).toBe("openai");
    expect(vendorProtocol("glm")).toBe("openai");
  });
});

describe("routedModelIds", () => {
  it("unions route keys with referenced connection models, sorted and deduped", () => {
    const snapshot = makeSnapshot({
      routes: {
        b: { target: { kind: "connection", connectionId: "main" } },
        a: { target: { kind: "vendor", vendor: "openai", credentialId: "cred" } },
      },
      connections: {
        main: { baseUrl: "http://gw/v1", models: ["z-slug", "a", "z-slug"] },
        unused: { baseUrl: "http://other/v1", models: ["never-listed"] },
      },
      credentials: { cred: { displayName: "K", vendor: "openai", value: "sk" } },
    });
    expect(routedModelIds(snapshot)).toEqual(["a", "b", "z-slug"]);
  });
});

describe("deriveModelRouterPort", () => {
  it("is deterministic per base dir and stays inside the dedicated band", () => {
    const port = deriveModelRouterPort("/home/dev/project/.t3");
    expect(port).toBe(deriveModelRouterPort("/home/dev/project/.t3"));
    expect(port).toBeGreaterThan(MODEL_ROUTER_PORT_BASE);
    expect(port).toBeLessThanOrEqual(MODEL_ROUTER_PORT_BASE + MODEL_ROUTER_PORT_SPAN);
    expect(deriveModelRouterPort("/other/project/.t3")).not.toBe(
      deriveModelRouterPort("/home/dev/project/.t3"),
    );
  });
});

describe("deriveRegistryConnections", () => {
  const baseSettings = {
    modelBackendConnections: decodeConnections({
      mine: { baseUrl: "http://mine/v1" },
    }),
  } as ServerSettings;

  it("injects the synthesized t3-router connection while the router is up", () => {
    const connections = deriveRegistryConnections(baseSettings, "http://127.0.0.1:21774");
    expect(connections[T3_ROUTER_CONNECTION_ID]).toEqual({
      baseUrl: "http://127.0.0.1:21774/openai",
      protocols: ["openai", "anthropic"],
      displayName: "T3 Router",
    });
    expect(connections["mine" as ModelBackendConnectionId]?.baseUrl).toBe("http://mine/v1");
  });

  it("leaves the map untouched when the router is disabled", () => {
    const connections = deriveRegistryConnections(baseSettings, undefined);
    expect(T3_ROUTER_CONNECTION_ID in connections).toBe(false);
  });

  it("does not stomp a user-owned t3-router connection", () => {
    const settings = {
      modelBackendConnections: decodeConnections({
        [T3_ROUTER_CONNECTION_ID]: { baseUrl: "http://mine-actually/v1" },
      }),
    } as ServerSettings;
    const connections = deriveRegistryConnections(settings, "http://127.0.0.1:21774");
    expect(connections[T3_ROUTER_CONNECTION_ID]?.baseUrl).toBe("http://mine-actually/v1");
  });
});

describe("resolveOpencodeGoSessionHeader", () => {
  const GO = "https://opencode.ai/zen/go/v1";
  it("passes a harness-supplied session id through on go targets", () => {
    expect(
      resolveOpencodeGoSessionHeader({
        baseUrl: GO,
        routeKey: "opencode-go/kimi-k3",
        inboundSessionId: "sess-1",
      }),
    ).toBe("sess-1");
  });
  it("falls back to a stable per-route id without one", () => {
    expect(
      resolveOpencodeGoSessionHeader({
        baseUrl: GO,
        routeKey: "opencode-go/kimi-k3",
        inboundSessionId: undefined,
      }),
    ).toBe("t3-router-opencode-go/kimi-k3");
    expect(
      resolveOpencodeGoSessionHeader({ baseUrl: GO, routeKey: "x", inboundSessionId: "" }),
    ).toBe("t3-router-x");
  });
  it("stays absent for any other upstream", () => {
    expect(
      resolveOpencodeGoSessionHeader({
        baseUrl: "https://api.openai.com/v1",
        routeKey: "x",
        inboundSessionId: "sess-1",
      }),
    ).toBeUndefined();
  });
});
