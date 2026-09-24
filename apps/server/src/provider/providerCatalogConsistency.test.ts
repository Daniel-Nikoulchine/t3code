import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
} from "@t3tools/contracts";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import { BUILT_IN_DRIVER_ORDER } from "./providerStatusCache.ts";

/**
 * Catalog consistency — the provider catalog is scattered across one
 * registry plus several lookup tables (sort order, default models, display
 * names). Nothing in the type system ties them together, so drivers have
 * shipped half-registered (unranked, unlabeled, or missing defaults).
 * These tests pin the sets against each other: adding a driver to
 * `BUILT_IN_DRIVERS` fails loudly until every table knows it.
 *
 * Web/mobile presentation tables (icons, settings meta, login commands)
 * are pinned on their own side against `PROVIDER_DISPLAY_NAMES` — see
 * `apps/web/src/components/settings/providerDriverMeta.test.ts`.
 */
const driverKinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);

describe("provider catalog consistency", () => {
  it("ranks every built-in driver in presentation order", () => {
    expect(new Set(BUILT_IN_DRIVER_ORDER)).toEqual(new Set(driverKinds));
  });

  it("declares a chat default model per built-in driver", () => {
    for (const kind of driverKinds) {
      expect(DEFAULT_MODEL_BY_PROVIDER[kind], kind).toBeDefined();
    }
  });

  it("declares a display name per built-in driver", () => {
    for (const kind of driverKinds) {
      expect(PROVIDER_DISPLAY_NAMES[kind], kind).toBeDefined();
    }
  });

  it("keeps no stale text-generation defaults for unknown drivers", () => {
    for (const kind of Object.keys(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER)) {
      expect(driverKinds, kind).toContain(kind);
    }
  });

  it("documents which drivers rely on the text-generation fallback chain", () => {
    // `serverSettings` resolves text-generation models as text-gen default
    // ?? chat default ?? global default. Only grok rides the fallback
    // (its session model doubles as the text-generation model); every
    // other driver declares its own entry.
    const missing = driverKinds.filter(
      (kind) => DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[kind] === undefined,
    );
    expect(missing).toEqual(["grok"]);
  });
});
