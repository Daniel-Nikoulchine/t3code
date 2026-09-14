import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { KiloSettings, ProviderDriverKind } from "@t3tools/contracts";

import { KiloDriver } from "./KiloDriver.ts";

const decodeKiloSettings = Schema.decodeSync(KiloSettings);
const decodeKiloDriverConfig = Schema.decodeSync(KiloDriver.configSchema);

describe("Kilo driver registration", () => {
  it("registers the kilo driver kind with multi-instance support", () => {
    expect(KiloDriver.driverKind).toEqual(ProviderDriverKind.make("kilo"));
    expect(KiloDriver.metadata.displayName).toBe("Kilo");
    expect(KiloDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("decodes an empty config to the disabled-by-default Kilo settings", () => {
    const config = KiloDriver.defaultConfig();
    expect(config).toEqual(decodeKiloSettings({}));
    expect(config.enabled).toBe(false);
    expect(config.binaryPath).toBe("kilo");
  });

  it("round-trips driver config through the registered schema", () => {
    const decoded = decodeKiloDriverConfig({
      enabled: true,
      binaryPath: "/opt/bin/kilo",
    });
    expect(decoded.binaryPath).toBe("/opt/bin/kilo");
    expect(decoded.enabled).toBe(true);
  });
});
