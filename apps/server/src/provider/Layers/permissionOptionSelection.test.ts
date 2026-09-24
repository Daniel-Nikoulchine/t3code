import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  selectAlwaysFirstAutoApprovedPermissionOption,
  selectKindBasedPermissionOptionId,
  selectSessionFirstAutoApprovedPermissionOption,
  selectSessionFirstPermissionOptionId,
} from "./permissionOptionSelection.ts";

const sessionRequest = {
  sessionId: "session",
  toolCall: { toolCallId: "tool-1", title: "Run command" },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
    { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

const genericRequest = {
  ...sessionRequest,
  options: [
    { optionId: "temporary", kind: "allow_once", name: "Temporarily allow" },
    { optionId: "permanent", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("permissionOptionSelection", () => {
  it("prefers session ids, then kind fallbacks", () => {
    expect(selectSessionFirstPermissionOptionId(sessionRequest, "accept")).toBe("allow_once");
    expect(selectSessionFirstPermissionOptionId(sessionRequest, "acceptForSession")).toBe(
      "allow_session",
    );
    expect(selectSessionFirstPermissionOptionId(sessionRequest, "decline")).toBe("deny");
    expect(selectSessionFirstPermissionOptionId(genericRequest, "accept")).toBe("temporary");
    expect(selectSessionFirstPermissionOptionId(genericRequest, "decline")).toBe("reject");
    expect(selectSessionFirstAutoApprovedPermissionOption(sessionRequest)).toBe("allow_session");
    expect(selectSessionFirstAutoApprovedPermissionOption(genericRequest)).toBe("temporary");
  });

  it("prefers always kinds for auto-approve", () => {
    expect(selectAlwaysFirstAutoApprovedPermissionOption(genericRequest)).toBe("permanent");
    expect(
      selectAlwaysFirstAutoApprovedPermissionOption({
        ...sessionRequest,
        options: [{ optionId: "once", kind: "allow_once", name: "Once" }],
      }),
    ).toBe("once");
  });

  it("falls back to allow_once when allow_always is omitted", () => {
    const missingAlways = {
      ...sessionRequest,
      options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject-once", kind: "reject_once", name: "Reject" },
      ],
    } satisfies EffectAcpSchema.RequestPermissionRequest;
    expect(selectKindBasedPermissionOptionId(missingAlways, "acceptForSession")).toBe("allow-once");
    expect(selectKindBasedPermissionOptionId(missingAlways, "accept")).toBe("allow-once");
    expect(selectKindBasedPermissionOptionId(missingAlways, "decline")).toBe("reject-once");
  });
});
