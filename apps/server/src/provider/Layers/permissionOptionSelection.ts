/**
 * Shared permission-option selection for ACP adapters.
 *
 * Eleven adapters re-derived the same `allow_once` / `allow_always` lookup.
 * This module owns the three shapes that actually ship:
 * - session-first auto-approve (`allow_session` by id, then `allow_once` by id ?? kind)
 * - always-first auto-approve (`allow_always` by kind, then `allow_once` by kind)
 * - decision-based selection (preferred ids, then fallback kind)
 *
 * Adapters keep their thin `select<X>...` wrappers so existing imports/tests
 * don't churn; the behavior lives here exactly once.
 *
 * @module permissionOptionSelection
 */
import type { ProviderApprovalDecision } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

export type PermissionOption = {
  readonly optionId: string;
  readonly kind: string;
  readonly name?: string;
};

export type PermissionRequestLike = {
  readonly options: ReadonlyArray<PermissionOption>;
};

type Decidable = Exclude<ProviderApprovalDecision, "cancel">;

const trimId = (id: string | undefined): string | undefined => {
  const trimmed = id?.trim();
  return trimmed ? trimmed : undefined;
};

export const findPermissionOptionIdById = (
  request: PermissionRequestLike,
  optionId: string,
): string | undefined =>
  trimId(request.options.find((option) => option.optionId === optionId)?.optionId);

export const findPermissionOptionIdByKind = (
  request: PermissionRequestLike,
  kind: string,
): string | undefined => {
  const found = request.options.find((option) => option.kind === kind);
  return typeof found?.optionId === "string" ? trimId(found.optionId) : undefined;
};

export const findPermissionOptionIdByIdOrKind = (
  request: PermissionRequestLike,
  optionId: string,
  kind: string,
): string | undefined =>
  findPermissionOptionIdById(request, optionId) ?? findPermissionOptionIdByKind(request, kind);

/** `allow_session` (id) then `allow_once` (id ?? kind). */
export const selectSessionFirstAutoApprovedPermissionOption = (
  request: PermissionRequestLike,
): string | undefined =>
  findPermissionOptionIdById(request, "allow_session") ??
  findPermissionOptionIdByIdOrKind(request, "allow_once", "allow_once");

/** `allow_always` (kind) then `allow_once` (kind). */
export const selectAlwaysFirstAutoApprovedPermissionOption = (
  request: PermissionRequestLike,
): string | undefined =>
  findPermissionOptionIdByKind(request, "allow_always") ??
  findPermissionOptionIdByKind(request, "allow_once");

const preferredIdsForDecision = (decision: Decidable): ReadonlyArray<string> =>
  decision === "acceptForSession"
    ? ["allow_session", "allow_always"]
    : decision === "accept"
      ? ["allow_once"]
      : ["deny"];

const fallbackKindForDecision = (decision: Decidable): string =>
  decision === "acceptForSession"
    ? "allow_always"
    : decision === "accept"
      ? "allow_once"
      : "reject_once";

/** Preferred ids first, then fallback kind. Covers Cline/Copilot/Hermes/OpenClaw/Minimax/Droid/Kilo. */
export const selectSessionFirstPermissionOptionId = (
  request: PermissionRequestLike,
  decision: Decidable,
): string | undefined => {
  for (const id of preferredIdsForDecision(decision)) {
    const exact = findPermissionOptionIdById(request, id);
    if (exact) return exact;
  }
  return findPermissionOptionIdByKind(request, fallbackKindForDecision(decision));
};

/** Kind-based selection with `allow_once` fallback for `acceptForSession`. Covers Grok/DeepSeek. */
export const selectKindBasedPermissionOptionId = (
  request: PermissionRequestLike,
  decision: Decidable,
): string | undefined => {
  const preferredKind = fallbackKindForDecision(decision);
  const preferred = findPermissionOptionIdByKind(request, preferredKind);
  if (preferred) return preferred;
  // Grok/DeepSeek 4.6 often omit allow_always. T3 still offers "Always allow this session",
  // so fall back to allow_once instead of cancelling.
  if (decision === "acceptForSession") return findPermissionOptionIdByKind(request, "allow_once");
  return undefined;
};

/** Full ACP request shape stays compatible without importing schema types at call sites. */
export const asPermissionRequest = (
  request: EffectAcpSchema.RequestPermissionRequest,
): PermissionRequestLike => request;
