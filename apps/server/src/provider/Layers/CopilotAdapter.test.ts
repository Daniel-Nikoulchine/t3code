import { describe, expect, it } from "@effect/vitest";

import {
  getCopilotReasoningEffort,
  resolveCopilotAllowAllValue,
  selectCopilotAutoApprovedPermissionOption,
  selectCopilotPermissionOptionId,
} from "./CopilotAdapter.ts";

describe("resolveCopilotAllowAllValue", () => {
  it("enables allow-all for autonomous modes", () => {
    expect(resolveCopilotAllowAllValue("full-access")).toBe("on");
    expect(resolveCopilotAllowAllValue("auto")).toBe("on");
  });

  it("keeps prompting for supervised modes", () => {
    expect(resolveCopilotAllowAllValue("approval-required")).toBe("off");
    expect(resolveCopilotAllowAllValue("auto-accept-edits")).toBe("off");
  });
});

describe("getCopilotReasoningEffort", () => {
  it("reads the effort option (and the legacy reasoningEffort alias)", () => {
    expect(getCopilotReasoningEffort({ options: [{ id: "effort", value: "max" }] })).toBe("max");
    expect(getCopilotReasoningEffort({ options: [{ id: "reasoningEffort", value: "high" }] })).toBe(
      "high",
    );
  });

  it("normalizes case and rejects unknown levels", () => {
    expect(getCopilotReasoningEffort({ options: [{ id: "effort", value: "XHIGH" }] })).toBe(
      "xhigh",
    );
    expect(
      getCopilotReasoningEffort({ options: [{ id: "effort", value: "ultra" }] }),
    ).toBeUndefined();
    expect(getCopilotReasoningEffort(undefined)).toBeUndefined();
  });
});

describe("selectCopilotPermissionOptionId", () => {
  const request = {
    options: [
      { optionId: "allow_once", kind: "allow_once" },
      { optionId: "allow_always", kind: "allow_always" },
      { optionId: "deny", kind: "reject_once" },
    ],
  } as never;

  it("prefers session-wide approval for acceptForSession", () => {
    expect(selectCopilotPermissionOptionId(request, "acceptForSession")).toBe("allow_always");
  });

  it("prefers one-shot approval for accept", () => {
    expect(selectCopilotPermissionOptionId(request, "accept")).toBe("allow_once");
  });

  it("auto-approval picks a one-shot option when no session scope exists", () => {
    expect(selectCopilotAutoApprovedPermissionOption(request)).toBe("allow_once");
  });
});
