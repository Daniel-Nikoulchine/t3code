export type LatestTurnTiming = {
  readonly turnId: string | null;
  /** Set when the turn is created; `startedAt` waits for the provider. */
  readonly requestedAt?: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

export type SessionActivityState = {
  readonly status: string;
  readonly activeTurnId?: string | null;
};

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * Whether the latest turn is over. Deliberately settled on `completedAt`
 * alone, without requiring `startedAt`: the projector backfills `startedAt`
 * whenever it stamps `completedAt`, so a completed-without-started turn can
 * only come from shell/legacy data — and that work IS over, so the working
 * indicator must stop. (Requiring `startedAt` instead would pin such rows
 * as forever-working.) A running session keeps an unfinished turn
 * unsettled; without session info a completed turn counts as settled.
 */
export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.completedAt) return false;
  if (!session) return true;
  if (session.status === "running") return false;
  return true;
}

/**
 * When the working indicator should be counting, and from when. Single
 * owner for web and mobile (the web copy lived in `session-logic.ts` with
 * the same shape but no `requestedAt` floor and an extra user-message
 * fallback, now merged here).
 *
 * `requestedAt` is the floor for an unsettled turn. The projector only stamps
 * `startedAt` in the same update that moves the session to "running", so while
 * the provider spins up (session "starting") a requested turn has no
 * `startedAt` at all — and returning null there blinks the indicator out for
 * the whole spin-up. A settled turn still falls through to `sendStartedAt`, so
 * this cannot leave the indicator counting after the work is done.
 * `latestUserMessageAt` is the last resort when neither the turn nor the
 * local send has a timestamp (web composer); callers without it pass null.
 */
export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
  latestUserMessageAt: string | null = null,
): string | null {
  const runningTurnId = session?.status === "running" ? (session.activeTurnId ?? null) : null;
  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? latestTurn.requestedAt ?? sendStartedAt ?? latestUserMessageAt;
    }
    return sendStartedAt ?? latestUserMessageAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? latestTurn?.requestedAt ?? sendStartedAt ?? latestUserMessageAt;
  }
  return sendStartedAt;
}
