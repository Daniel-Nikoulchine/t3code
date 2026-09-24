/**
 * ClineDriver — `ProviderDriver` for the Cline CLI (`cline --acp`) runtime.
 *
 * Cline speaks ACP over stdio (`cline --acp`). Model catalog and capability
 * refreshes happen during the managed provider status check via ACP
 * `initialize` model state; authentication is the `cline` OAuth provider
 * (`cline auth` persists credentials reused across sessions).
 *
 * Text generation is supported via the ACP runtime — `makeClineTextGeneration`
 * drives `runtime.prompt` with a structured-output schema and collects the
 * agent's `agent_message_chunk` stream into a single JSON blob.
 *
 * @module provider/Drivers/ClineDriver
 */
import { ClineSettings, ProviderDriverKind } from "@t3tools/contracts";
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
import { makeClineTextGeneration } from "../../textGeneration/ClineTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClineAdapter } from "../Layers/ClineAdapter.ts";
import {
  buildInitialClineProviderSnapshot,
  checkClineProviderStatus,
  enrichClineSnapshot,
} from "../Layers/ClineProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedDriverSnapshot } from "../makeManagedDriverSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { resolveHarnessProcessEnv } from "../harnessMaterial.ts";
import {
  resolveDriverMaintenance,
  makeProviderMaintenanceCapabilities,
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";
import { probeClineSkills } from "./ClineSkills.ts";
const decodeClineSettings = Schema.decodeSync(ClineSettings);

const DRIVER_KIND = ProviderDriverKind.make("cline");
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: "cline",
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "cline",
            platform: context.platform,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: "cline",
          }),
    ),
};

export type ClineDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const ClineDriver: ProviderDriver<ClineSettings, ClineDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cline",
    supportsMultipleInstances: true,
  },
  configSchema: ClineSettings,
  defaultConfig: (): ClineSettings => decodeClineSettings({}),
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
      const processEnv = resolveHarnessProcessEnv({
        environment,
        backend,
        baseEnv: process.env,
      }).processEnv;
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
      const effectiveConfig = { ...config, enabled } satisfies ClineSettings;
      const resolveMaintenance = yield* resolveDriverMaintenance({
        resolver: UPDATE,
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeClineAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeClineTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkClineProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedDriverSnapshot({
        driverKind: DRIVER_KIND,
        instanceId,
        displayLabel: "Cline snapshot",
        effectiveConfig,
        serverSettings,
        resolveMaintenance,
        buildInitialSnapshot: (provider) =>
          buildInitialClineProviderSnapshot(provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: enrichClineSnapshot,
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
                probeClineSkills(cwd, processEnv).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: `Failed to discover Cline skills for '${cwd}'`,
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
