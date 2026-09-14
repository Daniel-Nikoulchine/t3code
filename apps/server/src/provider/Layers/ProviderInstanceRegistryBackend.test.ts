/**
 * Backend pass-through slice for `ProviderInstanceRegistryLive`.
 *
 * Resolution rule (single logic site in `ProviderInstanceRegistryLive`):
 * an instance routes through a `ServerSettings.modelBackendConnections`
 * entry only when its envelope names it via `connectionId` AND the entry
 * exists in the map. The registry synthesizes
 * `{ kind: "openai-compatible", baseUrl, ... }` and passes it to
 * `create({ ..., backend })` as before. Absent `connectionId` means
 * direct/native, and an orphan `connectionId` (pointing at a deleted
 * connection) silently stays native — the UI surfaces the hint.
 *
 * Two instances of the same driver (`cursor_native` direct,
 * `cursor_proxy` with `connectionId`) must materialize with different
 * harness environments, and changing/removing the reference or the
 * connection map must rebuild only affected instances.
 *
 * The harness env is observed through a delegating spy on
 * `checkCursorProviderStatus`: the driver binds its merged `processEnv` into
 * that closure at `create` time, so the spy records exactly what the
 * registry passed through `create({ ..., backend })`. Instances are told
 * apart by their configured `binaryPath`, never by capture order.
 *
 * Credential flow: a connection with `apiKeyCredentialId` resolves against
 * the `modelCredentials` map the registry receives from settings, and the
 * credential's value rides the synthesized backend as `apiKey`. A value
 * change or removal rebuilds exactly the instances whose resolved backend
 * carried it; empty and absent values (and the redaction sentinel) all
 * mean "no key".
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import type {
  ModelBackendConnectionId,
  ModelBackendConnections,
  ModelCredentials,
  ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import {
  ModelBackendConnectionId as ConnectionId,
  ModelCredentialId,
  ModelVendor,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { CursorSettings } from "@t3tools/contracts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

interface CapturedCheck {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv | undefined;
}

const captured = vi.hoisted(() => ({ checks: [] as Array<CapturedCheck> }));

vi.mock("./CursorProvider.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CursorProvider.ts")>();
  return {
    ...actual,
    checkCursorProviderStatus: (...args: Parameters<typeof actual.checkCursorProviderStatus>) => {
      captured.checks.push({ binaryPath: args[0].binaryPath, environment: args[1] });
      return actual.checkCursorProviderStatus(...args);
    },
  };
});

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  shouldRunScopeWork: () => Effect.succeed(false),
});

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "provider-instance-registry-backend-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

const BACKEND_BASE_URL = "http://127.0.0.1:20128/v1";
const ROTATED_BACKEND_BASE_URL = "http://127.0.0.1:20129/v1";
const UNRELATED_BACKEND_BASE_URL = "http://127.0.0.1:20130/v1";
const INSTANCE_BASE_URL = "http://instance:9999/v1";

const NATIVE_BINARY = "cursor-agent-native-stub";
const PROXY_BINARY = "cursor-agent-proxy-stub";

const nativeId = ProviderInstanceId.make("cursor_native");
const proxyId = ProviderInstanceId.make("cursor_proxy");
const cursorDriverKind = ProviderDriverKind.make("cursor");

const proxyConnId = ConnectionId.make("main-proxy");
const unrelatedConnId = ConnectionId.make("other-proxy");
const deletedConnId = ConnectionId.make("deleted-proxy");
const credentialId = ModelCredentialId.make("glm-key");

const makeConnections = (baseUrl: string): ModelBackendConnections => ({
  [proxyConnId]: { baseUrl, protocols: ["openai", "anthropic"] },
});
const CONNECTIONS = makeConnections(BACKEND_BASE_URL);
const ROTATED_CONNECTIONS = makeConnections(ROTATED_BACKEND_BASE_URL);

const CREDENTIAL_CONNECTIONS: ModelBackendConnections = {
  [proxyConnId]: {
    baseUrl: BACKEND_BASE_URL,
    protocols: ["openai", "anthropic"],
    apiKeyCredentialId: credentialId,
  },
};

const makeCredentials = (value: string): ModelCredentials => ({
  [credentialId]: { displayName: "GLM", vendor: ModelVendor.make("zhipu"), value },
});

const makeCursorConfig = (binaryPath: string): CursorSettings => ({
  enabled: false,
  binaryPath,
  apiEndpoint: "",
  customModels: [],
});

const makeConfigMap = (connectionRef: ModelBackendConnectionId | undefined) => {
  const configMap: ProviderInstanceConfigMap = {
    [nativeId]: {
      driver: cursorDriverKind,
      displayName: "Cursor (native)",
      enabled: false,
      environment: [{ name: "OPENAI_BASE_URL", value: INSTANCE_BASE_URL, sensitive: false }],
      config: makeCursorConfig(NATIVE_BINARY),
    },
    [proxyId]: {
      driver: cursorDriverKind,
      displayName: "Cursor (proxy)",
      enabled: false,
      environment: [{ name: "OPENAI_BASE_URL", value: INSTANCE_BASE_URL, sensitive: false }],
      ...(connectionRef === undefined ? {} : { connectionId: connectionRef }),
      config: makeCursorConfig(PROXY_BINARY),
    },
  };
  return configMap;
};

const envForBinary = (binaryPath: string): NodeJS.ProcessEnv | undefined =>
  captured.checks.findLast((check) => check.binaryPath === binaryPath)?.environment;

it.live("routes connectionId instances through the mapped connection", () =>
  Effect.gen(function* () {
    captured.checks.length = 0;
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [CursorDriver],
      configMap: makeConfigMap(proxyConnId),
      connections: CONNECTIONS,
    });

    const nativeEnv = envForBinary(NATIVE_BINARY);
    const proxyEnv = envForBinary(PROXY_BINARY);
    expect(nativeEnv?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);
    expect(proxyEnv?.OPENAI_BASE_URL).toBe(BACKEND_BASE_URL);
    expect(proxyEnv?.ANTHROPIC_BASE_URL).toBe(BACKEND_BASE_URL);

    const unavailable = yield* registry.listUnavailable;
    expect(unavailable).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("stays native when connectionId is set but no connection is configured", () =>
  Effect.gen(function* () {
    captured.checks.length = 0;
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [CursorDriver],
      configMap: makeConfigMap(proxyConnId),
      connections: {},
    });

    expect(envForBinary(NATIVE_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);

    const unavailable = yield* registry.listUnavailable;
    expect(unavailable).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("stays native when connections exist but the instance does not reference one", () =>
  Effect.gen(function* () {
    captured.checks.length = 0;
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [CursorDriver],
      configMap: makeConfigMap(undefined),
      connections: CONNECTIONS,
    });

    expect(envForBinary(NATIVE_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);

    const unavailable = yield* registry.listUnavailable;
    expect(unavailable).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("stays native when connectionId points at a deleted connection (orphan)", () =>
  Effect.gen(function* () {
    captured.checks.length = 0;
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [CursorDriver],
      // `deleted-proxy` is not in the map: orphan references silently route
      // natively (the UI surfaces the hint); the registry never errors.
      configMap: makeConfigMap(deletedConnId),
      connections: CONNECTIONS,
    });

    expect(envForBinary(NATIVE_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);

    const unavailable = yield* registry.listUnavailable;
    expect(unavailable).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("rebuilds only the instance whose connectionId or resolved connection changed", () =>
  Effect.gen(function* () {
    captured.checks.length = 0;
    const { registry, mutator } = yield* makeProviderInstanceRegistry({
      drivers: [CursorDriver],
      configMap: makeConfigMap(proxyConnId),
      connections: CONNECTIONS,
    });

    const nativeBefore = yield* registry.getInstance(nativeId);
    const proxyBefore = yield* registry.getInstance(proxyId);
    expect(nativeBefore).toBeDefined();
    expect(proxyBefore).toBeDefined();

    // Rotate the referenced connection URL: only the referencing instance
    // is rebuilt.
    yield* mutator.reconcile(makeConfigMap(proxyConnId), ROTATED_CONNECTIONS);
    const nativeRotated = yield* registry.getInstance(nativeId);
    const proxyRotated = yield* registry.getInstance(proxyId);
    expect(nativeRotated?.adapter).toBe(nativeBefore?.adapter);
    expect(proxyRotated?.adapter).not.toBe(proxyBefore?.adapter);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_BASE_URL).toBe(ROTATED_BACKEND_BASE_URL);
    expect(envForBinary(NATIVE_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);

    // Touch an unrelated connection: no instance is rebuilt.
    yield* mutator.reconcile(makeConfigMap(proxyConnId), {
      ...ROTATED_CONNECTIONS,
      [unrelatedConnId]: { baseUrl: UNRELATED_BACKEND_BASE_URL },
    });
    const nativeUnrelated = yield* registry.getInstance(nativeId);
    const proxyUnrelated = yield* registry.getInstance(proxyId);
    expect(nativeUnrelated?.adapter).toBe(nativeBefore?.adapter);
    expect(proxyUnrelated?.adapter).toBe(proxyRotated?.adapter);

    // Remove the reference: the proxy instance falls back to native env,
    // the untouched native instance keeps its closures.
    yield* mutator.reconcile(makeConfigMap(undefined), ROTATED_CONNECTIONS);
    const nativeRemoved = yield* registry.getInstance(nativeId);
    const proxyRemoved = yield* registry.getInstance(proxyId);
    expect(nativeRemoved?.adapter).toBe(nativeBefore?.adapter);
    expect(proxyRemoved?.adapter).not.toBe(proxyUnrelated?.adapter);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);
  }).pipe(Effect.provide(testLayer)),
);

it.live("falls back to native when the referenced connection is deleted", () =>
  Effect.gen(function* () {
    captured.checks.length = 0;
    const { registry, mutator } = yield* makeProviderInstanceRegistry({
      drivers: [CursorDriver],
      configMap: makeConfigMap(proxyConnId),
      connections: CONNECTIONS,
    });

    const nativeBefore = yield* registry.getInstance(nativeId);
    const proxyBefore = yield* registry.getInstance(proxyId);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_BASE_URL).toBe(BACKEND_BASE_URL);

    // Delete the referenced connection while the envelope still names it:
    // the affected instance rebuilds onto native, the direct one is kept.
    yield* mutator.reconcile(makeConfigMap(proxyConnId), {});
    const nativeAfter = yield* registry.getInstance(nativeId);
    const proxyAfter = yield* registry.getInstance(proxyId);
    expect(nativeAfter?.adapter).toBe(nativeBefore?.adapter);
    expect(proxyAfter?.adapter).not.toBe(proxyBefore?.adapter);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);
    expect(envForBinary(NATIVE_BINARY)?.OPENAI_BASE_URL).toBe(INSTANCE_BASE_URL);

    const unavailable = yield* registry.listUnavailable;
    expect(unavailable).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("attaches the referenced credential value as the instance backend apiKey", () =>
  Effect.gen(function* () {
    captured.checks.length = 0;
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [CursorDriver],
      configMap: makeConfigMap(proxyConnId),
      connections: CREDENTIAL_CONNECTIONS,
      credentials: makeCredentials("sk-glm-secret"),
    });

    expect(envForBinary(PROXY_BINARY)?.OPENAI_API_KEY).toBe("sk-glm-secret");
    expect(envForBinary(PROXY_BINARY)?.ANTHROPIC_API_KEY).toBe("sk-glm-secret");
    expect(envForBinary(NATIVE_BINARY)?.OPENAI_API_KEY).toBeUndefined();

    const unavailable = yield* registry.listUnavailable;
    expect(unavailable).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.live("rebuilds only the referencing instance when the credential value changes", () =>
  Effect.gen(function* () {
    captured.checks.length = 0;
    const { registry, mutator } = yield* makeProviderInstanceRegistry({
      drivers: [CursorDriver],
      configMap: makeConfigMap(proxyConnId),
      connections: CREDENTIAL_CONNECTIONS,
      credentials: makeCredentials("sk-glm-secret"),
    });

    const nativeBefore = yield* registry.getInstance(nativeId);
    const proxyBefore = yield* registry.getInstance(proxyId);

    yield* mutator.reconcile(
      makeConfigMap(proxyConnId),
      CREDENTIAL_CONNECTIONS,
      makeCredentials("sk-glm-rotated"),
    );

    const nativeRotated = yield* registry.getInstance(nativeId);
    const proxyRotated = yield* registry.getInstance(proxyId);
    expect(nativeRotated?.adapter).toBe(nativeBefore?.adapter);
    expect(proxyRotated?.adapter).not.toBe(proxyBefore?.adapter);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_API_KEY).toBe("sk-glm-rotated");
    expect(envForBinary(NATIVE_BINARY)?.OPENAI_API_KEY).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

it.live("drops the apiKey when the referenced credential is emptied, deleted, or redacted", () =>
  Effect.gen(function* () {
    captured.checks.length = 0;
    const { registry, mutator } = yield* makeProviderInstanceRegistry({
      drivers: [CursorDriver],
      configMap: makeConfigMap(proxyConnId),
      connections: CREDENTIAL_CONNECTIONS,
      credentials: makeCredentials("sk-glm-secret"),
    });

    const proxyBefore = yield* registry.getInstance(proxyId);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_API_KEY).toBe("sk-glm-secret");

    // An empty value means "no key": the instance rebuilds without one.
    yield* mutator.reconcile(
      makeConfigMap(proxyConnId),
      CREDENTIAL_CONNECTIONS,
      makeCredentials(""),
    );
    const proxyEmptied = yield* registry.getInstance(proxyId);
    expect(proxyEmptied?.adapter).not.toBe(proxyBefore?.adapter);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_API_KEY).toBeUndefined();

    // Deleting the credential resolves to the same keyless backend as an
    // empty value, so no instance churns.
    yield* mutator.reconcile(makeConfigMap(proxyConnId), CREDENTIAL_CONNECTIONS, {});
    const proxyDeleted = yield* registry.getInstance(proxyId);
    expect(proxyDeleted?.adapter).toBe(proxyEmptied?.adapter);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_API_KEY).toBeUndefined();

    // The redaction sentinel is never mistaken for a real key.
    yield* mutator.reconcile(
      makeConfigMap(proxyConnId),
      CREDENTIAL_CONNECTIONS,
      makeCredentials("\u2022\u2022\u2022\u2022\u2022\u2022"),
    );
    const proxySentinel = yield* registry.getInstance(proxyId);
    expect(proxySentinel?.adapter).toBe(proxyDeleted?.adapter);
    expect(envForBinary(PROXY_BINARY)?.OPENAI_API_KEY).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);
