import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultHarnessSelection } from "./ProjectDefaultsSettings.logic";

const hermes = ProviderInstanceId.make("hermes");
const codex = ProviderInstanceId.make("codex");

describe("resolveDefaultHarnessSelection", () => {
  it("keeps a model offered by the new harness and drops old model options", () => {
    const current = createModelSelection(codex, "shared", [
      { id: "reasoning_effort", value: "high" },
    ]);
    expect(
      resolveDefaultHarnessSelection(hermes, current, [
        { slug: "default", name: "Default", isDefault: true },
        { slug: "shared", name: "Shared" },
      ]),
    ).toEqual(createModelSelection(hermes, "shared"));
  });

  it("falls back to the harness default when the old model is unavailable", () => {
    expect(
      resolveDefaultHarnessSelection(hermes, createModelSelection(codex, "old"), [
        { slug: "old", name: "Old", isUnavailable: true },
        { slug: "first", name: "First" },
        { slug: "default", name: "Default", isDefault: true },
      ]),
    ).toEqual(createModelSelection(hermes, "default"));
  });

  it("uses the first available model when there is no usable default", () => {
    expect(
      resolveDefaultHarnessSelection(hermes, null, [
        { slug: "default", name: "Default", isDefault: true, isUnavailable: true },
        { slug: "custom", name: "Custom" },
      ]),
    ).toEqual(createModelSelection(hermes, "custom"));
  });

  it("preserves options when reselecting the current harness", () => {
    const current = createModelSelection(hermes, "shared", [
      { id: "reasoning_effort", value: "high" },
    ]);
    expect(
      resolveDefaultHarnessSelection(hermes, current, [{ slug: "shared", name: "Shared" }]),
    ).toBe(current);
  });

  it("does not invent a model for an empty or unavailable catalog", () => {
    expect(resolveDefaultHarnessSelection(hermes, null, [])).toBeNull();
    expect(
      resolveDefaultHarnessSelection(hermes, null, [
        { slug: "missing", name: "Missing", isUnavailable: true },
      ]),
    ).toBeNull();
  });
});
