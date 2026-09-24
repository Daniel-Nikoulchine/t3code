// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, T3_ROUTER_CONNECTION_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ModelBackendConfig } from "@t3tools/contracts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { GrokDriver, resolveGrokRoutedModelEntries } from "./GrokDriver.ts";

const routerBackend = (overrides: Partial<ModelBackendConfig> = {}): ModelBackendConfig => ({
  kind: "t3-router",
  baseUrl: "http://127.0.0.1:3773/openai",
  protocols: ["openai", "anthropic"],
  ...overrides,
});

describe("resolveGrokRoutedModelEntries", () => {
  it("maps every route key at the router's chat surface with a placeholder key", () => {
    expect(
      resolveGrokRoutedModelEntries({
        backend: routerBackend(),
        routeKeys: ["gpt-5.6-luna"],
        baseEnv: {},
      }),
    ).toEqual([
      {
        slug: "gpt-5.6-luna",
        model: "gpt-5.6-luna",
        baseUrl: "http://127.0.0.1:3773/openai/v1",
        apiKey: "t3-router",
      },
    ]);
  });

  it("omits the key line on direct entries without a resolved key", () => {
    const [entry] = resolveGrokRoutedModelEntries({
      backend: {
        kind: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        protocols: ["openai"],
        models: ["vendor-model"],
      },
      routeKeys: [],
      baseEnv: {},
    });
    expect(entry).not.toHaveProperty("apiKey");
  });

  it("passes a resolved backend key through, preferring the direct value", () => {
    expect(
      resolveGrokRoutedModelEntries({
        backend: routerBackend({ apiKey: "direct", apiKeyEnv: "MISSING_ENV" }),
        routeKeys: ["gpt-5.6-luna"],
        baseEnv: { MISSING_ENV: "env-value" },
      }),
    ).toMatchObject([{ apiKey: "direct" }]);
    expect(
      resolveGrokRoutedModelEntries({
        backend: routerBackend({ apiKeyEnv: "PRESENT_ENV" }),
        routeKeys: ["gpt-5.6-luna"],
        baseEnv: { PRESENT_ENV: "env-value" },
      }),
    ).toMatchObject([{ apiKey: "env-value" }]);
  });

  it("serves static connection models from a direct OpenAI-compatible backend", () => {
    expect(
      resolveGrokRoutedModelEntries({
        backend: {
          kind: "openai-compatible",
          baseUrl: "https://api.example.com/v1/",
          protocols: ["openai"],
          models: ["vendor-model"],
        },
        routeKeys: ["gpt-5.6-luna"],
        baseEnv: {},
      }),
    ).toEqual([
      { slug: "vendor-model", model: "vendor-model", baseUrl: "https://api.example.com/v1" },
    ]);
  });

  it("stays empty without a backend or on anthropic-only endpoints", () => {
    expect(
      resolveGrokRoutedModelEntries({ backend: undefined, routeKeys: ["x"], baseEnv: {} }),
    ).toEqual([]);
    expect(
      resolveGrokRoutedModelEntries({
        backend: { kind: "native" },
        routeKeys: ["x"],
        baseEnv: {},
      }),
    ).toEqual([]);
    expect(
      resolveGrokRoutedModelEntries({
        backend: {
          kind: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          protocols: ["anthropic"],
          models: ["vendor-model"],
        },
        routeKeys: ["x"],
        baseEnv: {},
      }),
    ).toEqual([]);
  });
});

const noSpawn = ChildProcessSpawner.make(() => Effect.die("Grok backend test must not spawn"));

const backendTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-grok-driver-backend-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      modelRouterRoutes: {
        "gpt-5.6-luna": {
          target: { kind: "connection", connectionId: T3_ROUTER_CONNECTION_ID },
        },
      },
    }),
  ),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Grok backend test must not request")),
    ),
  ),
);

it.layer(backendTestLayer)("GrokDriver backend wiring", (it) => {
  it.effect("writes routed entries into a shadow GROK_HOME, not the real home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-driver-" });
      const realHome = NodePath.join(tempDir, "grok-home");
      yield* fs.makeDirectory(NodePath.join(realHome, "sessions"), { recursive: true });
      yield* fs.writeFileString(NodePath.join(realHome, "config.toml"), "[cli]\n");

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-backend"),
        displayName: "Grok backend test",
        enabled: false,
        environment: [{ name: "GROK_HOME", value: realHome, sensitive: false }],
        backend: {
          kind: "t3-router",
          baseUrl: "http://127.0.0.1:3773/openai",
          protocols: ["openai", "anthropic"],
        },
        config: {
          ...GrokDriver.defaultConfig(),
          binaryPath: NodePath.join(tempDir, "missing", "grok"),
        },
      });

      // The real home stays untouched; sessions stay reachable from the shadow.
      expect(yield* fs.readFileString(NodePath.join(realHome, "config.toml"))).toBe("[cli]\n");
      const serverConfig = yield* ServerConfig;
      const shadowConfig = yield* fs.readFileString(
        NodePath.join(serverConfig.baseDir, "grok-homes", "grok-backend", "config.toml"),
      );
      expect(shadowConfig).toContain('[model."gpt-5.6-luna"]');
      expect(shadowConfig).toContain('base_url = "http://127.0.0.1:3773/openai/v1"');
      expect(shadowConfig).toContain('api_key = "t3-router"');

      // Routed slugs ride the custom-model path into the model list.
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.models.map((model) => model.slug)).toContain("gpt-5.6-luna");
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );
});
