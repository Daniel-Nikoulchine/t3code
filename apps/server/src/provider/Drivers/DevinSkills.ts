/**
 * DevinSkills — workspace-aware discovery and native invocation for Devin.
 *
 * Walk mechanics (budget-tracked recursion, dedupe, failure reasons) live in
 * `SkillDiscovery`; this module owns Devin's data: roots (including the
 * Windsurf/Codeium channels), the `triggers`/`user-invocable` frontmatter
 * mapping, and `/name` invocation.
 *
 * @module provider/Drivers/DevinSkills
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

interface DevinSkillFrontmatter {
  readonly description?: string;
  readonly displayName?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
}

class DevinSkillsProbeError extends Schema.TaggedError<DevinSkillsProbeError>()(
  "DevinSkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    cwd: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Devin skill discovery${location} was incomplete (${this.reason}).`;
  }
}

function parseSkillFrontmatter(contents: string | undefined): DevinSkillFrontmatter | undefined {
  if (contents === undefined) return {};
  const block = extractFrontmatterBlock(contents);
  if (block === undefined) return {};
  const record = parseFrontmatterRecord(block);
  if (record === undefined) return undefined;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const displayName = typeof record.name === "string" ? record.name.trim() : "";
  const triggers = Array.isArray(record.triggers)
    ? record.triggers.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    ...(description ? { description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(triggers && !triggers.some((entry) => entry.trim().toLowerCase() === "user")
      ? { userInvocable: false }
      : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

function toDevinSkill(
  input: SkillRecordInput<DevinSkillFrontmatter>,
): ServerProviderSkill | undefined {
  const frontmatter = input.frontmatter;
  if (!frontmatter) return undefined;
  return {
    name: input.name,
    path: input.skillPath,
    scope: input.scope,
    enabled: true,
    ...(frontmatter.displayName && frontmatter.displayName !== input.name
      ? { displayName: frontmatter.displayName }
      : {}),
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
    ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
    ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
  };
}

function buildDevinRoots(context: SkillRootsContext): ReadonlyArray<SkillRoot> {
  const { cwd, userHome, environment, path } = context;
  const configHome = environment.XDG_CONFIG_HOME?.trim() || path.join(userHome, ".config");
  const rootsBelow = (base: string, scope: "user" | "project") => [
    { directory: path.join(base, ".devin", "skills"), scope },
    { directory: path.join(base, ".windsurf", "skills"), scope },
    { directory: path.join(base, ".agents", "skills"), scope },
  ];
  const codeiumChannels = ["windsurf", "windsurf-next", "windsurf-insiders"];
  return [
    ...(cwd ? rootsBelow(cwd, "project") : []),
    ...rootsBelow(userHome, "user"),
    { directory: path.join(configHome, "devin", "skills"), scope: "user" as const },
    ...codeiumChannels.map((channel) => ({
      directory: path.join(userHome, ".codeium", channel, "skills"),
      scope: "user" as const,
    })),
  ];
}

const inspectDevinSkills = Effect.fn("inspectDevinSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return yield* inspectSkills({
    cwd,
    environment,
    buildRoots: buildDevinRoots,
    parseFrontmatter: parseSkillFrontmatter,
    toSkill: toDevinSkill,
  });
});

export const discoverDevinSkills = Effect.fn("discoverDevinSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (yield* inspectDevinSkills(cwd, environment)).skills;
});

export const probeDevinSkills = Effect.fn("probeDevinSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const inspection = yield* inspectDevinSkills(cwd, environment);
  if (inspection.failureReason) {
    return yield* new DevinSkillsProbeError({
      reason: inspection.failureReason,
      ...(cwd ? { cwd } : {}),
    });
  }
  return inspection.skills;
});

/** Devin invokes Agent Skills with `/name`; T3 composers insert `$name`. */
export function hasDevinSkillMention(prompt: string): boolean {
  return hasSkillMention(HAS_SKILL_MENTION_PATTERN, prompt);
}

export function rewriteDevinSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return rewriteSkillMentions(SKILL_MENTION_PATTERN, prompt, skillNames, (name) => `/${name}`);
}
