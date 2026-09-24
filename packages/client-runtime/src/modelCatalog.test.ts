import {
  ModelBackendConnectionId,
  ModelCredentialId,
  ModelVendor,
  ProviderDriverKind,
  ProviderInstanceId,
  T3_ROUTER_CONNECTION_ID,
  type ModelBackendConnections,
  type ModelRouterRoute,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MODEL_BINDING_BY_DRIVER,
  authModeFromAuth,
  deriveModelCatalog,
  routeSubProvider,
  vendorForDriver,
} from "./modelCatalog.ts";

const model = (slug: string, name = slug, subProvider?: string): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
  ...(subProvider ? { subProvider } : {}),
});

const provider = (overrides: {
  instanceId: string;
  driver: string;
  models?: ServerProviderModel[];
  enabled?: boolean;
  installed?: boolean;
  status?: ServerProvider["status"];
  auth?: ServerProvider["auth"];
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(overrides.instanceId),
  driver: ProviderDriverKind.make(overrides.driver),
  enabled: overrides.enabled ?? true,
  installed: overrides.installed ?? true,
  version: "1.0.0",
  status: overrides.status ?? "ready",
  auth: overrides.auth ?? { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: overrides.models ?? [],
  slashCommands: [],
  skills: [],
});

const glmRelay: ModelBackendConnections = {
  [ModelBackendConnectionId.make("glm-relay")]: {
    baseUrl: "https://relay.example/v1",
    protocols: ["openai", "anthropic"],
    models: ["glm-4.7", "kimi-k2"],
  },
};

const linked = (instanceId: string, connectionId: string) => ({
  [ProviderInstanceId.make(instanceId)]: ModelBackendConnectionId.make(connectionId),
});

describe("deriveModelCatalog router routes", () => {
  it("carries the native model's subProvider onto its source", () => {
    const catalog = deriveModelCatalog({
      providers: [
        provider({
          instanceId: "minimax",
          driver: "minimax",
          models: [model("deepseek-v4-flash", "deepseek-v4-flash", "t3-backend/opencode-go")],
        }),
      ],
      connections: {},
    });

    expect(catalog[0]?.sources).toEqual([
      {
        instanceId: "minimax",
        model: "deepseek-v4-flash",
        via: "native",
        authMode: "unknown",
        name: "deepseek-v4-flash",
        subProvider: "t3-backend/opencode-go",
      },
    ]);
  });

  it("marks harness-bucket models unknown instead of inheriting subscription auth", () => {
    const catalog = deriveModelCatalog({
      providers: [
        provider({
          instanceId: "pi",
          driver: "pi",
          auth: { status: "authenticated", type: "subscription" },
          models: [model("t3-backend/probe-go", "probe-go"), model("pi-native", "Pi Native")],
        }),
      ],
      connections: {},
    });

    const bucket = catalog.find((entry) => entry.modelId === "t3-backend/probe-go");
    expect(bucket?.sources).toEqual([
      {
        instanceId: "pi",
        model: "t3-backend/probe-go",
        via: "native",
        authMode: "unknown",
        name: "probe-go",
      },
    ]);
    const native = catalog.find((entry) => entry.modelId === "pi-native");
    expect(native?.sources[0]?.authMode).toBe("subscription");
  });

  it("serves route slugs on t3-router-linked instances with capable drivers", () => {
    const catalog = deriveModelCatalog({
      providers: [
        provider({ instanceId: "codex", driver: "codex", models: [model("gpt-5.5", "GPT 5.5")] }),
        provider({
          instanceId: "deepseek",
          driver: "deepseek",
          models: [model("deepseek-v4-flash", "DeepSeek V4 Flash")],
        }),
      ],
      connections: {},
      instanceConnections: {
        ...linked("codex", "t3-router"),
        ...linked("deepseek", "t3-router"),
      },
      routes: ["gpt-5.6-luna"],
    });

    const luna = catalog.find((entry) => entry.modelId === "gpt-5.6-luna");
    expect(luna?.sources).toEqual([
      { instanceId: "codex", model: "gpt-5.6-luna", via: "connection", authMode: "unknown" },
      { instanceId: "deepseek", model: "gpt-5.6-luna", via: "connection", authMode: "unknown" },
    ]);
    expect(luna?.gaps).toEqual([]);
  });

  it("stamps routeSubProviders onto router sources", () => {
    const catalog = deriveModelCatalog({
      providers: [
        provider({ instanceId: "deepseek", driver: "deepseek", models: [model("deepseek-v4")] }),
      ],
      connections: {},
      instanceConnections: { ...linked("deepseek", "t3-router") },
      routes: ["gpt-5.6-luna", "opencode-go/deepseek-v4-flash"],
      routeSubProviders: {
        "gpt-5.6-luna": "openai-oauth",
        "opencode-go/deepseek-v4-flash": "opencode-go",
      },
    });

    expect(catalog.find((entry) => entry.modelId === "gpt-5.6-luna")?.sources[0]).toMatchObject({
      subProvider: "openai-oauth",
    });
    expect(
      catalog.find((entry) => entry.modelId === "opencode-go/deepseek-v4-flash")?.sources[0],
    ).toMatchObject({ subProvider: "opencode-go" });
  });
});

describe("deriveModelCatalog", () => {
  it("groups one slug served by two instances and a connection into a single logical model", () => {
    const catalog = deriveModelCatalog({
      providers: [
        provider({
          instanceId: "opencode",
          driver: "opencode",
          auth: { status: "authenticated", type: "api_key" },
          models: [model("glm-4.7", "GLM 4.7"), model("kimi-k2", "Kimi K2")],
        }),
        provider({
          instanceId: "pi",
          driver: "pi",
          models: [model("glm-4.7", "GLM 4.7")],
        }),
        provider({
          instanceId: "claude",
          driver: "claudeAgent",
          auth: { status: "authenticated", type: "oauth-personal" },
          models: [model("claude-sonnet-4-6", "Claude Sonnet 4.6")],
        }),
      ],
      connections: glmRelay,
      instanceConnections: {
        ...linked("claude", "glm-relay"),
        ...linked("opencode", "glm-relay"),
      },
    });

    expect(catalog.map((entry) => entry.modelId)).toEqual([
      "claude-sonnet-4-6",
      "glm-4.7",
      "kimi-k2",
    ]);

    const glm = catalog[1];
    expect(glm).toEqual({
      modelId: "glm-4.7",
      displayName: "GLM 4.7",
      vendor: undefined,
      sources: [
        {
          instanceId: "claude",
          model: "glm-4.7",
          via: "connection",
          authMode: "api-key",
          subProvider: "glm-relay",
        },
        {
          instanceId: "opencode",
          model: "glm-4.7",
          via: "native",
          authMode: "api-key",
          name: "GLM 4.7",
        },
        {
          instanceId: "opencode",
          model: "glm-4.7",
          via: "connection",
          authMode: "api-key",
          subProvider: "glm-relay",
        },
        { instanceId: "pi", model: "glm-4.7", via: "native", authMode: "unknown", name: "GLM 4.7" },
      ],
      gaps: [],
    });

    const sonnet = catalog[0];
    expect(sonnet).toEqual({
      modelId: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      vendor: "anthropic",
      sources: [
        {
          instanceId: "claude",
          model: "claude-sonnet-4-6",
          via: "native",
          authMode: "subscription",
          name: "Claude Sonnet 4.6",
        },
      ],
      gaps: [
        { instanceId: "opencode", reason: "requires-api-key" },
        { instanceId: "pi", reason: "requires-api-key" },
      ],
    });
  });

  it("classifies non-serving instances as vendor-locked or requires-api-key", () => {
    const catalog = deriveModelCatalog({
      providers: [
        provider({
          instanceId: "codex",
          driver: "codex",
          auth: { status: "authenticated", type: "apiKey" },
          models: [model("gpt-5.2", "GPT 5.2")],
        }),
        provider({ instanceId: "opencode", driver: "opencode", models: [model("kimi-k2")] }),
        provider({ instanceId: "cursor", driver: "cursor", models: [model("composer-1")] }),
        // Unknown driver kinds default to the conservative binding.
        provider({ instanceId: "ollama", driver: "ollama", models: [model("llama3")] }),
      ],
      connections: {},
    });

    expect(catalog).toEqual([
      {
        modelId: "composer-1",
        displayName: "composer-1",
        vendor: undefined,
        sources: [
          {
            instanceId: "cursor",
            model: "composer-1",
            via: "native",
            authMode: "unknown",
            name: "composer-1",
          },
        ],
        gaps: [
          { instanceId: "codex", reason: "requires-api-key" },
          { instanceId: "ollama", reason: "vendor-locked" },
          { instanceId: "opencode", reason: "requires-api-key" },
        ],
      },
      {
        modelId: "gpt-5.2",
        displayName: "GPT 5.2",
        vendor: "openai",
        sources: [
          {
            instanceId: "codex",
            model: "gpt-5.2",
            via: "native",
            authMode: "api-key",
            name: "GPT 5.2",
          },
        ],
        gaps: [
          { instanceId: "cursor", reason: "vendor-locked" },
          { instanceId: "ollama", reason: "vendor-locked" },
          { instanceId: "opencode", reason: "requires-api-key" },
        ],
      },
      {
        modelId: "kimi-k2",
        displayName: "kimi-k2",
        vendor: undefined,
        sources: [
          {
            instanceId: "opencode",
            model: "kimi-k2",
            via: "native",
            authMode: "unknown",
            name: "kimi-k2",
          },
        ],
        gaps: [
          { instanceId: "codex", reason: "requires-api-key" },
          { instanceId: "cursor", reason: "vendor-locked" },
          { instanceId: "ollama", reason: "vendor-locked" },
        ],
      },
      {
        modelId: "llama3",
        displayName: "llama3",
        vendor: undefined,
        sources: [
          {
            instanceId: "ollama",
            model: "llama3",
            via: "native",
            authMode: "unknown",
            name: "llama3",
          },
        ],
        gaps: [
          { instanceId: "codex", reason: "requires-api-key" },
          { instanceId: "cursor", reason: "vendor-locked" },
          { instanceId: "opencode", reason: "requires-api-key" },
        ],
      },
    ]);
  });

  it("ignores disabled, uninstalled, and switched-off instances as sources and gaps", () => {
    const catalog = deriveModelCatalog({
      providers: [
        provider({
          instanceId: "codex",
          driver: "codex",
          status: "disabled",
          models: [model("gpt-5.2")],
        }),
        provider({ instanceId: "pi", driver: "pi", installed: false, models: [model("glm-4.7")] }),
        provider({
          instanceId: "cursor",
          driver: "cursor",
          enabled: false,
          models: [model("composer-1")],
        }),
        provider({ instanceId: "opencode", driver: "opencode", models: [model("kimi-k2")] }),
      ],
      connections: {},
    });

    expect(catalog).toEqual([
      {
        modelId: "kimi-k2",
        displayName: "kimi-k2",
        vendor: undefined,
        sources: [
          {
            instanceId: "opencode",
            model: "kimi-k2",
            via: "native",
            authMode: "unknown",
            name: "kimi-k2",
          },
        ],
        gaps: [],
      },
    ]);
  });

  it("turns connection models into sources only through the settings link", () => {
    const opencode = provider({ instanceId: "opencode", driver: "opencode" });

    // No link, and a link to a deleted connection (orphan) both yield nothing.
    expect(deriveModelCatalog({ providers: [opencode], connections: glmRelay })).toEqual([]);
    expect(
      deriveModelCatalog({
        providers: [opencode],
        connections: glmRelay,
        instanceConnections: linked("opencode", "ghost-relay"),
      }),
    ).toEqual([]);

    const catalog = deriveModelCatalog({
      providers: [opencode],
      connections: glmRelay,
      instanceConnections: linked("opencode", "glm-relay"),
    });

    expect(catalog).toEqual([
      {
        modelId: "glm-4.7",
        // Connection-only pairings have no snapshot name; the slug stands in.
        displayName: "glm-4.7",
        vendor: undefined,
        sources: [
          {
            instanceId: "opencode",
            model: "glm-4.7",
            via: "connection",
            authMode: "api-key",
            subProvider: "glm-relay",
          },
        ],
        gaps: [],
      },
      {
        modelId: "kimi-k2",
        displayName: "kimi-k2",
        vendor: undefined,
        sources: [
          {
            instanceId: "opencode",
            model: "kimi-k2",
            via: "connection",
            authMode: "api-key",
            subProvider: "glm-relay",
          },
        ],
        gaps: [],
      },
    ]);
  });

  it("returns a deterministic catalog regardless of input order", () => {
    const providers = [
      provider({ instanceId: "codex", driver: "codex", models: [model("gpt-5.2")] }),
      provider({ instanceId: "pi", driver: "pi", models: [model("glm-4.7")] }),
      provider({
        instanceId: "claude",
        driver: "claudeAgent",
        models: [model("claude-sonnet-4-6")],
      }),
    ];

    const first = deriveModelCatalog({ providers, connections: glmRelay });
    const second = deriveModelCatalog({ providers, connections: glmRelay });
    expect(second).toEqual(first);

    const reversed = deriveModelCatalog({
      providers: providers.toReversed(),
      connections: glmRelay,
    });
    expect(reversed.map((entry) => entry.modelId)).toEqual(
      reversed.map((entry) => entry.modelId).sort(),
    );
    for (const entry of reversed) {
      expect(entry.sources.map((source) => source.instanceId)).toEqual(
        entry.sources.map((source) => source.instanceId).sort(),
      );
      expect(entry.gaps.map((gap) => gap.instanceId)).toEqual(
        entry.gaps.map((gap) => gap.instanceId).sort(),
      );
    }
  });

  it("returns an empty catalog for empty input", () => {
    expect(deriveModelCatalog({ providers: [], connections: {} })).toEqual([]);
  });
});

describe("routeSubProvider", () => {
  it("labels connection and vendor targets, never the reserved router", () => {
    expect(
      routeSubProvider({
        target: { kind: "connection", connectionId: ModelBackendConnectionId.make("openai-oauth") },
      } satisfies ModelRouterRoute),
    ).toBe("openai-oauth");
    expect(
      routeSubProvider({
        target: { kind: "connection", connectionId: T3_ROUTER_CONNECTION_ID },
      } satisfies ModelRouterRoute),
    ).toBeUndefined();
    expect(
      routeSubProvider({
        target: {
          kind: "vendor",
          vendor: ModelVendor.make("openai"),
          credentialId: ModelCredentialId.make("cred-1"),
        },
      } satisfies ModelRouterRoute),
    ).toBe("openai");
  });

  it("never labels the harness backend bucket, even on legacy routes", () => {
    expect(
      routeSubProvider({
        target: { kind: "connection", connectionId: ModelBackendConnectionId.make("t3-backend") },
      } satisfies ModelRouterRoute),
    ).toBeUndefined();
  });
});

describe("authModeFromAuth", () => {
  it("maps absent and API-key spellings distinctly from subscription labels", () => {
    expect(authModeFromAuth(undefined)).toBe("unknown");
    expect(authModeFromAuth({})).toBe("unknown");
    expect(authModeFromAuth({ type: "apiKey" })).toBe("api-key");
    expect(authModeFromAuth({ type: "api_key" })).toBe("api-key");
    expect(authModeFromAuth({ type: "chatgpt" })).toBe("subscription");
    expect(authModeFromAuth({ type: "cached_token" })).toBe("subscription");
    expect(authModeFromAuth({ type: "oauth-personal" })).toBe("subscription");
    expect(authModeFromAuth({ type: "claude-pro" })).toBe("subscription");
  });
});

describe("vendorForDriver", () => {
  it("maps single-vendor harnesses to their vendor", () => {
    expect(vendorForDriver("codex")).toBe("openai");
    expect(vendorForDriver("claudeAgent")).toBe("anthropic");
    expect(vendorForDriver("grok")).toBe("xai");
    expect(vendorForDriver("deepseek")).toBe("deepseek");
    expect(vendorForDriver("antigravity")).toBe("google");
    expect(vendorForDriver("zcode")).toBe("zai");
  });

  it("leaves multi-vendor and unknown drivers without a vendor", () => {
    for (const driver of [
      "opencode",
      "pi",
      "omp",
      "hermes",
      "cursor",
      "copilot",
      "droid",
      "devin",
      "kilo",
      "cline",
      "openclaw",
    ]) {
      expect(vendorForDriver(driver)).toBeUndefined();
    }
    expect(vendorForDriver("ollama")).toBeUndefined();
  });
});

describe("MODEL_BINDING_BY_DRIVER", () => {
  it("carries the curated driver bindings", () => {
    expect(MODEL_BINDING_BY_DRIVER).toEqual({
      claudeAgent: "endpoint-anthropic",
      codex: "endpoint-openai",
      deepseek: "endpoint-openai",
      opencode: "multi-provider",
      pi: "multi-provider",
      omp: "multi-provider",
      hermes: "multi-provider",
      openclaw: "multi-provider",
      cline: "multi-provider",
      kilo: "multi-provider",
      cursor: "vendor-locked",
      copilot: "endpoint-openai",
      droid: "vendor-locked",
      devin: "vendor-locked",
      grok: "endpoint-openai",
      minimax: "multi-provider",
      freebuff: "vendor-locked",
      zcode: "vendor-locked",
      antigravity: "vendor-locked",
    });
  });
});
