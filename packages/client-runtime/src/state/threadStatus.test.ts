import { describe, expect, it } from "vite-plus/test";

import { resolveThreadStatusKind, type ThreadStatusShell } from "./threadStatus.ts";

function makeShell(overrides: Partial<ThreadStatusShell> = {}): ThreadStatusShell {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    backgroundLiveness: null,
    ...overrides,
  };
}

function sessionWith(status: "running" | "starting" | "error" | "ready") {
  return { status } as ThreadStatusShell["session"];
}

describe("resolveThreadStatusKind", () => {
  it("prioritizes approval over every other signal", () => {
    expect(
      resolveThreadStatusKind(
        makeShell({
          hasPendingApprovals: true,
          hasPendingUserInput: true,
          session: sessionWith("running"),
          backgroundLiveness: "working",
        }),
      ),
    ).toBe("approval");
  });

  it("prioritizes user input over running work", () => {
    expect(
      resolveThreadStatusKind(
        makeShell({ hasPendingUserInput: true, session: sessionWith("running") }),
      ),
    ).toBe("input");
  });

  it("splits running from starting so mobile keeps Working vs Connecting", () => {
    expect(resolveThreadStatusKind(makeShell({ session: sessionWith("running") }))).toBe("working");
    expect(resolveThreadStatusKind(makeShell({ session: sessionWith("starting") }))).toBe(
      "connecting",
    );
  });

  it("ranks failure above lingering background liveness", () => {
    expect(
      resolveThreadStatusKind(
        makeShell({ session: sessionWith("error"), backgroundLiveness: "working" }),
      ),
    ).toBe("failed");
  });

  it("falls through to background work and monitoring before ready", () => {
    expect(resolveThreadStatusKind(makeShell({ backgroundLiveness: "working" }))).toBe("working");
    expect(resolveThreadStatusKind(makeShell({ backgroundLiveness: "monitoring" }))).toBe(
      "monitoring",
    );
    expect(resolveThreadStatusKind(makeShell())).toBe("ready");
  });
});
