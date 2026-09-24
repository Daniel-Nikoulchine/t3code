/**
 * CopilotDriver — `ProviderDriver` for the GitHub Copilot CLI (`copilot --acp`).
 *
 * Copilot exposes an ACP server (`copilot --acp` via stdio). Model catalog is
 * static (from `copilot help config`); slash commands come from the ACP
 * `available_commands_update` notification during the status probe.
 *
 * Text generation is supported via the ACP runtime — `makeCopilotTextGeneration`
 * drives `runtime.prompt` with a structured-output schema and collects the
 * agent's `agent_message_chunk` stream into a single JSON blob.
 *
 * @module provider/Drivers/CopilotDriver
 */
import { CopilotSettings, ProviderDriverKind, type ModelBackendConfig } from "@t3tools/contracts";
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
import { makeCopilotTextGeneration } from "../../textGeneration/CopilotTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCopilotAdapter } from "../Layers/CopilotAdapter.ts";
import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  enrichCopilotSnapshot,
} from "../Layers/CopilotProvider.ts";
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
  BACKEND_OVERLAYS,
  resolveBackendModelSlugs,
  resolveDeclaredBackendOverlay,
} from "../ModelBackendEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

const DRIVER_KIND = ProviderDriverKind.make("copilot");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

/**
 * Backend env overlay for the Copilot CLI's BYOK mode. Copilot reads its
 * model endpoint from `COPILOT_PROVIDER_*` (verified against
 * `copilot help providers`: base URL activates BYOK, type picks the wire,
 * GitHub auth is skipped entirely). The generic `OPENAI_*`/`ANTHROPIC_*`
 * overlay does not reach it, so a backend must map onto these names.
 *
 * OpenAI wire only: like the DeepSeek and Grok drivers this overlay stays
 * empty for Anthropic-only endpoints (unverified path, no live proof), so a
 * linked Anthropic-only backend leaves the instance on its GitHub login
 * instead of flipping it into a BYOK mode whose models could never resolve.
 */
export function resolveCopilotBackendEnvironment(
  backend: ModelBackendConfig | undefined,
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return resolveDeclaredBackendOverlay(BACKEND_OVERLAYS.copilot, backend, baseEnv);
}

export type CopilotDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
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
      // BYOK serves the slugs the backend declares; a `t3-router` backend has
      // no `models` of its own, so its slugs come from the router's routes.
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to read server settings for Copilot backend wiring: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const backendModelSlugs = resolveBackendModelSlugs({
        backend,
        routeKeys: Object.keys(settings.modelRouterRoutes ?? {}),
      });
      const backendOverlay = resolveCopilotBackendEnvironment(backend, process.env);
      const processEnv = {
        ...mergeProviderInstanceEnvironment(environment),
        ...backendOverlay,
      };
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
      // Backend models ride the custom-model path into the snapshot list so
      // they become pickable alongside the harness's own models.
      const effectiveConfig = {
        ...config,
        enabled,
        ...(backendModelSlugs.length > 0
          ? { customModels: [...config.customModels, ...backendModelSlugs] }
          : {}),
      } satisfies CopilotSettings;
      const adapter = yield* makeCopilotAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeCopilotTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkCopilotProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedDriverSnapshot({
        driverKind: DRIVER_KIND,
        instanceId,
        displayLabel: "Copilot snapshot",
        effectiveConfig,
        serverSettings,
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        buildInitialSnapshot: (provider) =>
          buildInitialCopilotProviderSnapshot(provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: enrichCopilotSnapshot,
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
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
