import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ModelBackendKind, ModelProxyProtocol } from "./modelBackend.ts";
import { ModelRouterRoute, ModelRouterRoutes, T3_ROUTER_CONNECTION_ID } from "./modelRouter.ts";

const decodeRoutes = Schema.decodeUnknownSync(ModelRouterRoutes);
const decodeRoute = Schema.decodeUnknownSync(ModelRouterRoute);
const decodeKind = Schema.decodeUnknownSync(ModelBackendKind);
const decodeProtocol = Schema.decodeUnknownSync(ModelProxyProtocol);

describe("ModelRouterRouteTarget", () => {
  it("decodes a connection target", () => {
    const route = decodeRoute({ target: { kind: "connection", connectionId: "main-proxy" } });
    expect(route.target).toEqual({ kind: "connection", connectionId: "main-proxy" });
    expect(route.upstreamModel).toBeUndefined();
  });

  it("decodes a vendor target with an optional baseUrl override", () => {
    const route = decodeRoute({
      target: { kind: "vendor", vendor: "anthropic", credentialId: "key1" },
    });
    expect(route.target).toMatchObject({
      kind: "vendor",
      vendor: "anthropic",
      credentialId: "key1",
    });
    const overridden = decodeRoute({
      target: {
        kind: "vendor",
        vendor: "glm",
        credentialId: "key1",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      },
    });
    expect(overridden.target.kind === "vendor" ? overridden.target.baseUrl : undefined).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
  });

  it("rejects a vendor target without a credential reference", () => {
    expect(() => decodeRoute({ target: { kind: "vendor", vendor: "openai" } })).toThrow();
  });

  it("rejects unknown target kinds", () => {
    expect(() => decodeRoute({ target: { kind: "passthrough", connectionId: "x" } })).toThrow();
  });
});

describe("ModelRouterRoutes", () => {
  it("accepts model slugs with dots, slashes, and colons as keys", () => {
    const routes = decodeRoutes({
      "claude-sonnet-4-5": { target: { kind: "connection", connectionId: "main" } },
      "openai/gpt-5.2": { target: { kind: "vendor", vendor: "openai", credentialId: "k" } },
      "vertex:gemini-3-pro": { target: { kind: "vendor", vendor: "google", credentialId: "k" } },
    });
    expect(Object.keys(routes).sort()).toEqual([
      "claude-sonnet-4-5",
      "openai/gpt-5.2",
      "vertex:gemini-3-pro",
    ]);
  });

  it("rejects a blank route key", () => {
    expect(() =>
      decodeRoutes({ " ": { target: { kind: "connection", connectionId: "main" } } }),
    ).toThrow();
  });

  it("round-trips upstreamModel overrides", () => {
    const routes = decodeRoutes({
      fast: {
        target: { kind: "vendor", vendor: "deepseek", credentialId: "k" },
        upstreamModel: "deepseek-chat",
      },
    });
    expect(routes["fast"]?.upstreamModel).toBe("deepseek-chat");
  });
});

describe("ModelBackendKind", () => {
  it("accepts the built-in t3-router kind", () => {
    expect(decodeKind("t3-router")).toBe("t3-router");
    expect(decodeKind("native")).toBe("native");
    expect(decodeKind("openai-compatible")).toBe("openai-compatible");
    expect(() => decodeKind("router")).toThrow();
  });
});

describe("ModelProxyProtocol", () => {
  it("stays limited to openai and anthropic", () => {
    expect(decodeProtocol("openai")).toBe("openai");
    expect(decodeProtocol("anthropic")).toBe("anthropic");
    expect(() => decodeProtocol("google")).toThrow();
  });
});

describe("T3_ROUTER_CONNECTION_ID", () => {
  it("is the reserved t3-router slug and a valid connection id shape", () => {
    expect(T3_ROUTER_CONNECTION_ID).toBe("t3-router");
    expect(T3_ROUTER_CONNECTION_ID).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });
});
