import * as Hash from "effect/Hash";

/**
 * The router listener lives in its own port band so a dev instance can never
 * self-collide: the dev runner derives the server (13773) and web (5733)
 * ports from the same `hash % 3000` formula over the worktree path (see
 * `scripts/dev-runner.ts`), so those bands span 5734..8733 and
 * 13774..16773. Starting the router band at 21773 keeps every derived port
 * disjoint from both.
 */
export const MODEL_ROUTER_PORT_BASE = 21773;
/** Same span as the dev runner's `MAX_HASH_OFFSET`, mirrored for symmetry. */
export const MODEL_ROUTER_PORT_SPAN = 3000;

/**
 * Deterministic loopback port for the model router, derived from the T3 home
 * base directory — the same role the dev runner's worktree-path hash plays
 * (stable across restarts, distinct between worktrees, since a worktree's
 * home is its gitignored `.t3`). Two servers sharing one home cannot both
 * bind; the loser disables its router instead of failing startup.
 */
export const deriveModelRouterPort = (baseDir: string): number =>
  MODEL_ROUTER_PORT_BASE + ((Hash.string(baseDir) >>> 0) % MODEL_ROUTER_PORT_SPAN) + 1;
