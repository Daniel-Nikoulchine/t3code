import {
  MODEL_CREDENTIAL_VALUE_REDACTED,
  type ModelCredential,
  type ModelRouterRoute,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addModelRouterRoute,
  describeRouteTarget,
  removeModelRouterRoute,
  toModelRouterRoute,
  updateModelRouterRoute,
  validateRouteConnectionTarget,
  validateRouteModelSlug,
  validateRouteTarget,
  validateRouteVendorTarget,
  type ModelRouterRouteDraft,
} from "./providerRouting.logic";

const draft = (overrides?: Partial<ModelRouterRouteDraft>): ModelRouterRouteDraft => ({
  modelSlug: "",
  targetKind: "connection",
  connectionId: "",
  vendor: "",
  credentialId: "",
  baseUrl: "",
  upstreamModel: "",
  ...overrides,
});

// Branded record keys cannot be written as plain literal keys in tests; the
// fixtures assert through casts like `providerBackend.logic.test.ts`.
const connections = {
  "glm-relay": { displayName: "GLM", baseUrl: "https://glm.example/v1" },
} as unknown as Record<string, unknown>;
const credentials = {
  "anthropic-work": {
    displayName: "Anthropic work key",
    vendor: "anthropic",
    value: MODEL_CREDENTIAL_VALUE_REDACTED,
    lastFour: "ab12",
  },
  spare: { displayName: "Spare", vendor: "openai", value: "" },
} as unknown as Record<string, ModelCredential>;

describe("validateRouteModelSlug", () => {
  it("requires a non-blank model id", () => {
    expect(validateRouteModelSlug("   ", {})).toContain("required");
    expect(validateRouteModelSlug("gpt-5.2", {})).toBeNull();
  });

  it("keeps slugs with dots, slashes, and colons valid", () => {
    expect(validateRouteModelSlug("openai/gpt-5.2:thinking", {})).toBeNull();
  });

  it("rejects a slug the map already routes, except the one being edited", () => {
    const routes = { "gpt-5.2": {} };
    expect(validateRouteModelSlug("gpt-5.2", routes)).toContain("already exists");
    expect(validateRouteModelSlug("gpt-5.2", routes, "gpt-5.2")).toBeNull();
    expect(validateRouteModelSlug("gpt-5.2", routes, "claude-sonnet-4")).toContain(
      "already exists",
    );
  });
});

describe("validateRouteConnectionTarget / validateRouteVendorTarget / validateRouteTarget", () => {
  it("requires an existing connection", () => {
    expect(validateRouteConnectionTarget("", connections)).toContain("Pick a connection");
    expect(validateRouteConnectionTarget("deleted", connections)).toContain("exists");
    expect(validateRouteConnectionTarget("glm-relay", connections)).toBeNull();
  });

  it("requires vendor slug, stored credential, and a base URL for custom vendors", () => {
    expect(
      validateRouteVendorTarget({ vendor: "", credentialId: "", baseUrl: "" }, credentials),
    ).toContain("Vendor is required");
    expect(
      validateRouteVendorTarget(
        { vendor: "anthropic", credentialId: "", baseUrl: "" },
        credentials,
      ),
    ).toContain("Pick a stored API key");
    expect(
      validateRouteVendorTarget(
        { vendor: "anthropic", credentialId: "gone", baseUrl: "" },
        credentials,
      ),
    ).toContain("exists");
    expect(
      validateRouteVendorTarget({ vendor: "glm", credentialId: "spare", baseUrl: "" }, credentials),
    ).toContain("Base URL is required");
    expect(
      validateRouteVendorTarget(
        { vendor: "glm", credentialId: "spare", baseUrl: "https://x/v1" },
        credentials,
      ),
    ).toBeNull();
    expect(
      validateRouteVendorTarget(
        { vendor: "anthropic", credentialId: "spare", baseUrl: "" },
        credentials,
      ),
    ).toBeNull();
  });

  it("validates whichever target kind the draft picked", () => {
    expect(
      validateRouteTarget(draft({ targetKind: "connection" }), connections, credentials),
    ).toContain("Pick a connection");
    expect(
      validateRouteTarget(draft({ targetKind: "vendor", vendor: "" }), connections, credentials),
    ).toContain("Vendor is required");
    expect(
      validateRouteTarget(
        draft({ targetKind: "connection", connectionId: "glm-relay" }),
        connections,
        credentials,
      ),
    ).toBeNull();
  });
});

describe("toModelRouterRoute", () => {
  it("trims fields and drops the blank upstream slug (pass the route key through)", () => {
    expect(
      toModelRouterRoute(
        draft({
          modelSlug: "  gpt-5.2  ",
          targetKind: "connection",
          connectionId: "  glm-relay  ",
          upstreamModel: "   ",
        }),
      ),
    ).toEqual({ target: { kind: "connection", connectionId: "glm-relay" } });
  });

  it("keeps a non-blank upstream model", () => {
    expect(
      toModelRouterRoute(
        draft({
          modelSlug: "gpt-5.2",
          targetKind: "vendor",
          vendor: "anthropic",
          credentialId: "anthropic-work",
          upstreamModel: "claude-sonnet-4",
        }),
      ),
    ).toEqual({
      target: { kind: "vendor", vendor: "anthropic", credentialId: "anthropic-work" },
      upstreamModel: "claude-sonnet-4",
    });
  });

  it("carries the base URL override for custom vendors and omits it for presets", () => {
    expect(
      toModelRouterRoute(
        draft({
          modelSlug: "m",
          targetKind: "vendor",
          vendor: "glm",
          credentialId: "spare",
          baseUrl: " https://x/v1 ",
        }),
      )?.target,
    ).toEqual({ kind: "vendor", vendor: "glm", credentialId: "spare", baseUrl: "https://x/v1" });
    expect(
      toModelRouterRoute(
        draft({ modelSlug: "m", targetKind: "vendor", vendor: "openai", credentialId: "spare" }),
      )?.target,
    ).toEqual({ kind: "vendor", vendor: "openai", credentialId: "spare" });
  });

  it("refuses a blank model id or an incomplete target", () => {
    expect(toModelRouterRoute(draft())).toBeUndefined();
    expect(
      toModelRouterRoute(draft({ modelSlug: "gpt-5.2", targetKind: "connection" })),
    ).toBeUndefined();
    expect(
      toModelRouterRoute(draft({ modelSlug: "gpt-5.2", targetKind: "vendor", vendor: "openai" })),
    ).toBeUndefined();
  });
});

describe("addModelRouterRoute / updateModelRouterRoute / removeModelRouterRoute", () => {
  const route = { target: { kind: "connection", connectionId: "glm-relay" } } as never;
  const existing = { "gpt-5.2": route } as Record<string, ModelRouterRoute>;

  it("adds one entry and leaves the others alone", () => {
    const next = addModelRouterRoute(existing, "claude-sonnet-4", route);
    expect(Object.keys(next).toSorted()).toEqual(["claude-sonnet-4", "gpt-5.2"]);
    expect(next["gpt-5.2"]).toBe(route);
  });

  it("replaces in place when the slug is unchanged", () => {
    const replacement = {
      target: { kind: "vendor", vendor: "openai", credentialId: "spare" },
    } as never;
    const next = updateModelRouterRoute(existing, "gpt-5.2", "gpt-5.2", replacement);
    expect(Object.keys(next)).toEqual(["gpt-5.2"]);
    expect(next["gpt-5.2"]).toBe(replacement);
  });

  it("moves the entry when the edit renames the slug", () => {
    const next = updateModelRouterRoute(existing, "gpt-5.2", "openai/gpt-5.2", route);
    expect(Object.keys(next)).toEqual(["openai/gpt-5.2"]);
  });

  it("removes one entry and leaves the others alone", () => {
    const two = addModelRouterRoute(existing, "claude-sonnet-4", route);
    expect(Object.keys(removeModelRouterRoute(two, "gpt-5.2"))).toEqual(["claude-sonnet-4"]);
  });
});

describe("describeRouteTarget", () => {
  it("names the connection by display name, falling back to the id", () => {
    expect(
      describeRouteTarget(
        { kind: "connection", connectionId: "glm-relay" } as never,
        connections as never,
        credentials,
      ),
    ).toBe("Connection: GLM");
    expect(
      describeRouteTarget(
        { kind: "connection", connectionId: "deleted" } as never,
        connections as never,
        credentials,
      ),
    ).toBe("Connection: deleted");
  });

  it("names the vendor, the billed credential, and its last four when stored", () => {
    expect(
      describeRouteTarget(
        { kind: "vendor", vendor: "anthropic", credentialId: "anthropic-work" } as never,
        connections as never,
        credentials,
      ),
    ).toBe("Anthropic key · Anthropic work key · ends in ab12");
    expect(
      describeRouteTarget(
        { kind: "vendor", vendor: "glm", credentialId: "gone" } as never,
        connections as never,
        credentials,
      ),
    ).toBe("glm key · gone");
  });
});
