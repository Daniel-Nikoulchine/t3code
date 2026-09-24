/**
 * MinimaxSkills — skill mention helpers for MiniMax.
 *
 * v1 returns no local skills: mcode skill roots are not mapped yet, and ACP
 * sessions surface slash commands natively. The stubs keep the adapter's
 * mention-rewrite path intact without advertising skills that do not exist.
 *
 * @module provider/Drivers/MinimaxSkills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const discoverMinimaxSkills = Effect.fn("discoverMinimaxSkills")(function* (
  _cwd?: string,
  _environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, never> {
  return [] as ReadonlyArray<ServerProviderSkill>;
});

export const probeMinimaxSkills = Effect.fn("probeMinimaxSkills")(function* (
  _cwd?: string,
  _environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, never> {
  return [] as ReadonlyArray<ServerProviderSkill>;
});

/** MiniMax invokes skills with `/name`; T3 composers insert `$name`. */
export function hasMinimaxSkillMention(_prompt: string): boolean {
  return false;
}

export function rewriteMinimaxSkillMentions(
  prompt: string,
  _skillNames: ReadonlySet<string>,
): string {
  return prompt;
}
