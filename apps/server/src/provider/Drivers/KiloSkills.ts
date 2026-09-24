/**
 * KiloSkills — workspace-aware discovery and native invocation for Kilo.
 *
 * Walk mechanics (budget-tracked recursion, dedupe, failure reasons) live in
 * `SkillDiscovery`; this module owns Kilo's data: project roots plus the
 * user config root, the `name:`-first frontmatter mapping, and `/name`
 * invocation.
 *
 * @module provider/Drivers/KiloSkills
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

const SKILL_MENTION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const HAS_SKILL_MENTION_PATTERN = /(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?=\s|$)/;

interface KiloSkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
}

class KiloSkillsProbeError extends Schema.TaggedError<KiloSkillsProbeError>()(
  "KiloSkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    cwd: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Kilo skill discovery${location} was incomplete (${this.reason}).`;
  }
}

function parseSkillFrontmatter(contents: string | undefined): KiloSkillFrontmatter | undefined {
  if (contents === undefined) return {};
  const block = extractFrontmatterBlock(contents);
  if (block === undefined) return {};
  const record = parseFrontmatterRecord(block);
  if (record === undefined) return undefined;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

function toKiloSkill(
  input: SkillRecordInput<KiloSkillFrontmatter>,
): ServerProviderSkill | undefined {
  const frontmatter = input.frontmatter;
  const name = frontmatter?.name?.trim() || input.name;
  if (!frontmatter || !name) return undefined;
  return {
    name,
    path: input.skillPath,
    scope: input.scope,
    enabled: true,
    ...(frontmatter.name && frontmatter.name !== name ? { displayName: frontmatter.name } : {}),
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
    ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
  };
}

function buildKiloRoots(context: SkillRootsContext): ReadonlyArray<SkillRoot> {
  const { cwd, userHome, path } = context;
  const rootsBelow = (base: string, scope: "user" | "project") => [
    { directory: path.join(base, ".kilo", "skills"), scope },
    { directory: path.join(base, ".agents", "skills"), scope },
  ];
  return [
    ...(cwd ? rootsBelow(cwd, "project") : []),
    { directory: path.join(userHome, ".config", "kilo", "skills"), scope: "user" as const },
  ];
}

const inspectKiloSkills = Effect.fn("inspectKiloSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return yield* inspectSkills({
    cwd,
    environment,
    buildRoots: buildKiloRoots,
    parseFrontmatter: parseSkillFrontmatter,
    toSkill: toKiloSkill,
  });
});

export const discoverKiloSkills = Effect.fn("discoverKiloSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (yield* inspectKiloSkills(cwd, environment)).skills;
});

export const probeKiloSkills = Effect.fn("probeKiloSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const inspection = yield* inspectKiloSkills(cwd, environment);
  if (inspection.failureReason) {
    return yield* new KiloSkillsProbeError({
      reason: inspection.failureReason,
      ...(cwd ? { cwd } : {}),
    });
  }
  return inspection.skills;
});

/** Kilo invokes skills with `/name`; T3 composers insert `$name`. */
export function hasKiloSkillMention(prompt: string): boolean {
  return hasSkillMention(HAS_SKILL_MENTION_PATTERN, prompt);
}

export function rewriteKiloSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return rewriteSkillMentions(SKILL_MENTION_PATTERN, prompt, skillNames, (name) => `/${name}`);
}
