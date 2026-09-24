/**
 * PiDriver — `ProviderDriver` for the Pi coding agent (`pi --mode rpc`).
 *
 * Each instance owns one pi config dir (`PI_CODING_AGENT_DIR`) and spawns
 * ephemeral RPC processes per T3 thread. Two instances with different
 * `homePath`s therefore use independent pi auth, models, skills, and
 * sessions — no shared mutable state.
 *
 * @module provider/Drivers/PiDriver
 */
import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
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
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  enrichPiSnapshot,
} from "../Layers/PiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedDriverSnapshot } from "../makeManagedDriverSnapshot.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeProviderMaintenanceCapabilities,
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveDriverMaintenance,
} from "../providerMaintenance.ts";
import { makePiContinuationGroupKey, makePiEnvironment } from "./PiHome.ts";
import { probePiSkills } from "./PiSkills.ts";
import { ensurePiBackendExtension, resolvePiBackendWiring } from "./PiBackend.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const DRIVER_KIND = ProviderDriverKind.make("pi");
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: "@mariozechner/pi-coding-agent",
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "pi-coding-agent",
            platform: context.platform,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: "@mariozechner/pi-coding-agent",
          }),
    ),
};

export type PiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
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
      const { baseDir } = yield* ServerConfig;
      // A linked model backend reaches Pi through a generated extension
      // that registers a T3-owned `t3-backend` provider (Pi has no endpoint
      // flag; custom providers come from extensions). Backend models ride
      // the custom-model path into the picker as `t3-backend/<slug>` and
      // run with no Pi `/login`. Without a backend everything below stays
      // empty and the instance keeps its native Pi login behavior.
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to read server settings for Pi backend wiring: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const wiring = resolvePiBackendWiring({
        backend,
        routeKeys: Object.keys(settings.modelRouterRoutes ?? {}),
        baseEnv: process.env,
      });
      const extensionPaths =
        wiring === undefined
          ? []
          : [
              yield* ensurePiBackendExtension({
                baseDir,
                instanceId,
                content: wiring.extensionContent,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to write the Pi backend extension: ${cause.message ?? String(cause)}`,
                      cause,
                    }),
                ),
              ),
            ];
      const baseEnv = mergeProviderInstanceEnvironment(environment);
      const processEnv = yield* makePiEnvironment(config, {
        ...baseEnv,
        ...(wiring !== undefined ? wiring.envOverlay : {}),
      });
      const homeContinuationKey = yield* makePiContinuationGroupKey(config, baseEnv);
      // Backend-wired instances must not resume sessions from a different
      // model space: two instances sharing one Pi home with different
      // backends both offer `t3-backend/<slug>` for different upstreams.
      const continuationKey =
        wiring === undefined ? homeContinuationKey : `${homeContinuationKey}:backend:${instanceId}`;
      const continuationIdentity = { driverKind: DRIVER_KIND, continuationKey };
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        backend,
        nativeFallback,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        ...(wiring !== undefined && wiring.customModels.length > 0
          ? { customModels: [...config.customModels, ...wiring.customModels] }
          : {}),
      } satisfies PiSettings;
      const resolveMaintenance = yield* resolveDriverMaintenance({
        resolver: UPDATE,
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makePiAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
        ...(extensionPaths.length > 0 ? { extensionPaths } : {}),
      });
      const textGeneration = yield* makePiTextGeneration(
        effectiveConfig,
        processEnv,
        extensionPaths,
      );

      const checkProvider = checkPiProviderStatus(
        effectiveConfig,
        processEnv,
        undefined,
        extensionPaths.length > 0 ? { extensionPaths } : undefined,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedDriverSnapshot({
        driverKind: DRIVER_KIND,
        instanceId,
        displayLabel: "Pi snapshot",
        effectiveConfig,
        serverSettings,
        resolveMaintenance,
        buildInitialSnapshot: (provider) =>
          buildInitialPiProviderSnapshot(provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: enrichPiSnapshot,
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
            : Effect.all([
                snapshot.getSnapshot,
                probePiSkills(processEnv, cwd).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: `Failed to discover Pi skills for '${cwd}'`,
                        cause,
                      }),
                  ),
                ),
              ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
