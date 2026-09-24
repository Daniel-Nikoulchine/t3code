/**
 * MinimaxDriver — `ProviderDriver` for MiniMax Code (`mcode acp`).
 *
 * v1 is native-only: the instance shares the user's mcode home (and its
 * `mcode login`), like Cline. mcode offers no extension or endpoint flag
 * for custom providers, so a `t3-backend` injection would mean rewriting
 * the user's own `config.yaml` — deliberately out of scope. Router routes
 * still pool into the picker through the catalog layer; turns on those
 * rows resolve natively and fail loudly instead of half-working.
 *
 * @module provider/Drivers/MinimaxDriver
 */
import { MinimaxSettings, ProviderDriverKind } from "@t3tools/contracts";
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
import { makeMinimaxTextGeneration } from "../../textGeneration/MinimaxTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMinimaxAdapter } from "../Layers/MinimaxAdapter.ts";
import {
  buildInitialMinimaxProviderSnapshot,
  checkMinimaxProviderStatus,
  enrichMinimaxSnapshot,
} from "../Layers/MinimaxProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedDriverSnapshot } from "../makeManagedDriverSnapshot.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveDriverMaintenance,
} from "../providerMaintenance.ts";
import { probeMinimaxSkills } from "./MinimaxSkills.ts";

const decodeMinimaxSettings = Schema.decodeSync(MinimaxSettings);

const DRIVER_KIND = ProviderDriverKind.make("minimax");

const UPDATE: ProviderMaintenanceCapabilitiesResolver =
  makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@minimax-ai/code",
    nativeUpdate: null,
  });

export type MinimaxDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const MinimaxDriver: ProviderDriver<MinimaxSettings, MinimaxDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "MiniMax",
    supportsMultipleInstances: true,
  },
  configSchema: MinimaxSettings,
  defaultConfig: (): MinimaxSettings => decodeMinimaxSettings({}),
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
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = {
        driverKind: DRIVER_KIND,
        continuationKey: `minimax:instance:${instanceId}`,
      };
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        backend: undefined,
        nativeFallback,
      });
      const effectiveConfig = {
        ...config,
        enabled,
      } satisfies MinimaxSettings;
      const resolveMaintenance = yield* resolveDriverMaintenance({
        resolver: UPDATE,
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeMinimaxAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeMinimaxTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkMinimaxProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedDriverSnapshot({
        driverKind: DRIVER_KIND,
        instanceId,
        displayLabel: "the MiniMax provider snapshot",
        effectiveConfig,
        serverSettings,
        resolveMaintenance,
        buildInitialSnapshot: (provider) =>
          buildInitialMinimaxProviderSnapshot(provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: enrichMinimaxSnapshot,
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
            : Effect.all([snapshot.getSnapshot, probeMinimaxSkills(cwd, processEnv)]).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover MiniMax skills for '${cwd}'`,
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
