import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  asksForAuthMethod,
  OPENAI_HARNESS_INSTANCE_ID,
  OPENAI_PRESET_ID,
  PROVIDER_OAUTH_TARGETS,
} from "./AddBackendConnectionDialog.logic";

describe("asksForAuthMethod", () => {
  it("asks for the OpenAI template while adding", () => {
    expect(asksForAuthMethod({ presetId: OPENAI_PRESET_ID, editing: false })).toBe(true);
  });

  it("skips the question for other templates", () => {
    expect(asksForAuthMethod({ presetId: "xai", editing: false })).toBe(false);
    expect(asksForAuthMethod({ presetId: undefined, editing: false })).toBe(false);
  });

  it("never asks while editing an existing connection", () => {
    expect(asksForAuthMethod({ presetId: OPENAI_PRESET_ID, editing: true })).toBe(false);
  });

  it("signs in the default Codex harness instance for OAuth", () => {
    expect(OPENAI_HARNESS_INSTANCE_ID).toBe(ProviderInstanceId.make("codex"));
  });

  it("targets the only two harnesses with in-app OAuth", () => {
    expect(PROVIDER_OAUTH_TARGETS.map((target) => target.dialogId)).toEqual([
      "openai-oauth",
      "claude-oauth",
    ]);
  });
});
