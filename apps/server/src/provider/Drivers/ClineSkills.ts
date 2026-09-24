/**
 * ClineSkills — workspace-aware discovery and native invocation for Cline.
 *
 * Cline discovers Agent Skills recursively from user and project roots but
 * its ACP command catalog only appears after opening a real session. Scanning
 * the same roots avoids starting an agent and its MCP servers just to populate
 * a composer menu.
 *
 * Walk mechanics (budget-tracked recursion, dedupe, failure reasons) live in
 * `SkillDiscovery`; this module owns Cline's data: roots, the `surfaces: cli`
 * frontmatter gate, and `/name` invocation.
 *
 * @module provider/Drivers/ClineSkills
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

interface ClineSkillFrontmatter {
  readonly description?: string;
  readonly displayName?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
  readonly cliVisible: boolean;
}

class ClineSkillsProbeError extends Schema.TaggedError<ClineSkillsProbeError>()(
  "ClineSkillsProbeError",
  {
    reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
    cwd: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Cline skill discovery${location} was incomplete (${this.reason}).`;
  }
}

function parseSkillFrontmatter(contents: string | undefined): ClineSkillFrontmatter | undefined {
  if (contents === undefined) return { cliVisible: true };
  const block = extractFrontmatterBlock(contents);
  if (block === undefined) return { cliVisible: true };
  const record = parseFrontmatterRecord(block);
  if (record === undefined) return undefined;

  const metadata =
    typeof record.metadata === "object" && record.metadata !== null
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  const rawSurfaces = metadata?.surfaces;
  const surfaces = Array.isArray(rawSurfaces)
    ? rawSurfaces.filter((surface): surface is string => typeof surface === "string")
    : typeof rawSurfaces === "string"
      ? rawSurfaces.split(",")
      : [];
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const displayName = typeof record.name === "string" ? record.name.trim() : "";
  return {
    cliVisible:
      surfaces.length === 0 || surfaces.some((surface) => surface.trim().toLowerCase() === "cli"),
    ...(description ? { description } : {}),
    ...(displayName ? { displayName } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

function toClineSkill(
  input: SkillRecordInput<ClineSkillFrontmatter>,
): ServerProviderSkill | undefined {
  const frontmatter = input.frontmatter;
  if (!frontmatter?.cliVisible) return undefined;
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

function buildClineRoots(context: SkillRootsContext): ReadonlyArray<SkillRoot> {
  const { cwd, userHome, path } = context;
  const rootsBelow = (base: string, scope: "user" | "project") => [
    { directory: path.join(base, ".cline", "skills"), scope },
    { directory: path.join(base, ".agents", "skills"), scope },
    { directory: path.join(base, ".claude", "skills"), scope },
    { directory: path.join(base, ".codex", "skills"), scope },
  ];
  return [...(cwd ? rootsBelow(cwd, "project") : []), ...rootsBelow(userHome, "user")];
}

const inspectClineSkills = Effect.fn("inspectClineSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return yield* inspectSkills({
    cwd,
    environment,
    buildRoots: buildClineRoots,
    parseFrontmatter: parseSkillFrontmatter,
    toSkill: toClineSkill,
  });
});

export const discoverClineSkills = Effect.fn("discoverClineSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (yield* inspectClineSkills(cwd, environment)).skills;
});

export const probeClineSkills = Effect.fn("probeClineSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const inspection = yield* inspectClineSkills(cwd, environment);
  if (inspection.failureReason) {
    return yield* new ClineSkillsProbeError({
      reason: inspection.failureReason,
      ...(cwd ? { cwd } : {}),
    });
  }
  return inspection.skills;
});

/** Cline invokes Agent Skills with `/name`; T3 composers insert `$name`. */
export function hasClineSkillMention(prompt: string): boolean {
  return hasSkillMention(HAS_SKILL_MENTION_PATTERN, prompt);
}

export function rewriteClineSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return rewriteSkillMentions(SKILL_MENTION_PATTERN, prompt, skillNames, (name) => `/${name}`);
}
