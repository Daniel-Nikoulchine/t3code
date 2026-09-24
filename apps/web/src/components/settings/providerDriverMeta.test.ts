import { PROVIDER_DISPLAY_NAMES, ProviderDriverKind } from "@t3tools/contracts";
import { MODEL_BINDING_BY_DRIVER } from "@t3tools/client-runtime/model-catalog";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import { getProviderLoginCommand } from "./providerLoginCommands";

describe("providerDriverMeta", () => {
  it("names the flagship CLIs after their harness", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")]!;
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")]!;
    expect(codex.label).toBe("Codex");
    expect(claude.label).toBe("Claude");
  });

  it("keeps every driver in the single harness catalog", () => {
    const values = DRIVER_OPTIONS.map((option) => option.value);
    for (const driver of [
      "codex",
      "claudeAgent",
      "pi",
      "openclaw",
      "hermes",
      "deepseek",
    ] as const) {
      const kind = ProviderDriverKind.make(driver);
      expect(values).toContain(kind);
      expect(getDriverOption(kind)).toBeDefined();
    }
  });

  /**
   * Presentation-table consistency — icons, settings meta, login commands
   * and the model-catalog binding are hand-maintained per driver on the web
   * side. `PROVIDER_DISPLAY_NAMES` (contracts) is the checklist: every
   * driver it names must be covered here, so the next driver cannot ship
   * with a missing icon, an unopenable settings card, or no login hint.
   * Server-side tables are pinned against the same checklist in
   * `apps/server/src/provider/providerCatalogConsistency.test.ts`.
   */
  it("covers every contracts-known driver in all presentation tables", () => {
    const knownDrivers = Object.keys(PROVIDER_DISPLAY_NAMES);
    expect(knownDrivers.length).toBeGreaterThan(0);

    const metaValues = new Set(DRIVER_OPTIONS.map((option) => String(option.value)));
    const iconKeys = new Set(Object.keys(PROVIDER_ICON_BY_PROVIDER));
    const bindingKeys = new Set(Object.keys(MODEL_BINDING_BY_DRIVER));
    for (const driver of knownDrivers) {
      expect(metaValues, `settings meta: ${driver}`).toContain(driver);
      expect(iconKeys, `icon: ${driver}`).toContain(driver);
      expect(bindingKeys, `model binding: ${driver}`).toContain(driver);
      // Antigravity signs in inside T3 Code and has no terminal command by design.
      const command = getProviderLoginCommand(ProviderDriverKind.make(driver));
      expect(command !== null || driver === "antigravity", `login command: ${driver}`).toBe(true);
    }
  });
});
