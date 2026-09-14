import {
  EventId,
  ProviderInstanceId,
  TurnId,
  type FallbackCombo,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addComboTarget,
  comboModeForThread,
  deriveModelRerouteNotices,
  MAX_FALLBACK_COMBO_TARGETS,
  removeComboTarget,
  setComboStrategy,
} from "./fallbackCombo.ts";

const targetA: ModelSelection = {
  instanceId: ProviderInstanceId.make("opencode_personal"),
  model: "claude-sonnet-4-5",
};
const targetB: ModelSelection = {
  instanceId: ProviderInstanceId.make("opencode_proxy"),
  model: "gpt-5.4",
};
const targetC: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

const comboAB: FallbackCombo = {
  targets: [targetA, targetB],
  strategy: "priority",
  fallbackOn: ["rate-limit", "provider-error"],
};

describe("comboModeForThread", () => {
  it("treats absent and null combos as single mode", () => {
    expect(comboModeForThread(undefined)).toBe("single");
    expect(comboModeForThread(null)).toBe("single");
  });

  it("treats a set combo as combo mode", () => {
    expect(comboModeForThread(comboAB)).toBe("combo");
  });
});

describe("addComboTarget", () => {
  it("creates a priority combo from the first target", () => {
    const created = addComboTarget(undefined, targetA);
    expect(created?.targets).toEqual([targetA]);
    expect(created?.strategy).toBe("priority");
    expect(created?.fallbackOn).toContain("rate-limit");
  });

  it("appends a new target without mutating the input", () => {
    const next = addComboTarget(comboAB, targetC);
    expect(next?.targets).toEqual([targetA, targetB, targetC]);
    expect(comboAB.targets).toHaveLength(2);
  });

  it("ignores a duplicate target (same instance and model)", () => {
    expect(addComboTarget(comboAB, targetA)).toBeUndefined();
    expect(
      addComboTarget(comboAB, { instanceId: targetA.instanceId, model: targetA.model }),
    ).toBeUndefined();
  });

  it("refuses targets past the maximum", () => {
    expect(MAX_FALLBACK_COMBO_TARGETS).toBeGreaterThanOrEqual(2);
    let combo: FallbackCombo | undefined = addComboTarget(undefined, targetA);
    for (const target of [targetB, targetC]) {
      const next = combo ? addComboTarget(combo, target) : undefined;
      if (next) combo = next;
    }
    expect(combo?.targets).toHaveLength(MAX_FALLBACK_COMBO_TARGETS);
    const overflowTarget: ModelSelection = {
      instanceId: ProviderInstanceId.make("cline"),
      model: "extra-model",
    };
    expect(combo ? addComboTarget(combo, overflowTarget) : undefined).toBeUndefined();
  });
});

describe("removeComboTarget", () => {
  it("removes the indexed target and keeps the strategy", () => {
    const combo: FallbackCombo = {
      targets: [targetA, targetB, targetC],
      strategy: "lkgp",
      fallbackOn: ["rate-limit"],
    };
    const next = removeComboTarget(combo, 0);
    expect(next && next !== null ? next.targets : null).toEqual([targetB, targetC]);
    expect(next && next !== null ? next.strategy : null).toBe("lkgp");
  });

  it("collapses back to single when fewer than two targets remain", () => {
    expect(removeComboTarget(comboAB, 1)).toBeNull();
  });

  it("leaves the combo untouched for out-of-range indexes", () => {
    expect(removeComboTarget(comboAB, -1)).toBeUndefined();
    expect(removeComboTarget(comboAB, 2)).toBeUndefined();
    expect(removeComboTarget(undefined, 0)).toBeUndefined();
  });
});

describe("setComboStrategy", () => {
  it("replaces the strategy and keeps the targets", () => {
    const next = setComboStrategy(comboAB, "headroom");
    expect(next?.strategy).toBe("headroom");
    expect(next?.targets).toEqual([targetA, targetB]);
  });

  it("returns null without a combo", () => {
    expect(setComboStrategy(null, "lkgp")).toBeNull();
    expect(setComboStrategy(undefined, "lkgp")).toBeNull();
  });
});

describe("deriveModelRerouteNotices", () => {
  it("returns empty for threads without activities", () => {
    expect(deriveModelRerouteNotices([])).toEqual([]);
  });

  it("maps model.rerouted activities to per-turn notices", () => {
    const notices = deriveModelRerouteNotices([
      {
        id: EventId.make("evt-reroute-1"),
        kind: "model.rerouted",
        payload: { fromModel: "model-a", toModel: "model-b", reason: "rate-limit: 429" },
        turnId: TurnId.make("turn-1"),
      },
    ]);
    expect(notices).toEqual([
      {
        id: EventId.make("evt-reroute-1"),
        turnId: TurnId.make("turn-1"),
        fromModel: "model-a",
        toModel: "model-b",
        reason: "rate-limit: 429",
      },
    ]);
  });

  it("skips other activity kinds and malformed reroute payloads", () => {
    const notices = deriveModelRerouteNotices([
      { id: EventId.make("evt-1"), kind: "tool.updated", payload: {}, turnId: null },
      {
        id: EventId.make("evt-2"),
        kind: "model.rerouted",
        payload: { fromModel: "model-a", toModel: "   ", reason: "rate-limit" },
        turnId: null,
      },
      { id: EventId.make("evt-3"), kind: "model.rerouted", payload: null, turnId: null },
      {
        id: EventId.make("evt-4"),
        kind: "model.rerouted",
        payload: { fromModel: "model-a", toModel: "model-b", reason: "provider-error: 500" },
        turnId: null,
      },
    ]);
    expect(notices.map((notice) => notice.id)).toEqual(["evt-4"]);
  });
});
