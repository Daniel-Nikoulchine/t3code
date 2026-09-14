/**
 * Pure state logic for thread-level fallback combos (`FallbackCombo` in
 * contracts' `orchestration.ts`): single-vs-combo mode, target list edits,
 * and deriving `model.rerouted` notices from thread activities. Shared by
 * web and mobile so both clients edit and render the same combo shape.
 * No rendering here — only data transitions the UIs persist through the
 * existing `thread.meta.update` path (`combo: null` clears back to a manual
 * `ModelSelection`).
 *
 * @module fallbackCombo
 */
import {
  DEFAULT_FALLBACK_STRATEGY,
  DEFAULT_FALLBACK_TRIGGERS,
  type FallbackCombo,
  type FallbackStrategy,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";

/** Upper bound for combo targets: primary plus fallbacks. Keeps the editor
 *  minimal; the contract itself imposes no maximum. */
export const MAX_FALLBACK_COMBO_TARGETS = 3;

export type FallbackComboMode = "single" | "combo";

/** Absent/null combo means manual `ModelSelection`, no fallback. */
export function comboModeForThread(combo: FallbackCombo | null | undefined): FallbackComboMode {
  return combo === null || combo === undefined ? "single" : "combo";
}

function comboTargetEquals(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null)
  );
}

/**
 * Append `target` to the combo, creating a `{ strategy: "priority" }` combo
 * when none exists. Returns `undefined` when nothing changes: the target is
 * already listed, or the combo is at {@link MAX_FALLBACK_COMBO_TARGETS}.
 * Never mutates the input.
 */
export function addComboTarget(
  combo: FallbackCombo | null | undefined,
  target: ModelSelection,
): FallbackCombo | undefined {
  if (combo === null || combo === undefined) {
    return {
      targets: [target],
      strategy: DEFAULT_FALLBACK_STRATEGY,
      fallbackOn: [...DEFAULT_FALLBACK_TRIGGERS],
    };
  }
  if (combo.targets.some((candidate) => comboTargetEquals(candidate, target))) {
    return undefined;
  }
  if (combo.targets.length >= MAX_FALLBACK_COMBO_TARGETS) return undefined;
  return { ...combo, targets: [...combo.targets, target] };
}

/**
 * Remove the target at `index`. Returns `null` (back to single) when fewer
 * than two targets would remain — a one-target combo can never fall back,
 * so it collapses to the manual selection. Out-of-range indexes leave the
 * combo untouched (`undefined`).
 */
export function removeComboTarget(
  combo: FallbackCombo | null | undefined,
  index: number,
): FallbackCombo | null | undefined {
  if (combo === null || combo === undefined) return undefined;
  if (!Number.isInteger(index) || index < 0 || index >= combo.targets.length) {
    return undefined;
  }
  const targets = combo.targets.filter((_, candidate) => candidate !== index);
  if (targets.length < 2) return null;
  return { ...combo, targets };
}

/** Replace the combo strategy; `null`/`undefined` in stays `null`. */
export function setComboStrategy(
  combo: FallbackCombo | null | undefined,
  strategy: FallbackStrategy,
): FallbackCombo | null {
  if (combo === null || combo === undefined) return null;
  return combo.strategy === strategy ? combo : { ...combo, strategy };
}

export interface ModelRerouteNotice {
  readonly id: string;
  readonly turnId: TurnId | null;
  readonly fromModel: string;
  readonly toModel: string;
  readonly reason: string;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Derive per-turn `model.rerouted` notices from thread activities. The
 * server appends one `model.rerouted` activity per fallback hop (payload
 * `{ fromModel, toModel, reason }`, same shape as the provider runtime
 * event); the timeline renders these as a small turn-header note. Unknown
 * kinds and malformed payloads are skipped so older/newer servers never
 * break the timeline.
 */
export function deriveModelRerouteNotices(
  activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "id" | "kind" | "payload" | "turnId">
  >,
): ReadonlyArray<ModelRerouteNotice> {
  const notices: ModelRerouteNotice[] = [];
  for (const activity of activities) {
    if (activity.kind !== "model.rerouted") continue;
    const payload =
      activity.payload !== null && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const fromModel = payload ? asTrimmedString(payload.fromModel) : null;
    const toModel = payload ? asTrimmedString(payload.toModel) : null;
    const reason = payload ? asTrimmedString(payload.reason) : null;
    if (!fromModel || !toModel || !reason) continue;
    notices.push({
      id: activity.id,
      turnId: activity.turnId,
      fromModel,
      toModel,
      reason,
    });
  }
  return notices;
}
