import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import {
  getExistingHarnessDrivers,
  resolveWizardNavigation,
} from "./AddProviderInstanceDialog.logic";

describe("getExistingHarnessDrivers", () => {
  it("counts default Harness slots even without explicit instances", () => {
    const drivers = getExistingHarnessDrivers(DEFAULT_UNIFIED_SETTINGS);
    expect(drivers.has(ProviderDriverKind.make("codex"))).toBe(true);
    expect(drivers.has(ProviderDriverKind.make("hermes"))).toBe(true);
  });

  it("counts disabled custom instances by driver rather than instance ID", () => {
    const drivers = getExistingHarnessDrivers({
      providers: {},
      providerInstances: {
        [ProviderInstanceId.make("work")]: {
          driver: ProviderDriverKind.make("hermes"),
          enabled: false,
        },
      },
    });
    expect([...drivers]).toEqual(["hermes"]);
    expect(drivers.has(ProviderDriverKind.make("codex"))).toBe(false);
  });

  it("does not block a Harness configured only on another device", () => {
    expect(getExistingHarnessDrivers({ providers: {}, providerInstances: {} }).size).toBe(0);
  });
});

describe("resolveWizardNavigation", () => {
  const invalidId = { instanceIdError: "Instance ID is required." };
  const validId = { instanceIdError: null };

  it("allows moving from Driver to Identity before the instance id is valid", () => {
    expect(resolveWizardNavigation(0, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
  });

  it("blocks Next from Identity to Config while the instance id is invalid", () => {
    expect(resolveWizardNavigation(1, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("stops a direct Driver-to-Config skip at Identity and surfaces its error", () => {
    expect(resolveWizardNavigation(0, 2, 3, invalidId)).toEqual({
      kind: "blocked",
      step: 1,
      error: "Instance ID is required.",
    });
  });

  it("allows advancing and skipping forward once the instance id is valid", () => {
    expect(resolveWizardNavigation(1, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, 2, 3, validId)).toEqual({ kind: "navigate", step: 2 });
  });

  it("always preserves backward Driver and Identity navigation", () => {
    expect(resolveWizardNavigation(2, 1, 3, invalidId)).toEqual({ kind: "navigate", step: 1 });
    expect(resolveWizardNavigation(2, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
    expect(resolveWizardNavigation(1, 0, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });

  it("blocks forward navigation and header skips for an existing Harness", () => {
    const validation = {
      instanceIdError: null,
      driverError: "This Harness already exists on this device.",
    };
    for (const [current, target] of [
      [0, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ]) {
      expect(resolveWizardNavigation(current!, target!, 3, validation)).toEqual({
        kind: "blocked",
        step: 0,
        error: validation.driverError,
      });
    }
    expect(resolveWizardNavigation(2, 0, 3, validation)).toEqual({ kind: "navigate", step: 0 });
    expect(resolveWizardNavigation(2, 1, 3, validation)).toEqual({ kind: "navigate", step: 1 });
  });

  it("clamps requested steps to the wizard bounds", () => {
    expect(resolveWizardNavigation(2, 8, 3, validId)).toEqual({ kind: "navigate", step: 2 });
    expect(resolveWizardNavigation(0, -1, 3, invalidId)).toEqual({ kind: "navigate", step: 0 });
  });
});
