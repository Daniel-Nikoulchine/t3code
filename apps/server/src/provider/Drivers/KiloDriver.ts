import { KiloSettings, ProviderDriverKind, type ModelBackendConfig } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeKiloTextGeneration } from "../../textGeneration/KiloTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeKiloAdapter } from "../Layers/KiloAdapter.ts";
import {
  buildInitialKiloProviderSnapshot,
  checkKiloProviderStatus,
  enrichKiloSnapshot,
} from "../Layers/KiloProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedDriverSnapshot } from "../makeManagedDriverSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  BACKEND_BUCKET_PROVIDER_ID,
  isRouterBackend,
  resolveModelBackendEnvironment,
  resolveBackendModelSlugs,
} from "../ModelBackendEnvironment.ts";
import { mergeOpenCodeBackendConfigContent } from "../opencodeRuntime.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveDriverMaintenance,
} from "../providerMaintenance.ts";
import { probeKiloSkills } from "./KiloSkills.ts";
const decodeKiloSettings = Schema.decodeSync(KiloSettings);

const DRIVER_KIND = ProviderDriverKind.make("kilo");

/** Provider id T3 owns inside the Kilo config; models are `t3-backend/<slug>`. */
export const KILO_BACKEND_PROVIDER_ID = BACKEND_BUCKET_PROVIDER_ID;

/**
 * Pure backend wiring for the Kilo CLI. Kilo reads OpenCode-style provider
 * blocks from `KILO_CONFIG_CONTENT`, so a linked backend injects a
 * `t3-backend` entry there and lists its slugs as `t3-backend/<slug>`
 * custom models. A `t3-router` backend carries no models of its own, its
 * slugs come from the router route keys.
 */
export function resolveKiloBackendWiring(input: {
  readonly backend: ModelBackendConfig | undefined;
  readonly routeKeys: ReadonlyArray<string>;
  readonly instanceEnv: NodeJS.ProcessEnv;
  readonly baseEnv: NodeJS.ProcessEnv;
}): {
  readonly backendModelSlugs: ReadonlyArray<string>;
  readonly effectiveBackend: ModelBackendConfig | undefined;
  readonly backendEnv: NodeJS.ProcessEnv;
  readonly backendConfigContent: string | undefined;
  readonly backendCustomModels: ReadonlyArray<string>;
  readonly processEnv: NodeJS.ProcessEnv;
} {
  const backendModelSlugs = resolveBackendModelSlugs({
    backend: input.backend,
    routeKeys: input.routeKeys,
  });
  const effectiveBackend: ModelBackendConfig | undefined =
    input.backend !== undefined && isRouterBackend(input.backend) && backendModelSlugs.length > 0
      ? { ...input.backend, models: [...backendModelSlugs] }
      : input.backend;
  const backendEnv = resolveModelBackendEnvironment(input.backend, input.baseEnv);
  const resolvedApiKey = backendEnv.OPENAI_API_KEY ?? backendEnv.ANTHROPIC_API_KEY;
  const backendConfigContent =
    effectiveBackend === undefined
      ? undefined
      : mergeOpenCodeBackendConfigContent({
          backend: effectiveBackend,
          existingContent: input.instanceEnv.KILO_CONFIG_CONTENT,
          apiKey: resolvedApiKey,
        });
  const backendCustomModels = backendModelSlugs.map(
    (slug) => `${KILO_BACKEND_PROVIDER_ID}/${slug}`,
  );
  return {
    backendModelSlugs,
    effectiveBackend,
    backendEnv,
    backendConfigContent,
    backendCustomModels,
    processEnv: {
      ...input.instanceEnv,
      ...backendEnv,
      ...(backendConfigContent !== undefined ? { KILO_CONFIG_CONTENT: backendConfigContent } : {}),
    },
  };
}

function isKiloNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return normalized.endsWith("/.kilo/bin/kilo") || normalized.endsWith("/.kilo/bin/kilo.exe");
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@kilocode/cli",
  nativeUpdate: {
    args: ["upgrade"],
    isCommandPath: isKiloNativeCommandPath,
  },
});

export type KiloDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const KiloDriver: ProviderDriver<KiloSettings, KiloDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kilo",
    supportsMultipleInstances: true,
  },
  configSchema: KiloSettings,
  defaultConfig: (): KiloSettings => decodeKiloSettings({}),
  create: ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
    backend,
    nativeFallback,
  }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      // Kilo is OpenCode-based: it reads a `KILO_CONFIG_CONTENT` provider
      // block the same way OpenCode reads `OPENCODE_CONFIG_CONTENT`. A model
      // backend therefore injects a `t3-backend` provider entry there so its
      // models become selectable as `t3-backend/<slug>`, alongside the env
      // overlay the generic resolver already provides. A `t3-router` backend
      // has no `models` of its own (the synthesized router connection omits
      // them), so its entries come from the router's route keys.
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to read server settings for Kilo backend wiring: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const wiring = resolveKiloBackendWiring({
        backend,
        routeKeys: Object.keys(settings.modelRouterRoutes ?? {}),
        instanceEnv: mergeProviderInstanceEnvironment(environment),
        baseEnv: process.env,
      });
      const backendModelSlugs = wiring.backendModelSlugs;
      const processEnv = wiring.processEnv;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        backend,
        nativeFallback,
      });
      // Backend models surface in the picker as `t3-backend/<slug>` (the
      // provider id from the injected config block), so custom models carry
      // that prefix to resolve against the router.
      const backendCustomModels = backendModelSlugs.map(
        (slug) => `${KILO_BACKEND_PROVIDER_ID}/${slug}`,
      );
      const effectiveConfig = {
        ...config,
        enabled,
        ...(backendCustomModels.length > 0
          ? { customModels: [...config.customModels, ...backendCustomModels] }
          : {}),
      } satisfies KiloSettings;
      const resolveMaintenance = yield* resolveDriverMaintenance({
        resolver: UPDATE,
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeKiloAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeKiloTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkKiloProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedDriverSnapshot({
        driverKind: DRIVER_KIND,
        instanceId,
        displayLabel: "the Kilo provider snapshot",
        effectiveConfig,
        serverSettings,
        resolveMaintenance,
        buildInitialSnapshot: (provider) =>
          buildInitialKiloProviderSnapshot(provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: enrichKiloSnapshot,
        httpClient,
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([snapshot.getSnapshot, probeKiloSkills(cwd, processEnv)]).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Kilo skills for '${cwd}'`,
                      cause,
                    }),
                ),
                Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              ),
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
