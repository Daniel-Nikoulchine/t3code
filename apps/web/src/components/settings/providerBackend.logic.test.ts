import { PROVIDER_PRESET_LIST } from "@t3tools/client-runtime/state/model-provider-presets";
import {
  ModelCredentialId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addBackendConnection,
  allocateBackendConnectionId,
  applyProviderPreset,
  countConnectionReferences,
  inferBackendConnectionDriverKind,
  nextInstanceWithConnectionId,
  removeBackendConnection,
  resolveInstanceConnectionState,
  slugifyBackendConnectionId,
  toModelProxyConfig,
  toTestBackend,
  validateBackendConnectionId,
} from "./providerBackend.logic";

const baseInstance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("opencode"),
  displayName: "Proxy box",
  enabled: true,
} as ProviderInstanceConfig;

describe("nextInstanceWithConnectionId", () => {
  it("selects a connection and keeps the other fields", () => {
    const next = nextInstanceWithConnectionId(baseInstance, "main-proxy");
    expect(next.connectionId).toBe("main-proxy");
    expect(next.displayName).toBe("Proxy box");
    expect(next.enabled).toBe(true);
  });

  it("removes the field when going back to direct so the envelope stays minimal", () => {
    const selected = nextInstanceWithConnectionId(baseInstance, "main-proxy");
    expect(selected.connectionId).toBe("main-proxy");
    const cleared = nextInstanceWithConnectionId(selected, null);
    expect("connectionId" in cleared).toBe(false);
    expect(cleared.displayName).toBe("Proxy box");
  });
});

describe("resolveInstanceConnectionState", () => {
  it("reads direct when no connection is selected", () => {
    expect(resolveInstanceConnectionState(baseInstance, {})).toEqual({ kind: "direct" });
  });

  it("reads connected when the id names a map entry", () => {
    expect(
      resolveInstanceConnectionState(nextInstanceWithConnectionId(baseInstance, "main-proxy"), {
        "main-proxy": { baseUrl: "https://proxy.example/v1" },
      }),
    ).toEqual({ kind: "connected", connectionId: "main-proxy" });
  });

  it("reads orphan when the entry is gone so the card can warn", () => {
    expect(
      resolveInstanceConnectionState(nextInstanceWithConnectionId(baseInstance, "deleted"), {
        "main-proxy": { baseUrl: "https://proxy.example/v1" },
      }),
    ).toEqual({ kind: "orphan", connectionId: "deleted" });
  });

  it("reads the built-in router as connected even though it is not a settings entry", () => {
    expect(
      resolveInstanceConnectionState(nextInstanceWithConnectionId(baseInstance, "t3-router"), {}),
    ).toEqual({ kind: "connected", connectionId: "t3-router" });
  });
});

describe("slugifyBackendConnectionId", () => {
  it("slugifies preset labels to valid connection ids", () => {
    expect(slugifyBackendConnectionId("OpenAI")).toBe("openai");
    expect(slugifyBackendConnectionId("Generic gateway")).toBe("generic-gateway");
    expect(slugifyBackendConnectionId("Custom")).toBe("custom");
    expect(slugifyBackendConnectionId("LM Studio")).toBe("lm-studio");
  });

  it("enforces the letter-first slug rule with a prefix", () => {
    expect(slugifyBackendConnectionId("9lives")).toBe("connection-9lives");
    expect(slugifyBackendConnectionId("  -dash-  ")).toBe("dash");
  });

  it("falls back for empty input and caps at 64 chars", () => {
    expect(slugifyBackendConnectionId("   ")).toBe("connection");
    expect(slugifyBackendConnectionId("!@#")).toBe("connection");
    const long = slugifyBackendConnectionId("a".repeat(100));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/u);
  });
});

describe("allocateBackendConnectionId", () => {
  it("keeps a free, valid proposal untouched", () => {
    expect(allocateBackendConnectionId("main-proxy", new Set(["other"]))).toBe("main-proxy");
  });

  it("suffixes collisions with a counter", () => {
    expect(allocateBackendConnectionId("openai", new Set(["openai"]))).toBe("openai-2");
    expect(allocateBackendConnectionId("openai", new Set(["openai", "openai-2"]))).toBe("openai-3");
  });

  it("slugifies invalid proposals before allocating", () => {
    expect(allocateBackendConnectionId("Generic gateway", new Set())).toBe("generic-gateway");
    expect(allocateBackendConnectionId("   ", new Set())).toBe("connection");
    expect(allocateBackendConnectionId("   ", new Set(["connection"]))).toBe("connection-2");
  });

  it("never allocates the reserved built-in router id", () => {
    expect(allocateBackendConnectionId("t3-router", new Set())).toBe("t3-router-2");
    expect(allocateBackendConnectionId("t3-router", new Set(["t3-router-2"]))).toBe("t3-router-3");
  });

  it("never allocates the reserved harness backend bucket id", () => {
    expect(allocateBackendConnectionId("t3-backend", new Set())).toBe("t3-backend-2");
    expect(allocateBackendConnectionId("T3 Backend", new Set())).toBe("t3-backend-2");
  });

  it("keeps suffixed ids within 64 chars", () => {
    const base = "a".repeat(64);
    const allocated = allocateBackendConnectionId(base, new Set([base]));
    expect(allocated.length).toBeLessThanOrEqual(64);
    expect(allocated.endsWith("-2")).toBe(true);
  });
});

describe("validateBackendConnectionId", () => {
  it("accepts well-formed ids", () => {
    expect(validateBackendConnectionId("main-proxy")).toBeNull();
    expect(validateBackendConnectionId("OpenAI_2")).toBeNull();
  });

  it("rejects empty, overlong, and off-pattern input", () => {
    expect(validateBackendConnectionId("   ")).toContain("required");
    expect(validateBackendConnectionId("a".repeat(65))).toContain("64");
    expect(validateBackendConnectionId("1bad")).toContain("must start with a letter");
    expect(validateBackendConnectionId("has space")).toContain("must start with a letter");
  });

  it("does not reject collisions (saves suffix them)", () => {
    expect(validateBackendConnectionId("openai")).toBeNull();
  });

  it("rejects the reserved built-in router id", () => {
    expect(validateBackendConnectionId("t3-router")).toContain("reserved");
  });

  it("rejects the reserved harness backend bucket id", () => {
    expect(validateBackendConnectionId("t3-backend")).toContain("reserved");
  });
});

describe("addBackendConnection / removeBackendConnection", () => {
  it("adds one entry and leaves the others alone", () => {
    const next = addBackendConnection(
      { existing: { baseUrl: "https://proxy.example/v1", protocols: ["openai", "anthropic"] } },
      "openai",
      {
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        protocols: ["openai", "anthropic"],
      },
    );
    expect(Object.keys(next).toSorted()).toEqual(["existing", "openai"]);
    expect(next["openai"]).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      protocols: ["openai", "anthropic"],
    });
  });

  it("removes one entry and leaves the others alone", () => {
    const next = removeBackendConnection(
      {
        keep: { baseUrl: "https://proxy.example/v1", protocols: ["openai", "anthropic"] },
        drop: { baseUrl: "https://api.openai.com/v1", protocols: ["openai"] },
      },
      "drop",
    );
    expect(Object.keys(next)).toEqual(["keep"]);
  });
});

describe("countConnectionReferences", () => {
  it("counts instances selecting the connection", () => {
    const instances = {
      a: nextInstanceWithConnectionId(baseInstance, "main-proxy"),
      b: nextInstanceWithConnectionId(baseInstance, "other"),
      c: baseInstance,
    };
    expect(countConnectionReferences(instances, "main-proxy")).toBe(1);
    expect(countConnectionReferences(instances, "unused")).toBe(0);
  });

  it("reads missing maps as zero", () => {
    expect(countConnectionReferences(undefined, "main-proxy")).toBe(0);
  });
});

describe("toModelProxyConfig", () => {
  it("trims fields and drops blank optional names", () => {
    expect(
      toModelProxyConfig({
        baseUrl: "  https://proxy.example/v1  ",
        apiKeyEnv: "  OMNI_KEY  ",
        displayName: "  Omni  ",
      }),
    ).toEqual({
      baseUrl: "https://proxy.example/v1",
      apiKeyEnv: "OMNI_KEY",
      displayName: "Omni",
      protocols: ["openai", "anthropic"],
    });
    expect(
      toModelProxyConfig({
        baseUrl: "https://proxy.example/v1",
        apiKeyEnv: "   ",
        displayName: "",
      }),
    ).toEqual({
      baseUrl: "https://proxy.example/v1",
      protocols: ["openai", "anthropic"],
    });
  });

  it("defaults a draft without protocols to both and stores explicit subsets", () => {
    expect(
      toModelProxyConfig({
        baseUrl: "https://proxy.example/v1",
        apiKeyEnv: "",
        displayName: "",
        protocols: ["anthropic"],
      })?.protocols,
    ).toEqual(["anthropic"]);
    expect(
      toModelProxyConfig({
        baseUrl: "https://proxy.example/v1",
        apiKeyEnv: "",
        displayName: "",
        protocols: ["openai", "anthropic"],
      })?.protocols,
    ).toEqual(["openai", "anthropic"]);
  });

  it("carries the credential reference and trimmed model slugs", () => {
    const config = toModelProxyConfig({
      baseUrl: "https://proxy.example/v1",
      apiKeyEnv: "",
      displayName: "",
      apiKeyCredentialId: "  anthropic-work  ",
      models: ["  claude-sonnet-4  ", "claude-sonnet-4", "   "],
    });
    expect(config).toEqual({
      baseUrl: "https://proxy.example/v1",
      protocols: ["openai", "anthropic"],
      models: ["claude-sonnet-4"],
      apiKeyCredentialId: "anthropic-work",
    });
    expect(
      toModelProxyConfig({
        baseUrl: "https://proxy.example/v1",
        apiKeyEnv: "",
        displayName: "",
        models: [],
        apiKeyCredentialId: "  ",
      })?.models,
    ).toBeUndefined();
  });

  it("refuses a blank base url so the dialog never adds an invalid entry", () => {
    expect(
      toModelProxyConfig({ baseUrl: "   ", apiKeyEnv: "OMNI_KEY", displayName: "Omni" }),
    ).toBeUndefined();
  });
});

describe("toTestBackend", () => {
  it("wraps the connection entry in the probe envelope shape", () => {
    expect(
      toTestBackend({
        baseUrl: "https://proxy.example/v1",
        apiKeyEnv: "OMNI_KEY",
        protocols: ["openai", "anthropic"],
      }),
    ).toEqual({
      kind: "openai-compatible",
      baseUrl: "https://proxy.example/v1",
      apiKeyEnv: "OMNI_KEY",
      protocols: ["openai", "anthropic"],
    });
  });

  it("strips the credential reference — the probe takes it at the request level", () => {
    const backend = toTestBackend({
      baseUrl: "https://proxy.example/v1",
      protocols: ["openai"],
      apiKeyCredentialId: ModelCredentialId.make("anthropic-work"),
    });
    expect("apiKeyCredentialId" in backend).toBe(false);
    expect(backend).toEqual({
      kind: "openai-compatible",
      baseUrl: "https://proxy.example/v1",
      protocols: ["openai"],
    });
  });
});

describe("applyProviderPreset", () => {
  it("resets to blank fields for the custom slate", () => {
    const custom = PROVIDER_PRESET_LIST.find((preset) => preset.id === "custom")!;
    expect(applyProviderPreset(custom)).toEqual({ baseUrl: "", apiKeyEnv: "", displayName: "" });
  });

  it("fills url, key name, and label for a hosted preset", () => {
    const openai = PROVIDER_PRESET_LIST.find((preset) => preset.id === "openai")!;
    expect(applyProviderPreset(openai)).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      displayName: "OpenAI",
    });
  });

  it("leaves the key name blank for the custom slate", () => {
    const custom = PROVIDER_PRESET_LIST.find((preset) => preset.id === "custom")!;
    expect(applyProviderPreset(custom)).toEqual({
      baseUrl: "",
      apiKeyEnv: "",
      displayName: "",
    });
  });

  it("applies every shipped preset without undefined fields", () => {
    for (const preset of PROVIDER_PRESET_LIST) {
      const draft = applyProviderPreset(preset);
      expect(typeof draft.baseUrl).toBe("string");
      expect(typeof draft.apiKeyEnv).toBe("string");
      expect(typeof draft.displayName).toBe("string");
    }
  });
});

describe("inferBackendConnectionDriverKind", () => {
  it("maps OpenCode Go endpoints to the opencode brand icon", () => {
    expect(
      String(
        inferBackendConnectionDriverKind({
          connectionId: "opencode-go",
          connection: {
            baseUrl: "https://opencode.ai/zen/go/v1",
            displayName: "OpenCode Go",
          },
          credentialVendor: "opencode-go",
        }),
      ),
    ).toBe("opencode");
  });

  it("maps the Codex OAuth endpoint to the codex brand icon", () => {
    expect(
      String(
        inferBackendConnectionDriverKind({
          connectionId: "codex-oauth",
          connection: {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            displayName: "ChatGPT account (Codex OAuth)",
            codexAccountInstanceId: "codex",
          },
        }),
      ),
    ).toBe("codex");
  });

  it("maps chatgpt/codex names without an OAuth link to codex", () => {
    expect(
      String(
        inferBackendConnectionDriverKind({
          connectionId: "chatgpt",
          connection: {
            baseUrl: "https://chatgpt.com/backend-api/codex",
            displayName: "ChatGPT account",
          },
        }),
      ),
    ).toBe("codex");
  });

  it("maps freebuff and codebuff connection names to freebuff", () => {
    expect(
      String(
        inferBackendConnectionDriverKind({
          connectionId: "freebuff",
          connection: {
            baseUrl: "https://www.codebuff.com/api",
            displayName: "Freebuff",
          },
        }),
      ),
    ).toBe("freebuff");
    expect(
      String(
        inferBackendConnectionDriverKind({
          connectionId: "codebuff",
          connection: {
            baseUrl: "https://www.codebuff.com/api",
            displayName: "Codebuff",
          },
        }),
      ),
    ).toBe("freebuff");
  });

  it("keeps genuinely custom endpoints on the initials fallback", () => {
    expect(
      inferBackendConnectionDriverKind({
        connectionId: "proxy",
        connection: { baseUrl: "https://proxy.example/v1", displayName: "Proxy" },
      }),
    ).toBeNull();
  });
});
