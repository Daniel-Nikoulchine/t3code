/**
 * HermesSkills — user-global discovery and native invocation for Hermes.
 *
 * Hermes keeps skills in `SKILL.md` files below `<hermesHome>/skills`, either
 * flat (`ask-matt/SKILL.md`) or grouped in category buckets
 * (`autonomous-ai-agents/t3-code/SKILL.md`). The home honors `HERMES_HOME`,
 * so per-profile and custom-home setups resolve without extra config. Unlike
 * Cursor there are no project-local skill roots: the CLI reads the user home
 * only, and so does this scan.
 *
 * Walk mechanics (budget-tracked recursion, dedupe, failure reasons) live in
 * `SkillDiscovery`; this module owns Hermes's data: the `HERMES_HOME` root,
 * the `name:`-first frontmatter mapping, and `/name` invocation.
 *
 * @module provider/Drivers/HermesSkills
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

interface HermesSkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
}

class HermesSkillsProbeError extends Schema.TaggedError<HermesSkillsProbeError>()(
  "HermesSkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    cwd: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Hermes skill discovery${location} was incomplete (${this.reason}).`;
  }
}

function parseSkillFrontmatter(contents: string | undefined): HermesSkillFrontmatter | undefined {
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

function toHermesSkill(
  input: SkillRecordInput<HermesSkillFrontmatter>,
): ServerProviderSkill | undefined {
  const frontmatter = input.frontmatter;
  // Hermes requires `name:` in SKILL.md; fall back to the directory name
  // for foreign skill trees without one.
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

function buildHermesRoots(context: SkillRootsContext): ReadonlyArray<SkillRoot> {
  const { environment, path } = context;
  // The driver already folds the configured homePath into HERMES_HOME via
  // makeHermesEnvironment, so profiles and custom homes resolve here.
  const hermesHome =
    environment.HERMES_HOME?.trim() ||
    path.join(
      environment.HOME?.trim() || environment.USERPROFILE?.trim() || context.userHome,
      ".hermes",
    );
  // Hermes reads the user home only: no project roots, unlike Cursor.
  return [{ directory: path.join(hermesHome, "skills"), scope: "user" as const }];
}

const inspectHermesSkills = Effect.fn("inspectHermesSkills")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  return yield* inspectSkills({
    cwd: undefined,
    environment,
    buildRoots: buildHermesRoots,
    parseFrontmatter: parseSkillFrontmatter,
    toSkill: toHermesSkill,
  });
});

export const discoverHermesSkills = Effect.fn("discoverHermesSkills")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (yield* inspectHermesSkills(environment)).skills;
});

export const probeHermesSkills = Effect.fn("probeHermesSkills")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const inspection = yield* inspectHermesSkills(environment);
  if (inspection.failureReason) {
    return yield* new HermesSkillsProbeError({ reason: inspection.failureReason });
  }
  return inspection.skills;
});

/** Hermes invokes skills with `/name`; T3 composers insert `$name`. */
export function hasHermesSkillMention(prompt: string): boolean {
  return hasSkillMention(HAS_SKILL_MENTION_PATTERN, prompt);
}

export function rewriteHermesSkillMentions(
  prompt: string,
  skillNames: ReadonlySet<string>,
): string {
  return rewriteSkillMentions(SKILL_MENTION_PATTERN, prompt, skillNames, (name) => `/${name}`);
}
