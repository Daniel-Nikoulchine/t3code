// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { beforeEach } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { OpenCodeDriver } from "./OpenCodeDriver.ts";

const BACKEND_BASE_URL = "http://127.0.0.1:20128/v1";

const startEnvironments: Array<NodeJS.ProcessEnv | undefined> = [];

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: (input) =>
    Effect.gen(function* () {
      startEnvironments.push(input.environment);
      yield* Effect.addFinalizer(() => Effect.void);
      return {
        url: "http://127.0.0.1:4321",
        version: "1.14.19",
        isRunning: Effect.succeed(true),
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: () =>
    Effect.die(new Error("OpenCodeDriver backend test must not connect to an external server")),
  runOpenCodeCommand: () =>
    Effect.die(new Error("OpenCodeDriver backend test must not run the OpenCode CLI")),
  createOpenCodeSdkClient: () =>
    ({}) as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.die(new Error("OpenCodeDriver backend test must not load inventory")),
  loadOpenCodeSkills: () => Effect.succeed([]),
  loadInventoryFromCli: () =>
    Effect.die(new Error("OpenCodeDriver backend test must not load inventory from CLI")),
  loadSkillsFromCli: () => Effect.succeed([]),
};

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-opencode-driver-backend-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() =>
        Effect.die(new Error("OpenCodeDriver backend test must not make HTTP requests")),
      ),
    ),
  ),
);

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die(new Error("OpenCodeDriver backend test must not spawn a process")),
);

beforeEach(() => {
  startEnvironments.length = 0;
});

it.layer(testLayer)("OpenCodeDriver model backend", (it) => {
  it.effect("passes the backend env overlay to the spawned server", () =>
    Effect.gen(function* () {
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-backend"),
        displayName: "OpenCode backend test",
        enabled: true,
        environment: [
          { name: "OPENAI_BASE_URL", value: "http://instance:9999/v1", sensitive: false },
          { name: "T3_CUSTOM_KEEP", value: "kept", sensitive: false },
        ],
        backend: { kind: "openai-compatible", baseUrl: BACKEND_BASE_URL },
        config: { ...OpenCodeDriver.defaultConfig(), enabled: true },
      });

      expect(instance.snapshotForCwd).toBeDefined();
      yield* instance.snapshotForCwd!(process.cwd());

      expect(startEnvironments).toHaveLength(1);
      const spawnEnv = startEnvironments[0];
      // Backend overlay wins on OPENAI_*/ANTHROPIC_* keys...
      expect(spawnEnv?.OPENAI_BASE_URL).toBe(BACKEND_BASE_URL);
      expect(spawnEnv?.ANTHROPIC_BASE_URL).toBe(BACKEND_BASE_URL);
      // ...while unrelated instance env is preserved.
      expect(spawnEnv?.T3_CUSTOM_KEEP).toBe("kept");
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  it.effect("leaves spawn env untouched without a backend", () =>
    Effect.gen(function* () {
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-native"),
        displayName: "OpenCode native test",
        enabled: true,
        environment: [
          { name: "OPENAI_BASE_URL", value: "http://instance:9999/v1", sensitive: false },
        ],
        config: { ...OpenCodeDriver.defaultConfig(), enabled: true },
      });

      yield* instance.snapshotForCwd!(process.cwd());

      expect(startEnvironments).toHaveLength(1);
      expect(startEnvironments[0]?.OPENAI_BASE_URL).toBe("http://instance:9999/v1");
      expect(startEnvironments[0]?.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  it.effect("injects the t3-backend provider into the spawned server's config content", () =>
    Effect.gen(function* () {
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-config"),
        displayName: "OpenCode backend config test",
        enabled: true,
        environment: [
          {
            name: "OPENCODE_CONFIG_CONTENT",
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            value: JSON.stringify({ theme: "dark", provider: { mine: { options: {} } } }),
            sensitive: false,
          },
        ],
        backend: {
          kind: "openai-compatible",
          baseUrl: BACKEND_BASE_URL,
          apiKey: "sk-stored-credential",
          models: ["glm-4.6"],
        },
        config: { ...OpenCodeDriver.defaultConfig(), enabled: true },
      });

      yield* instance.snapshotForCwd!(process.cwd());

      const spawnEnv = startEnvironments[0];
      const rawConfigContent = spawnEnv?.OPENCODE_CONFIG_CONTENT;
      expect(rawConfigContent).toBeDefined();
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const configContent = JSON.parse(rawConfigContent ?? "{}") as {
        theme?: string;
        provider: Record<
          string,
          {
            npm: string;
            options: Record<string, string | undefined>;
            models?: Record<string, unknown>;
          }
        >;
      };
      expect(configContent.theme).toBe("dark");
      expect(configContent.provider.mine).toBeDefined();
      const injected = configContent.provider["t3-backend"];
      if (injected === undefined) {
        return expect.fail("Expected the t3-backend provider to be injected");
      }
      expect(injected.npm).toBe("@ai-sdk/openai-compatible");
      expect(injected.options.baseURL).toBe(BACKEND_BASE_URL);
      expect(injected.options.apiKey).toBe("sk-stored-credential");
      expect(Object.keys(injected.models ?? {})).toEqual(["glm-4.6"]);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  it.effect("does not set config content without a backend", () =>
    Effect.gen(function* () {
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-config-native"),
        displayName: "OpenCode native config test",
        enabled: true,
        environment: [],
        config: { ...OpenCodeDriver.defaultConfig(), enabled: true },
      });

      yield* instance.snapshotForCwd!(process.cwd());

      expect(startEnvironments[0]?.OPENCODE_CONFIG_CONTENT).toBe(
        process.env.OPENCODE_CONFIG_CONTENT,
      );
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );
});
