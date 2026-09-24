import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_PRESET_LIST } from "./modelProviderPresets.ts";

describe("PROVIDER_PRESET_LIST", () => {
  it("ships the provider templates with custom as the last option", () => {
    expect(PROVIDER_PRESET_LIST.map((preset) => preset.id)).toEqual([
      "openai",
      "xai",
      "deepseek",
      "opencode-zen",
      "opencode-go",
      "codebuff",
      "custom",
    ]);
  });

  it("keeps ids unique with non-empty labels", () => {
    const ids = PROVIDER_PRESET_LIST.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESET_LIST) {
      expect(preset.label.trim().length).toBeGreaterThan(0);
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

  it("leaves the URL blank only for the custom slate", () => {
    const blank = PROVIDER_PRESET_LIST.filter((preset) => preset.baseUrl.length === 0).map(
      (preset) => preset.id,
    );
    expect(blank.toSorted()).toEqual(["custom"]);
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
