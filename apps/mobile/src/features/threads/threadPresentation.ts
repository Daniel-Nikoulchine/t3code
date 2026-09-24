import { resolveThreadStatusKind } from "@t3tools/client-runtime/state/thread-status";
import type { StatusTone } from "../../components/StatusPill";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "error";

export interface ThreadStatusPresentation extends StatusTone {
  readonly kind: ThreadStatusKind;
  /** Foreground color for the leading status icon. */
  readonly iconColor: string;
  /** Background color for the leading status icon circle. */
  readonly iconBackground: string;
  /** Whether the indicator represents in-flight activity. */
  readonly pulse: boolean;
}

/**
 * Resolves the user-facing status of a thread, in priority order. Returns
 * `null` for quiescent threads so rows stay free of "Idle"-style noise.
 * Decision delegates to the shared `resolveThreadStatusKind`; this adapter
 * only owns icon presentation plus the latestTurn error nuance.
 */
export function resolveThreadStatus(
  thread: EnvironmentThreadShell,
): ThreadStatusPresentation | null {
  switch (resolveThreadStatusKind(thread)) {
    case "approval":
      return {
        kind: "pending-approval",
        label: "Needs Approval",
        pillClassName: "bg-warning",
        textClassName: "text-warning-foreground",
        iconColor: "#ff9f0a",
        iconBackground: "rgba(255,159,10,0.22)",
        pulse: false,
      };
    case "input":
      return {
        kind: "awaiting-input",
        label: "Awaiting Input",
        pillClassName: "bg-primary/10",
        textClassName: "text-foreground-secondary",
        iconColor: "#5e5ce6",
        iconBackground: "rgba(94,92,230,0.22)",
        pulse: false,
      };
    case "working":
      return {
        kind: "working",
        label: "Working",
        pillClassName: "bg-primary/10",
        textClassName: "text-adaptive-sky-600-400",
        iconColor: "#0a84ff",
        iconBackground: "rgba(10,132,255,0.22)",
        pulse: true,
      };
    case "connecting":
      return {
        kind: "connecting",
        label: "Connecting",
        pillClassName: "bg-primary/10",
        textClassName: "text-foreground-secondary",
        iconColor: "#0a84ff",
        iconBackground: "rgba(10,132,255,0.22)",
        pulse: true,
      };
    case "monitoring":
      // No mobile presentation equivalent for passive watch loops; stays
      // quiet like before instead of manufacturing a Working pulse.
      return null;
    case "failed":
      break;
    case "ready":
      break;
  }

  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return {
      kind: "error",
      label: "Error",
      pillClassName: "bg-danger",
      textClassName: "text-danger-foreground",
      iconColor: "#ff453a",
      iconBackground: "rgba(255,69,58,0.22)",
      pulse: false,
    };
  }

  return null;
}
