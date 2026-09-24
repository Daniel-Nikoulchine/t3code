import { describe, expect, it } from "@effect/vitest";

import type { ModelBackendConnections, ProviderInstanceConfig } from "@t3tools/contracts";

import {
  orphanBackendConnectionId,
  resolveHarnessBaseEnv,
  resolveHarnessProcessEnv,
} from "./harnessMaterial.ts";

describe("resolveHarnessProcessEnv", () => {
  it("lets the backend overlay win over instance vars", () => {
    const { processEnv, instanceEnv, backendOverlay } = resolveHarnessProcessEnv({
      environment: [{ name: "OPENAI_BASE_URL", value: "http://instance/v1", sensitive: false }],
      backend: { kind: "openai-compatible", baseUrl: "http://backend/v1" },
      baseEnv: {},
    });
    expect(instanceEnv.OPENAI_BASE_URL).toBe("http://instance/v1");
    expect(backendOverlay.OPENAI_BASE_URL).toBe("http://backend/v1");
    expect(processEnv.OPENAI_BASE_URL).toBe("http://backend/v1");
  });

  it("stays native-shaped without a backend", () => {
    const { processEnv, backendOverlay } = resolveHarnessProcessEnv({
      environment: [{ name: "FOO", value: "bar", sensitive: false }],
      backend: undefined,
      baseEnv: { PATH: "/bin" },
    });
    expect(backendOverlay).toEqual({});
    expect(processEnv.FOO).toBe("bar");
    expect(processEnv.PATH).toBe("/bin");
  });

  it("does not mutate baseEnv", () => {
    const baseEnv = { OMNI_KEY: "secret" };
    resolveHarnessProcessEnv({
      environment: [{ name: "FOO", value: "bar", sensitive: false }],
      backend: {
        kind: "openai-compatible",
        baseUrl: "http://backend/v1",
        apiKeyEnv: "OMNI_KEY",
      },
      baseEnv,
    });
    expect(baseEnv).toEqual({ OMNI_KEY: "secret" });
  });

  it("matches the previous hand-spread route keys path", () => {
    const { processEnv } = resolveHarnessProcessEnv({
      environment: [],
      backend: { kind: "t3-router", baseUrl: "http://127.0.0.1:21774/openai" },
      baseEnv: {},
    });
    expect(processEnv.OPENAI_BASE_URL).toBe("http://127.0.0.1:21774/openai");
  });
});

describe("resolveHarnessBaseEnv", () => {
  it("returns baseEnv untouched without instance vars", () => {
    const baseEnv = { PATH: "/bin" };
    expect(resolveHarnessBaseEnv(undefined, baseEnv)).toBe(baseEnv);
  });
});

describe("orphanBackendConnectionId", () => {
  const entryWith = (
    connectionId: string | undefined,
  ): Pick<ProviderInstanceConfig, "connectionId"> =>
    (connectionId === undefined ? {} : { connectionId: connectionId as never }) as Pick<
      ProviderInstanceConfig,
      "connectionId"
    >;

  it("is undefined without a reference or with a live one", () => {
    const connections = {
      mine: { baseUrl: "http://mine/v1" },
    } as unknown as ModelBackendConnections;
    expect(orphanBackendConnectionId(entryWith(undefined), connections)).toBeUndefined();
    expect(orphanBackendConnectionId(entryWith("mine"), connections)).toBeUndefined();
  });

  it("names a deleted connection and a missing t3-router synthesis", () => {
    const connections = {} as ModelBackendConnections;
    expect(orphanBackendConnectionId(entryWith("deleted"), connections)).toBe("deleted");
    expect(orphanBackendConnectionId(entryWith("t3-router"), connections)).toBe("t3-router");
    expect(orphanBackendConnectionId(entryWith("deleted"), undefined)).toBe("deleted");
  });
});
