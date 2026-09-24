/**
 * ProviderInstanceRegistryHydration — derive a `ProviderInstanceConfigMap`
 * from `ServerSettings` and keep `ProviderInstanceRegistry` in sync with it.
 *
 * The server still reads two shapes:
 *
 *   1. `settings.providerInstances` — the new driver-agnostic map the
 *      registry expects. Keyed by `ProviderInstanceId`, values are
 *      `ProviderInstanceConfig` envelopes.
 *   2. `settings.providers.<kind>` — the legacy single-instance-per-driver
 *      fields (`providers.codex`, `providers.claudeAgent`, …). These are
 *      the source of truth for every deployment that hasn't been migrated
 *      yet to an explicit `providerInstances` entry.
 *
 * This module bridges (2) into (1) and wires the resulting map into a
 * mutable registry. For every built-in driver whose id is not already
 * present in `providerInstances` (keyed on
 * `defaultInstanceIdForDriver(driverKind)` — literally the driver kind as a
 * routing slug), we synthesize an envelope from the legacy field. The
 * registry decodes both flavours through the same `configSchema` and ends
 * up with one uniform `ProviderInstance` per entry.
 *
 * Explicit `providerInstances` entries always win — users can already
 * override the legacy `providers.<kind>` blob by authoring a
 * `providerInstances.codex` entry with a matching driver, and we don't
 * want the synthesized envelope to silently stomp their config.
 *
 * Hot-reload
 * ----------
 * On layer build we:
 *   1. Read the current `ServerSettings` once and use it to seed the
 *      registry's initial state via `ProviderInstanceRegistryMutableLayer`.
 *   2. Fork a daemon fiber (lifetime tied to the layer's scope) that
 *      acquires `ServerSettingsService.subscribeChanges` and calls
 *      `ProviderInstanceRegistryMutator.reconcile` on every emission.
 *
 * Failures inside the watcher are logged and swallowed so a single bad
 * settings emission cannot kill the registry. Unknown drivers and invalid
 * configs already round-trip through the registry's own "unavailable"
 * shadow bucket.
 *
 * @module provider/Layers/ProviderInstanceRegistryHydration
 */
import {
  defaultInstanceIdForDriver,
  ModelBackendConnections,
  type ModelProxyConfig,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
  T3_ROUTER_CONNECTION_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "../builtInDrivers.ts";
import { ModelRouterProxy } from "../router/ModelRouterProxy.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../Services/ProviderInstanceRegistryMutator.ts";
import { ProviderInstanceRegistryMutableLayer } from "./ProviderInstanceRegistryLive.ts";

/**
 * Synthesize a `ProviderInstanceConfigMap` from a `ServerSettings` snapshot.
 *
 * Strategy:
 *   1. Copy all explicit `settings.providerInstances` entries verbatim.
 *   2. For each built-in driver whose `defaultInstanceIdForDriver(id)` key
 *      is *not* already in the explicit map, synthesize an entry from the
 *      matching legacy `settings.providers.<kind>` blob.
 *
 * The returned map is the input the registry consumes; pure & exported
 * separately so the hydration logic can be exercised by unit tests
 * without layering.
 */
export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };

  for (const driver of BUILT_IN_DRIVERS) {
    const instanceId = defaultInstanceIdForDriver(driver.driverKind);
    if (instanceId in merged) {
      // Explicit `providerInstances` entry for this slot — user-authored
      // config always wins over the legacy mirror.
      continue;
    }

    // Only built-in drivers have a legacy mirror; the registry's
    // `providers` struct is keyed on the same literal slug as
    // `driverKind`. Access is dynamic (the driver kind is a branded string),
    // but it's constrained to `keyof settings.providers` by the union of
    // built-in driver kinds.
    const legacyKey = driver.driverKind as keyof ServerSettings["providers"];
    const legacyConfig = settings.providers[legacyKey];
    if (legacyConfig === undefined) {
      continue;
    }

    merged[instanceId] = {
      driver: driver.driverKind,
      config: legacyConfig,
    };
  }

  return merged as ProviderInstanceConfigMap;
};

/**
 * Connections map the registry resolves `connectionId` references against:
 * the user's `modelBackendConnections` plus, when the model router is
 * running, a synthesized entry under the reserved `T3_ROUTER_CONNECTION_ID`
 * ("t3-router").
 *
 * Instances opt into the router by setting `connectionId: "t3-router"`; the
 * synthesized entry is injected under that same key, so the reference needs
 * no rewrite — `resolveInstanceBackend` finds it like any other connection.
 * If the user has claimed the id with a real connection, their entry wins
 * and nothing is injected. When the router is disabled (its loopback listener
 * failed to bind) nothing is injected either, and referencing instances stay
 * native orphans — `resolveInstanceBackend` degrades a missing connection to
 * native, and the registry logs the fallback via `orphanBackendConnectionId`
 * so a harness talking to the vendor instead of the router stays visible.
 *
 * Pure & exported for unit tests.
 */
export const deriveRegistryConnections = (
  settings: ServerSettings,
  routerBaseUrl: string | undefined,
): ModelBackendConnections => {
  const connections: Record<string, ModelProxyConfig> = {
    ...settings.modelBackendConnections,
  };
  if (routerBaseUrl !== undefined && !(T3_ROUTER_CONNECTION_ID in connections)) {
    connections[T3_ROUTER_CONNECTION_ID] = {
      // The `/openai` prefix routes to the router's OpenAI-shaped surface;
      // its Anthropic surface lives under the same listener and harnesses
      // reach it by appending `/v1/messages`. The probe's
      // `GET {baseUrl}/models` lands on the OpenAI models list.
      baseUrl: `${routerBaseUrl}/openai`,
      protocols: ["openai", "anthropic"],
      displayName: "T3 Router",
    };
  }
  return connections as ModelBackendConnections;
};

/**
 * Layer that consumes `ProviderInstanceRegistryMutator` and forks a
 * settings-watcher fiber. The fiber's lifetime is tied to the enclosing
 * layer scope (process lifetime in production), so it is interrupted on
 * shutdown without leaking.
 *
 * Errors inside the watcher are logged and swallowed — the registry's own
 * "unavailable" bucket already absorbs unknown drivers and invalid
 * configs, so the only way the watcher could fail is a settings stream
 * tear-down, which logs and exits cleanly.
 */
const SettingsWatcherLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const mutator = yield* ProviderInstanceRegistryMutator;
    const serverSettings = yield* ServerSettingsService;
    // Required (not optional): the layer edge orders hydration after the
    // router bind, so the captured base URL is final. A single read at
    // build time is enough because the router binds once per process.
    const routerBaseUrl = (yield* ModelRouterProxy).baseUrl;
    const settingsChanges = yield* serverSettings.subscribeChanges;
    yield* settingsChanges.pipe(
      Stream.runForEach((next) =>
        mutator
          .reconcile(
            deriveProviderInstanceConfigMap(next),
            deriveRegistryConnections(next, routerBaseUrl),
            next.modelCredentials,
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
            ),
          ),
      ),
      Effect.forkScoped,
    );
  }),
);

/**
 * Hydrate `ProviderInstanceRegistry` from `ServerSettings` and keep it in
 * sync with subsequent `streamChanges` emissions.
 *
 * The Layer's two halves:
 *   - `ProviderInstanceRegistryMutableLayer` produces the registry +
 *     mutator from the initial config map. Its scope owns every
 *     per-instance child scope created during reconcile.
 *   - `SettingsWatcherLive` consumes the mutator, acquires its settings
 *     subscription before forking, and runs a daemon fiber in the same scope.
 *
 * Composing via `Layer.provideMerge` makes the watcher's deps available
 * from the mutable layer while still surfacing the registry as an output.
 * The mutator tag is technically also exposed; only this module imports
 * it, so the visibility leak is harmless in practice.
 */
export const ProviderInstanceRegistryHydrationLive: Layer.Layer<
  ProviderInstanceRegistry,
  never,
  BuiltInDriversEnv | ServerSettingsService | ModelRouterProxy
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const routerBaseUrl = (yield* ModelRouterProxy).baseUrl;
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : deriveProviderInstanceConfigMap(initialSettings);
    const initialConnections =
      initialSettings === undefined
        ? undefined
        : deriveRegistryConnections(initialSettings, routerBaseUrl);

    const mutableLayer = ProviderInstanceRegistryMutableLayer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
      // Omitted when settings are unavailable: reconcile normalizes an
      // absent map to "no connections" / "no credentials", same as the
      // `{}` decode defaults.
      ...(initialConnections === undefined ? {} : { connections: initialConnections }),
      ...(initialSettings?.modelCredentials === undefined
        ? {}
        : { credentials: initialSettings.modelCredentials }),
    });

    return SettingsWatcherLive.pipe(Layer.provideMerge(mutableLayer));
  }),
);
