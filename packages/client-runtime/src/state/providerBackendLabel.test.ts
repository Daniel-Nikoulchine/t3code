import { describe, expect, it } from "vite-plus/test";

import { resolveProviderBackendLabel } from "./providerInstanceDisplay.ts";

describe("resolveProviderBackendLabel", () => {
  it("returns undefined without a snapshot", () => {
    expect(resolveProviderBackendLabel(undefined)).toBeUndefined();
  });

  it("returns undefined when the snapshot carries no backend (native default)", () => {
    expect(resolveProviderBackendLabel({})).toBeUndefined();
  });

  it("returns undefined for an explicit native backend", () => {
    expect(
      resolveProviderBackendLabel({ backend: { kind: "native", viaProxy: false } }),
    ).toBeUndefined();
  });

  it("returns the kind label for a proxied backend without a display name", () => {
    expect(
      resolveProviderBackendLabel({
        backend: { kind: "openai-compatible", viaProxy: true },
      }),
    ).toBe("OpenAI-compatible");
  });

  it("prefers the backend display name over the kind label", () => {
    expect(
      resolveProviderBackendLabel({
        backend: { kind: "openai-compatible", viaProxy: true, displayName: "OmniRoute" },
      }),
    ).toBe("OmniRoute");
  });

  it("falls back to the kind label for a blank display name", () => {
    expect(
      resolveProviderBackendLabel({
        backend: { kind: "openai-compatible", viaProxy: true, displayName: "   " },
      }),
    ).toBe("OpenAI-compatible");
  });

  it("returns undefined for a non-proxied backend even with a display name", () => {
    expect(
      resolveProviderBackendLabel({
        backend: { kind: "openai-compatible", viaProxy: false, displayName: "Proxy" },
      }),
    ).toBeUndefined();
  });
});
