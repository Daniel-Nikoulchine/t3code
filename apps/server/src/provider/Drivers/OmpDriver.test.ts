import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OmpSettings, ProviderDriverKind } from "@t3tools/contracts";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { OmpDriver } from "./OmpDriver.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

describe("OmpDriver", () => {
  it("is registered as a built-in driver", () => {
    const registered = BUILT_IN_DRIVERS.find(
      (driver) => driver.driverKind === ProviderDriverKind.make("omp"),
    );
    expect(registered).toBe(OmpDriver);
    expect(OmpDriver.metadata.displayName).toBe("Oh My Pi");
    expect(OmpDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("decodes a blank config to opt-in-safe defaults", () => {
    const defaults = OmpDriver.defaultConfig();
    expect(defaults.enabled).toBe(false);
    expect(defaults.binaryPath).toBe("omp");
    expect(defaults.thinkingLevel).toBe("low");
    expect(Schema.decodeSync(OmpDriver.configSchema)(decodeOmpSettings({}))).toEqual(defaults);
  });

  it("decodes explicit instance config", () => {
    const settings = Schema.decodeSync(OmpDriver.configSchema)({
      enabled: true,
      binaryPath: "pi",
      agentDir: "~/.pi/agent",
      provider: "anthropic",
      model: "anthropic/opus",
      thinkingLevel: "high",
    });
    expect(settings.binaryPath).toBe("pi");
    expect(settings.provider).toBe("anthropic");
    expect(settings.model).toBe("anthropic/opus");
    expect(settings.thinkingLevel).toBe("high");
  });
});
