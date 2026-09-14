import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { PiDriver } from "./PiDriver.ts";

describe("PiDriver", () => {
  it("is registered as a built-in multi-instance driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("pi");
    expect(PiDriver.metadata).toEqual({ displayName: "Pi", supportsMultipleInstances: true });
  });

  it("defaults to an opt-in pi binary with an empty home", () => {
    expect(PiDriver.defaultConfig()).toEqual({
      enabled: false,
      binaryPath: "pi",
      homePath: "",
      customModels: [],
    });
  });
});
