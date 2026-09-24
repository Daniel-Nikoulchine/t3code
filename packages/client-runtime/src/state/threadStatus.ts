import type { OrchestrationThreadShell } from "@t3tools/contracts";

/**
 * Shared Thread status decision behind one small interface.
 *
 * Web (`resolveSidebarThreadStatus`, `resolveThreadStatusPill`) and mobile
 * (`resolveThreadListV2Status`, `resolveThreadStatus`) spelled the same
 * priority three times; mobile silently dropped `backgroundLiveness`.
 * Callers keep their presentation adapters (pill classes, icon colors,
 * list badges) and delegate the decision here.
 */
export type ThreadStatusKind =
  | "approval"
  | "input"
  | "working"
  | "connecting"
  | "failed"
  | "monitoring"
  | "ready";

export type ThreadStatusShell = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "session" | "backgroundLiveness"
>;

/**
 * Priority: approval > input > running > starting > failed > background
 * working > monitoring > ready. A failed session outranks lingering
 * background liveness so the user sees the failure, not stale Working.
 */
export function resolveThreadStatusKind(thread: ThreadStatusShell): ThreadStatusKind {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.session?.status === "running") return "working";
  if (thread.session?.status === "starting") return "connecting";
  if (thread.session?.status === "error") return "failed";
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  return "ready";
}
