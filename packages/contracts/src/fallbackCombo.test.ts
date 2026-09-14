import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { FallbackCombo } from "./fallbackCombo.ts";

const decodeFallbackCombo = Schema.decodeUnknownSync(FallbackCombo);

describe("FallbackCombo", () => {
  it("decodes a combo with two targets and the priority strategy", () => {
    const decoded = decodeFallbackCombo({
      targets: [
        { instanceId: "opencode_personal", model: "claude-sonnet-4-5" },
        { provider: "opencode", model: "x" },
      ],
      strategy: "priority",
    });
    expect(decoded.targets).toHaveLength(2);
    expect(decoded.targets[0]?.instanceId).toBe("opencode_personal");
    expect(decoded.targets[0]?.model).toBe("claude-sonnet-4-5");
    expect(decoded.targets[1]?.instanceId).toBe("opencode");
    expect(decoded.targets[1]?.model).toBe("x");
    expect(decoded.strategy).toBe("priority");
  });

  it("rejects an empty targets array", () => {
    expect(() => decodeFallbackCombo({ targets: [], strategy: "priority" })).toThrow();
  });

  it("rejects an unknown strategy", () => {
    expect(() =>
      decodeFallbackCombo({
        targets: [{ instanceId: "opencode_personal", model: "x" }],
        strategy: "fusion",
      }),
    ).toThrow();
  });

  it("rejects triggers outside the fallback vocabulary", () => {
    for (const trigger of ["user-rejected", "validation", "cost-optimized"]) {
      expect(() =>
        decodeFallbackCombo({
          targets: [{ instanceId: "opencode_personal", model: "x" }],
          strategy: "priority",
          fallbackOn: [trigger],
        }),
      ).toThrow();
    }
  });

  it("defaults strategy and fallbackOn when absent", () => {
    const decoded = decodeFallbackCombo({
      targets: [{ instanceId: "opencode_personal", model: "x" }],
    });
    expect(decoded.strategy).toBe("priority");
    expect(decoded.fallbackOn).toEqual(["rate-limit", "provider-error"]);
  });
});
