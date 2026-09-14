import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_PRESET_LIST } from "./modelProviderPresets.ts";

describe("PROVIDER_PRESET_LIST", () => {
  it("ships the full nine-template picker list", () => {
    expect(PROVIDER_PRESET_LIST).toHaveLength(9);
  });

  it("keeps ids unique with non-empty labels and hints", () => {
    const ids = PROVIDER_PRESET_LIST.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESET_LIST) {
      expect(preset.label.trim().length).toBeGreaterThan(0);
      expect(preset.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it("ends every configured base URL at a /v1 path without a trailing slash", () => {
    const configured = PROVIDER_PRESET_LIST.filter((preset) => preset.baseUrl.length > 0);
    expect(configured.length).toBeGreaterThan(0);
    for (const preset of configured) {
      expect(preset.baseUrl.endsWith("/")).toBe(false);
      expect(preset.baseUrl.endsWith("/v1")).toBe(true);
    }
  });

  it("leaves the URL blank only for the custom slate and the generic gateway", () => {
    const blank = PROVIDER_PRESET_LIST.filter((preset) => preset.baseUrl.length === 0).map(
      (preset) => preset.id,
    );
    expect(blank.toSorted()).toEqual(["custom", "gateway"]);
  });

  it("marks keyless entries explicitly and names the key variable otherwise", () => {
    for (const preset of PROVIDER_PRESET_LIST) {
      if (preset.needsKey === false) {
        expect(preset.apiKeyEnv).toBeUndefined();
      }
      if (preset.apiKeyEnv !== undefined) {
        expect(preset.needsKey).toBe(true);
        expect(preset.apiKeyEnv.trim().length).toBeGreaterThan(0);
      }
    }
    // The generic gateway needs a key but every deployment names it
    // differently, so it stays keyless-shaped until the user types one.
    const gateway = PROVIDER_PRESET_LIST.find((preset) => preset.id === "gateway")!;
    expect(gateway.needsKey).toBe(true);
    expect(gateway.apiKeyEnv).toBeUndefined();
  });

  it("ships only OpenAI-compatible endpoints (no native Anthropic)", () => {
    for (const preset of PROVIDER_PRESET_LIST) {
      expect(preset.baseUrl.toLowerCase()).not.toContain("anthropic");
      if (preset.apiKeyEnv !== undefined) {
        expect(preset.apiKeyEnv.toLowerCase()).not.toContain("anthropic");
      }
    }
  });
});
