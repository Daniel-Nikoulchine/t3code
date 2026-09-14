import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Copilot skill discovery.
 *
 * Copilot loads skills from project (`.github/skills/`, `.agents/skills/`,
 * `.claude/skills/`), personal (`~/.copilot/skills/`, `~/.agents/skills/`),
 * plugins, and custom directories (`copilot skill add`). Skills surface over
 * ACP as `/SKILL-NAME` entries in `available_commands_update`, so session
 * prompts can invoke them as `/name` without local rewriting.
 *
 * For V1 the provider snapshot carries no workspace skills — slash commands
 * from ACP discovery are the source of truth. These helpers exist so the
 * adapter keeps the same call sites as other ACP providers; they are
 * intentionally trivial until file-based discovery lands.
 */
export const discoverCopilotSkills = (
  _cwd?: string,
  _environment?: NodeJS.ProcessEnv,
): Effect.Effect<ReadonlyArray<ServerProviderSkill>, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.succeed([]);

export function hasCopilotSkillMention(_prompt: string): boolean {
  return false;
}

export function rewriteCopilotSkillMentions(
  prompt: string,
  _skillNames: ReadonlySet<string>,
): string {
  return prompt;
}
