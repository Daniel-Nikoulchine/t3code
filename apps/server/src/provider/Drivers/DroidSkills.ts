/**
 * DroidSkills — workspace-aware discovery and native invocation for Droid.
 *
 * Walk mechanics (budget-tracked recursion, dedupe, failure reasons) live in
 * `SkillDiscovery`; this module owns Droid's data: factory/agent roots, the
 * `user-invocable` frontmatter mapping with `enabled` stamping, the
 * money-safe mention pattern, and `/name` invocation. Linked skill libraries
 * are package boundaries: their own SKILL.md is read, the target tree never
 * walked.
 *
 * @module provider/Drivers/DroidSkills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  extractFrontmatterBlock,
  hasSkillMention,
  inspectSkills,
  parseFrontmatterBoolean,
  parseFrontmatterRecord,
  rewriteSkillMentions,
  type SkillRecordInput,
  type SkillRoot,
  type SkillRootsContext,
} from "./SkillDiscovery.ts";

const SKILL_MENTION_PATTERN =
  /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const HAS_SKILL_MENTION_PATTERN = new RegExp(SKILL_MENTION_PATTERN.source);

interface DroidSkillFrontmatter {
  readonly description?: string;
  readonly displayName?: string;
  readonly userInvocable?: boolean;
}

class DroidSkillsProbeError extends Schema.TaggedError<DroidSkillsProbeError>()(
  "DroidSkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    cwd: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Droid skill discovery${location} was incomplete (${this.reason}).`;
  }
}

function parseSkillFrontmatter(contents: string | undefined): DroidSkillFrontmatter | undefined {
  if (contents === undefined) return {};
  const block = extractFrontmatterBlock(contents);
  if (block === undefined) return {};
  const record = parseFrontmatterRecord(block);
  if (record === undefined) return undefined;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const displayName = typeof record.name === "string" ? record.name.trim() : "";
  return {
    ...(description ? { description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

function toDroidSkill(
  input: SkillRecordInput<DroidSkillFrontmatter>,
): ServerProviderSkill | undefined {
  const frontmatter = input.frontmatter;
  if (!frontmatter) return undefined;
  return {
    name: input.name,
    path: input.skillPath,
    scope: input.scope,
    enabled: frontmatter.userInvocable !== false,
    ...(frontmatter.displayName && frontmatter.displayName !== input.name
      ? { displayName: frontmatter.displayName }
      : {}),
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
  };
}

function buildDroidRoots(context: SkillRootsContext): ReadonlyArray<SkillRoot> {
  const { cwd, userHome, path } = context;
  const rootsBelow = (base: string, scope: "user" | "project") => [
    { directory: path.join(base, ".factory", "skills"), scope },
    { directory: path.join(base, ".agents", "skills"), scope },
    { directory: path.join(base, ".agent", "skills"), scope },
  ];
  return [...(cwd ? rootsBelow(cwd, "project") : []), ...rootsBelow(userHome, "user")];
}

const inspectDroidSkills = Effect.fn("inspectDroidSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return yield* inspectSkills({
    cwd,
    environment,
    buildRoots: buildDroidRoots,
    parseFrontmatter: parseSkillFrontmatter,
    toSkill: toDroidSkill,
    symlinkPolicy: "package-boundary",
  });
});

export const discoverDroidSkills = Effect.fn("discoverDroidSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (yield* inspectDroidSkills(cwd, environment)).skills;
});

export const probeDroidSkills = Effect.fn("probeDroidSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const inspection = yield* inspectDroidSkills(cwd, environment);
  if (inspection.failureReason) {
    return yield* new DroidSkillsProbeError({
      reason: inspection.failureReason,
      ...(cwd ? { cwd } : {}),
    });
  }
  return inspection.skills;
});

/** Droid invokes skills natively as `/name`; T3 composers insert `$name`. */
export function hasDroidSkillMention(prompt: string): boolean {
  return hasSkillMention(HAS_SKILL_MENTION_PATTERN, prompt);
}

export function rewriteDroidSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return rewriteSkillMentions(SKILL_MENTION_PATTERN, prompt, skillNames, (name) => `/${name}`);
}
