import { DeepSeekSettings, ProviderDriverKind, type ModelBackendConfig } from "@t3tools/contracts";
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
import { makeDeepSeekTextGeneration } from "../../textGeneration/DeepSeekTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDeepSeekAdapter } from "../Layers/DeepSeekAdapter.ts";
import {
  buildInitialDeepSeekProviderSnapshot,
  checkDeepSeekProviderStatus,
  enrichDeepSeekSnapshot,
} from "../Layers/DeepSeekProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedDriverSnapshot } from "../makeManagedDriverSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import {
  BACKEND_OVERLAYS,
  resolveBackendModelSlugs,
  resolveDeclaredBackendOverlay,
} from "../ModelBackendEnvironment.ts";
import { resolveHarnessProcessEnv } from "../harnessMaterial.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);

const DRIVER_KIND = ProviderDriverKind.make("deepseek");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

/**
 * Backend env overlay for the dsh harness. dsh reads its LLM endpoint from
 * `$DEEPSEEK_BASE_URL` (verified against the installed dsh-llm-deepseek:
 * `baseURL ?? env(DEEPSEEK_BASE_URL) ?? https://api.deepseek.com`) and calls
 * OpenAI-compatible `chat/completions` on it — it never reads the generic
 * `OPENAI_BASE_URL`, so the shared overlay alone cannot steer it.
 * Anthropic-only backends stay unset: dsh cannot speak that protocol.
 */
export function resolveDeepSeekBackendEnvironment(
  backend: ModelBackendConfig | undefined,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return resolveDeclaredBackendOverlay(BACKEND_OVERLAYS.deepseek, backend, baseEnv);
}

export type DeepSeekDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const DeepSeekDriver: ProviderDriver<DeepSeekSettings, DeepSeekDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "DeepSeek",
    supportsMultipleInstances: true,
  },
  configSchema: DeepSeekSettings,
  defaultConfig: (): DeepSeekSettings => decodeDeepSeekSettings({}),
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
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      // The backend overlay reaches the harness through the spawn env: the
      // shared pairs plus dsh's own DEEPSEEK_BASE_URL. Without a backend the
      // overlays are empty and direct mode is untouched.
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to read server settings for DeepSeek backend wiring: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const processEnv = {
        ...resolveHarnessProcessEnv({ environment, backend, baseEnv: process.env }).processEnv,
        ...resolveDeepSeekBackendEnvironment(backend, process.env),
      };
      // Connection models ride the custom-model path into the snapshot list.
      // A `t3-router` backend carries no `models` of its own, so its slugs
      // come from the router's routes (same helper as Copilot).
      const backendModels = resolveBackendModelSlugs({
        backend,
        routeKeys: Object.keys(settings.modelRouterRoutes ?? {}),
      });
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
      const effectiveConfig = {
        ...config,
        enabled,
        ...(backendModels.length > 0
          ? { customModels: [...config.customModels, ...backendModels] }
          : {}),
      } satisfies DeepSeekSettings;

      const adapter = yield* makeDeepSeekAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeDeepSeekTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkDeepSeekProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedDriverSnapshot({
        driverKind: DRIVER_KIND,
        instanceId,
        displayLabel: "DeepSeek snapshot",
        effectiveConfig,
        serverSettings,
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        buildInitialSnapshot: (provider) =>
          buildInitialDeepSeekProviderSnapshot(provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: enrichDeepSeekSnapshot,
        httpClient,
      });
      const snapshotForCwd = (_workspaceCwd: string) => snapshot.getSnapshot;

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
