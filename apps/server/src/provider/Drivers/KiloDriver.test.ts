import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { KiloSettings, ProviderDriverKind } from "@t3tools/contracts";

import { KILO_BACKEND_PROVIDER_ID, KiloDriver, resolveKiloBackendWiring } from "./KiloDriver.ts";

const decodeKiloSettings = Schema.decodeSync(KiloSettings);
const decodeKiloDriverConfig = Schema.decodeSync(KiloDriver.configSchema);

describe("Kilo driver registration", () => {
  it("registers the kilo driver kind with multi-instance support", () => {
    expect(KiloDriver.driverKind).toEqual(ProviderDriverKind.make("kilo"));
    expect(KiloDriver.metadata.displayName).toBe("Kilo");
    expect(KiloDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("decodes an empty config to the disabled-by-default Kilo settings", () => {
    const config = KiloDriver.defaultConfig();
    expect(config).toEqual(decodeKiloSettings({}));
    expect(config.enabled).toBe(false);
    expect(config.binaryPath).toBe("kilo");
  });

  it("round-trips driver config through the registered schema", () => {
    const decoded = decodeKiloDriverConfig({
      enabled: true,
      binaryPath: "/opt/bin/kilo",
    });
    expect(decoded.binaryPath).toBe("/opt/bin/kilo");
    expect(decoded.enabled).toBe(true);
  });
});

describe("resolveKiloBackendWiring", () => {
  it("uses router route keys for a t3-router backend", () => {
    const wiring = resolveKiloBackendWiring({
      backend: { kind: "t3-router", baseUrl: "http://127.0.0.1:3773/openai" },
      routeKeys: ["gpt-5.6-luna"],
      instanceEnv: {},
      baseEnv: {},
    });
    expect(wiring.backendModelSlugs).toEqual(["gpt-5.6-luna"]);
    expect(wiring.backendCustomModels).toEqual([`${KILO_BACKEND_PROVIDER_ID}/gpt-5.6-luna`]);
    expect(wiring.processEnv.OPENAI_BASE_URL).toBe("http://127.0.0.1:3773/openai");
    const raw = wiring.processEnv.KILO_CONFIG_CONTENT;
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw ?? "{}") as {
      provider: Record<string, { npm: string; options: { baseURL: string } }>;
    };
    expect(parsed.provider["t3-backend"]?.npm).toBe("@ai-sdk/openai-compatible");
    expect(parsed.provider["t3-backend"]?.options.baseURL).toBe("http://127.0.0.1:3773/openai");
  });

  it("serves static models from a direct backend and keeps existing config", () => {
    const wiring = resolveKiloBackendWiring({
      backend: {
        kind: "openai-compatible",
        baseUrl: "http://127.0.0.1:20128/v1",
        apiKey: "k",
        models: ["vendor-model"],
      },
      routeKeys: ["gpt-5.6-luna"],
      instanceEnv: { KILO_CONFIG_CONTENT: JSON.stringify({ theme: "dark" }) },
      baseEnv: {},
    });
    expect(wiring.backendCustomModels).toEqual([`${KILO_BACKEND_PROVIDER_ID}/vendor-model`]);
    const parsed = JSON.parse(wiring.processEnv.KILO_CONFIG_CONTENT ?? "{}") as {
      theme?: string;
      provider: Record<string, { options: { apiKey: string } }>;
    };
    expect(parsed.theme).toBe("dark");
    expect(parsed.provider["t3-backend"]?.options.apiKey).toBe("k");
  });

  it("stays empty without a backend", () => {
    const wiring = resolveKiloBackendWiring({
      backend: undefined,
      routeKeys: ["gpt-5.6-luna"],
      instanceEnv: { KILO_CONFIG_CONTENT: "keep" },
      baseEnv: {},
    });
    expect(wiring.backendModelSlugs).toEqual([]);
    expect(wiring.backendCustomModels).toEqual([]);
    expect(wiring.backendConfigContent).toBeUndefined();
    expect(wiring.processEnv.KILO_CONFIG_CONTENT).toBe("keep");
  });

  it("lists no custom models for anthropic-only endpoints", () => {
    const wiring = resolveKiloBackendWiring({
      backend: {
        kind: "openai-compatible",
        baseUrl: "http://x/v1",
        protocols: ["anthropic"],
        models: ["vendor-model"],
      },
      routeKeys: ["gpt-5.6-luna"],
      instanceEnv: {},
      baseEnv: {},
    });
    expect(wiring.backendCustomModels).toEqual([]);
  });
});
