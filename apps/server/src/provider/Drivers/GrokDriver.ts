import { GrokSettings, ProviderDriverKind, type ModelBackendConfig } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeGrokTextGeneration } from "../../textGeneration/GrokTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  enrichGrokSnapshot,
} from "../Layers/GrokProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedDriverSnapshot } from "../makeManagedDriverSnapshot.ts";
import { readGrokUsageLimits } from "../Layers/grokUsageLimits.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import {
  DEFAULT_BACKEND_PROTOCOLS,
  isRouterBackend,
  isUsableBackend,
} from "../ModelBackendEnvironment.ts";
import { resolveHarnessProcessEnv } from "../harnessMaterial.ts";
import { ensureGrokBackendHome, type GrokRoutedModelEntry } from "./GrokHomeLayout.ts";
import { discoverGrokSkills } from "./GrokSkills.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const DRIVER_KIND = ProviderDriverKind.make("grok");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type GrokDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Model entries for a backend wired grok instance. Grok resolves each `-m`
 * id through its own `[model.<name>]` table, so every slug the harness may
 * be asked for needs an entry pointing at an OpenAI Chat Completions
 * surface (`base_url` + `/v1/chat/completions`, verified against the
 * installed binary).
 *
 * Router backed instances serve the route keys: the router matches the
 * request `model` against the key, so the entry carries the key unchanged
 * and never resolves the upstream itself. Direct OpenAI-compatible backends
 * serve their static model list. Native instances and Anthropic-only
 * endpoints yield nothing and grok keeps its default behavior.
 *
 * Without a resolved key no `api_key` is set on direct entries and grok
 * falls back to its own login, per its documented key chain. Router entries
 * always carry a key: the proxy authenticates upstream itself and ignores
 * whatever the harness sends, so a placeholder keeps grok from demanding a
 * login it never needs.
 */
export function resolveGrokRoutedModelEntries(input: {
  readonly backend: ModelBackendConfig | undefined;
  readonly routeKeys: ReadonlyArray<string>;
  readonly baseEnv: NodeJS.ProcessEnv;
}): Array<GrokRoutedModelEntry> {
  const { backend, routeKeys, baseEnv } = input;
  if (!isUsableBackend(backend)) return [];
  if (!(backend.protocols ?? DEFAULT_BACKEND_PROTOCOLS).includes("openai")) return [];
  if (backend.baseUrl === undefined) return [];
  const baseUrl = backend.baseUrl.replace(/\/+$/, "");
  const grokBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const apiKey =
    backend.apiKey ?? (backend.apiKeyEnv !== undefined ? baseEnv[backend.apiKeyEnv] : undefined);
  if (isRouterBackend(backend)) {
    const routerKey = apiKey !== undefined && apiKey.length > 0 ? apiKey : "t3-router";
    return routeKeys.map((slug) => ({
      slug,
      model: slug,
      baseUrl: grokBaseUrl,
      apiKey: routerKey,
    }));
  }
  const keyPart = apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {};
  return (backend.models ?? []).map((slug) => ({
    slug,
    model: slug,
    baseUrl: grokBaseUrl,
    ...keyPart,
  }));
}

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok",
    supportsMultipleInstances: true,
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => decodeGrokSettings({}),
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
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const { cwd, baseDir } = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      // The backend overlay reaches the harness through a shadow GROK_HOME:
      // grok resolves each `-m` id via its own `[model.<name>]` table, so
      // routed slugs need entries the CLI's flags cannot express. Without a
      // backend the overlay stays empty and direct mode is untouched.
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to read server settings for Grok backend wiring: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const routeKeys = Object.keys(settings.modelRouterRoutes ?? {});
      const routedEntries = resolveGrokRoutedModelEntries({
        backend,
        routeKeys,
        baseEnv: process.env,
      });
      const processEnv = resolveHarnessProcessEnv({
        environment,
        backend,
        baseEnv: process.env,
      }).processEnv;
      if (routedEntries.length > 0) {
        const realHome =
          processEnv.GROK_HOME && processEnv.GROK_HOME.length > 0
            ? processEnv.GROK_HOME
            : path.join(NodeOS.homedir(), ".grok");
        const home = yield* ensureGrokBackendHome({
          realHomePath: realHome,
          shadowHomePath: path.join(baseDir, "grok-homes", instanceId),
          entries: routedEntries,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to set up the Grok backend home: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );
        processEnv.GROK_HOME = home.shadowHomePath;
      }
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
        ...(routedEntries.length > 0
          ? { customModels: [...config.customModels, ...routedEntries.map((entry) => entry.slug)] }
          : {}),
      } satisfies GrokSettings;
      const adapter = yield* makeGrokAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkGrokProviderStatus(effectiveConfig, processEnv, cwd).pipe(
        Effect.flatMap((snapshot) =>
          effectiveConfig.enabled && snapshot.installed && snapshot.auth.status === "authenticated"
            ? readGrokUsageLimits(processEnv).pipe(
                Effect.map((usageLimits) => ({ ...snapshot, usageLimits })),
              )
            : Effect.succeed(snapshot),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedDriverSnapshot({
        driverKind: DRIVER_KIND,
        instanceId,
        displayLabel: "Grok snapshot",
        effectiveConfig,
        serverSettings,
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        buildInitialSnapshot: (provider) =>
          buildInitialGrokProviderSnapshot(provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: enrichGrokSnapshot,
        httpClient,
      });
      const snapshotForCwd = (workspaceCwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverGrokSkills(effectiveConfig, processEnv, workspaceCwd).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Grok skills for '${workspaceCwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })));

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
