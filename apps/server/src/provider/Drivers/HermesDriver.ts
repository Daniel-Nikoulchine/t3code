import { HermesSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
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
import { makeHermesTextGeneration } from "../../textGeneration/HermesTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import {
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  enrichHermesSnapshot,
} from "../Layers/HermesProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedDriverSnapshot } from "../makeManagedDriverSnapshot.ts";
import { type ProviderDriver, type ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveDriverMaintenance,
} from "../providerMaintenance.ts";
import { makeHermesContinuationGroupKey, makeHermesEnvironment } from "./HermesHome.ts";
import { probeHermesSkills } from "./HermesSkills.ts";
const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const DRIVER_KIND = ProviderDriverKind.make("hermes");

const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: "hermes-agent",
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "hermes-agent",
            platform: context.platform,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: "hermes-agent",
          }),
    ),
};

export type HermesDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly nativeFallback?: boolean | undefined;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    ...(input.nativeFallback === true
      ? { backend: { kind: "native" as const, viaProxy: false, nativeFallback: true as const } }
      : {}),
  });

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => decodeHermesSettings({}),
  create: ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
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
      const baseEnv = mergeProviderInstanceEnvironment(environment);
      const processEnv = yield* makeHermesEnvironment(config, baseEnv);
      const continuationKey = yield* makeHermesContinuationGroupKey(config, baseEnv);
      const continuationIdentity = { driverKind: DRIVER_KIND, continuationKey };
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        nativeFallback,
      });
      const effectiveConfig = { ...config, enabled } satisfies HermesSettings;
      const resolveMaintenance = yield* resolveDriverMaintenance({
        resolver: UPDATE,
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeHermesAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeHermesTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkHermesProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedDriverSnapshot({
        driverKind: DRIVER_KIND,
        instanceId,
        displayLabel: "the Hermes provider snapshot",
        effectiveConfig,
        serverSettings,
        resolveMaintenance,
        buildInitialSnapshot: (provider) =>
          buildInitialHermesProviderSnapshot(provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: enrichHermesSnapshot,
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
        snapshotForCwd: (_cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([snapshot.getSnapshot, probeHermesSkills(processEnv)]).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Hermes skills for '${_cwd}'`,
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
