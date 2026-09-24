// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ModelBackendConfig, ProviderInstanceEnvironment } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import type { ProviderDriverError } from "../Errors.ts";
import { ClineDriver, type ClineDriverEnv } from "./ClineDriver.ts";
import { CopilotDriver, type CopilotDriverEnv } from "./CopilotDriver.ts";
import { CursorDriver, type CursorDriverEnv } from "./CursorDriver.ts";
import { DroidDriver, type DroidDriverEnv } from "./DroidDriver.ts";
import { KiloDriver, type KiloDriverEnv } from "./KiloDriver.ts";

const BACKEND_BASE_URL = "http://127.0.0.1:20128/v1";
const INSTANCE_BASE_URL = "http://instance:9999/v1";

interface CapturedCheck {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv | undefined;
}

const captured = vi.hoisted(() => ({
  cursor: [] as Array<CapturedCheck>,
  copilot: [] as Array<CapturedCheck>,
  cline: [] as Array<CapturedCheck>,
  kilo: [] as Array<CapturedCheck>,
  droid: [] as Array<CapturedCheck>,
}));

vi.mock("../Layers/CursorProvider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../Layers/CursorProvider.ts")>();
  return {
    ...actual,
    checkCursorProviderStatus: (...args: Parameters<typeof actual.checkCursorProviderStatus>) => {
      captured.cursor.push({ binaryPath: args[0].binaryPath, environment: args[1] });
      return actual.checkCursorProviderStatus(...args);
    },
  };
});

vi.mock("../Layers/CopilotProvider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../Layers/CopilotProvider.ts")>();
  return {
    ...actual,
    checkCopilotProviderStatus: (...args: Parameters<typeof actual.checkCopilotProviderStatus>) => {
      captured.copilot.push({ binaryPath: args[0].binaryPath, environment: args[1] });
      return actual.checkCopilotProviderStatus(...args);
    },
  };
});

vi.mock("../Layers/ClineProvider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../Layers/ClineProvider.ts")>();
  return {
    ...actual,
    checkClineProviderStatus: (...args: Parameters<typeof actual.checkClineProviderStatus>) => {
      captured.cline.push({ binaryPath: args[0].binaryPath, environment: args[1] });
      return actual.checkClineProviderStatus(...args);
    },
  };
});

vi.mock("../Layers/KiloProvider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../Layers/KiloProvider.ts")>();
  return {
    ...actual,
    checkKiloProviderStatus: (...args: Parameters<typeof actual.checkKiloProviderStatus>) => {
      captured.kilo.push({ binaryPath: args[0].binaryPath, environment: args[1] });
      return actual.checkKiloProviderStatus(...args);
    },
  };
});

vi.mock("../Layers/DroidProvider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../Layers/DroidProvider.ts")>();
  return {
    ...actual,
    checkDroidProviderStatus: (...args: Parameters<typeof actual.checkDroidProviderStatus>) => {
      captured.droid.push({ binaryPath: args[0].binaryPath, environment: args[1] });
      return actual.checkDroidProviderStatus(...args);
    },
  };
});

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-acp-driver-backend-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled ACP driver must not make an HTTP request")),
    ),
  ),
);

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die(new Error("Disabled ACP driver backend test must not spawn a process")),
);

const instanceEnvironment: ProviderInstanceEnvironment = [
  { name: "OPENAI_BASE_URL", value: INSTANCE_BASE_URL, sensitive: false },
  { name: "T3_CUSTOM_KEEP", value: "kept", sensitive: false },
];

const withBackend = (backend: ModelBackendConfig | undefined) =>
  backend === undefined ? {} : { backend };

interface BackendWiringCase {
  readonly driverName: string;
  readonly stores: ReadonlyArray<CapturedCheck>;
  readonly clear: () => void;
  readonly create: (
    backend: ModelBackendConfig | undefined,
  ) => Effect.Effect<
    void,
    ProviderDriverError,
    | Scope.Scope
    | CursorDriverEnv
    | CopilotDriverEnv
    | ClineDriverEnv
    | KiloDriverEnv
    | DroidDriverEnv
  >;
  /**
   * Wire the backend reaches this harness through. Defaults to the shared
   * `OPENAI_*`/`ANTHROPIC_*` overlay; Copilot overrides it because BYOK reads
   * `COPILOT_PROVIDER_*` and ignores the generic pairs.
   */
  readonly assertBackendEnv?: (spawnEnv: NodeJS.ProcessEnv | undefined) => void;
}

const assertGenericBackendEnv = (spawnEnv: NodeJS.ProcessEnv | undefined): void => {
  // Backend overlay wins on OPENAI_*/ANTHROPIC_* keys...
  expect(spawnEnv?.OPENAI_BASE_URL).toBe(BACKEND_BASE_URL);
  expect(spawnEnv?.ANTHROPIC_BASE_URL).toBe(BACKEND_BASE_URL);
};

const backendOverlay: ModelBackendConfig = {
  kind: "openai-compatible",
  baseUrl: BACKEND_BASE_URL,
};

const cases: ReadonlyArray<BackendWiringCase> = [
  {
    driverName: "cursor",
    stores: captured.cursor,
    clear: () => {
      captured.cursor.length = 0;
    },
    create: (backend) =>
      CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor-backend-probe"),
        displayName: "Cursor backend probe",
        enabled: false,
        environment: [...instanceEnvironment],
        ...withBackend(backend),
        config: { ...CursorDriver.defaultConfig() },
      }).pipe(Effect.asVoid),
  },
  {
    driverName: "copilot",
    stores: captured.copilot,
    clear: () => {
      captured.copilot.length = 0;
    },
    // Copilot's BYOK mode reads COPILOT_PROVIDER_* and skips GitHub auth; the
    // generic OPENAI_*/ANTHROPIC_* pairs never reach it, so the backend must
    // land on the BYOK keys instead.
    assertBackendEnv: (spawnEnv) => {
      expect(spawnEnv?.COPILOT_PROVIDER_BASE_URL).toBe(BACKEND_BASE_URL);
      expect(spawnEnv?.COPILOT_PROVIDER_TYPE).toBe("openai");
      expect(spawnEnv?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);
    },
    create: (backend) =>
      CopilotDriver.create({
        instanceId: ProviderInstanceId.make("copilot-backend-probe"),
        displayName: "Copilot backend probe",
        enabled: false,
        environment: [...instanceEnvironment],
        ...withBackend(backend),
        config: { ...CopilotDriver.defaultConfig() },
      }).pipe(Effect.asVoid),
  },
  {
    driverName: "cline",
    stores: captured.cline,
    clear: () => {
      captured.cline.length = 0;
    },
    create: (backend) =>
      ClineDriver.create({
        instanceId: ProviderInstanceId.make("cline-backend-probe"),
        displayName: "Cline backend probe",
        enabled: false,
        environment: [...instanceEnvironment],
        ...withBackend(backend),
        config: { ...ClineDriver.defaultConfig() },
      }).pipe(Effect.asVoid),
  },
  {
    driverName: "kilo",
    stores: captured.kilo,
    clear: () => {
      captured.kilo.length = 0;
    },
    create: (backend) =>
      KiloDriver.create({
        instanceId: ProviderInstanceId.make("kilo-backend-probe"),
        displayName: "Kilo backend probe",
        enabled: false,
        environment: [...instanceEnvironment],
        ...withBackend(backend),
        config: { ...KiloDriver.defaultConfig() },
      }).pipe(Effect.asVoid),
  },
  {
    driverName: "droid",
    stores: captured.droid,
    clear: () => {
      captured.droid.length = 0;
    },
    create: (backend) =>
      DroidDriver.create({
        instanceId: ProviderInstanceId.make("droid-backend-probe"),
        displayName: "Droid backend probe",
        enabled: false,
        environment: [...instanceEnvironment],
        ...withBackend(backend),
        config: { ...DroidDriver.defaultConfig() },
      }).pipe(Effect.asVoid),
  },
];

it.layer(testLayer)("AcpDriver model backend wiring", (it) => {
  for (const testCase of cases) {
    it.effect(`${testCase.driverName} merges the backend overlay over the instance env`, () =>
      Effect.gen(function* () {
        testCase.clear();
        yield* testCase
          .create(backendOverlay)
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
            Effect.scoped,
          );

        expect(testCase.stores).toHaveLength(1);
        const spawnEnv = testCase.stores[0]?.environment;
        (testCase.assertBackendEnv ?? assertGenericBackendEnv)(spawnEnv);
        // ...while unrelated instance env is preserved.
        expect(spawnEnv?.T3_CUSTOM_KEEP).toBe("kept");
      }),
    );

    it.effect(`${testCase.driverName} leaves the instance env untouched without a backend`, () =>
      Effect.gen(function* () {
        testCase.clear();
        yield* testCase
          .create(undefined)
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
            Effect.scoped,
          );

        expect(testCase.stores).toHaveLength(1);
        const spawnEnv = testCase.stores[0]?.environment;
        expect(spawnEnv?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);
        expect(spawnEnv?.T3_CUSTOM_KEEP).toBe("kept");
        expect(spawnEnv?.ANTHROPIC_BASE_URL).toBe(process.env.ANTHROPIC_BASE_URL);
      }),
    );
  }
});
