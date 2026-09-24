import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as BackendLastVerified from "../backendLastVerified.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import * as ServerConfig from "../../config.ts";
import { ProviderRegistryLive } from "./ProviderRegistry.ts";

const verifiedInstanceId = ProviderInstanceId.make("codex");
const unverifiedInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

const makeSnapshot = (
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
): ServerProvider => ({
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const makeInstance = (snapshot: ServerProvider): ProviderInstance =>
  ({
    instanceId: snapshot.instanceId,
    driverKind: snapshot.driver,
    continuationIdentity: {
      driverKind: snapshot.driver,
      continuationKey: `${snapshot.driver}:instance:${snapshot.instanceId}`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: snapshot.driver,
            packageName: null,
          }),
        ),
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    adapter: {} as ProviderInstance["adapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  }) satisfies ProviderInstance;

describe("ProviderRegistry backend verification marker", () => {
  it.effect("stamps verified instances and leaves the rest untouched", () =>
    Effect.gen(function* () {
      const trackerContext = yield* Layer.build(BackendLastVerified.layer);
      const tracker = Context.get(trackerContext, BackendLastVerified.BackendLastVerified);
      yield* tracker.record(verifiedInstanceId);
      const expected = (yield* tracker.stamp(makeSnapshot(verifiedInstanceId, CODEX_DRIVER)))
        .backendLastVerifiedAt;
      assert.isDefined(expected);

      const verified = makeInstance(makeSnapshot(verifiedInstanceId, CODEX_DRIVER));
      const unverified = makeInstance(makeSnapshot(unverifiedInstanceId, CLAUDE_AGENT_DRIVER));
      const instanceRegistryLayer = Layer.succeed(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
        {
          getInstance: (id) =>
            Effect.succeed(
              id === verified.instanceId
                ? verified
                : id === unverified.instanceId
                  ? unverified
                  : undefined,
            ),
          listInstances: Effect.succeed([verified, unverified]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
        },
      );

      const providers = yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        return yield* registry.getProviders;
      }).pipe(
        Effect.provide(
          ProviderRegistryLive.pipe(
            Layer.provide(instanceRegistryLayer),
            Layer.provide(Layer.succeed(BackendLastVerified.BackendLastVerified, tracker)),
          ),
        ),
        Effect.scoped,
      );

      const byId = new Map(providers.map((provider) => [provider.instanceId, provider]));
      assert.strictEqual(byId.get(verifiedInstanceId)?.backendLastVerifiedAt, expected);
      assert.notProperty(byId.get(unverifiedInstanceId), "backendLastVerifiedAt");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-backend-verified-stamp-",
        }).pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(ModelManifest.layerTest),
        ),
      ),
    ),
  );

  it.effect("publishes unstamped snapshots without a tracker layer", () =>
    Effect.gen(function* () {
      const instance = makeInstance(makeSnapshot(verifiedInstanceId, CODEX_DRIVER));
      const instanceRegistryLayer = Layer.succeed(
        ProviderInstanceRegistry.ProviderInstanceRegistry,
        {
          getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
          listInstances: Effect.succeed([instance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
        },
      );

      const providers = yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        return yield* registry.getProviders;
      }).pipe(
        Effect.provide(ProviderRegistryLive.pipe(Layer.provide(instanceRegistryLayer))),
        Effect.scoped,
      );

      assert.strictEqual(providers.length, 1);
      assert.notProperty(providers[0], "backendLastVerifiedAt");
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-backend-verified-no-tracker-",
        }).pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(ModelManifest.layerTest),
        ),
      ),
    ),
  );
});
