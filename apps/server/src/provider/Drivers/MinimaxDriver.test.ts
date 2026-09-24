import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { MinimaxDriver } from "./MinimaxDriver.ts";

describe("MinimaxDriver", () => {
  it("is registered as a built-in multi-instance driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("minimax");
    expect(MinimaxDriver.metadata).toEqual({
      displayName: "MiniMax",
      supportsMultipleInstances: true,
    });
  });

  it("defaults to an opt-in mcode binary", () => {
    expect(MinimaxDriver.defaultConfig()).toEqual({
      enabled: false,
      binaryPath: "mcode",
      customModels: [],
    });
  });
});
