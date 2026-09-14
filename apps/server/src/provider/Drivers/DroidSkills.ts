/**
 * DroidSkills — workspace-aware skill discovery for Factory Droid.
 *
 * Droid loads skills from several scopes; a skill is any directory under a
 * `skills/` folder that contains a `SKILL.md` entry point:
 *   - project: `<repo>/.factory/skills/<name>/SKILL.md`
 *   - folder-specific: `<repo>/<area>/.factory/skills/<name>/SKILL.md` (covered
 *     by the recursive scan below)
 *   - personal: `~/.factory/skills/<name>/SKILL.md`
 *   - compatibility: `<repo>/.agents/skills/`, `<repo>/.agent/skills/`
 *
 * Scanning the same roots avoids starting an ACP agent (and its MCP servers)
 * just to populate the composer's `$` picker.
 *
 * @module provider/Drivers/DroidSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_MENTION_PATTERN =
  /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const HAS_SKILL_MENTION_PATTERN = new RegExp(SKILL_MENTION_PATTERN.source);
const MAX_SKILL_DEPTH = 10;
const MAX_SKILL_BYTES = FileSystem.Size(1_000_000);
const MAX_SKILL_SCAN_ENTRIES = 10_000;
const MAX_SKILL_SCAN_BYTES = FileSystem.Size(8_000_000);

interface DroidSkillFrontmatter {
  readonly description?: string;
  readonly displayName?: string;
  readonly userInvocable?: boolean;
}

interface DroidSkillScanBudget {
  remainingEntries: number;
  remainingBytes: bigint;
  exhausted: boolean;
  incomplete: boolean;
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

const orUndefined = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  budget?: DroidSkillScanBudget,
): Effect.Effect<A | undefined, never, R> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTags({
      PlatformError: (error) => {
        if (error.reason._tag !== "NotFound" && budget) budget.incomplete = true;
        return Effect.void.pipe(Effect.as(undefined));
      },
    }),
  );

function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
      return true;
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): DroidSkillFrontmatter | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return {};
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
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

const discoverSkillsInRoot = Effect.fn("discoverDroidSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project";
  readonly budget: DroidSkillScanBudget;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: ServerProviderSkill[] = [];
  if (input.budget.exhausted) return skills;
  const rootDirectory = yield* orUndefined(fileSystem.realPath(input.directory), input.budget);
  if (!rootDirectory) return skills;
  const visitedDirectories = new Set<string>();

  const visit = Effect.fn("visitDroidSkillDirectory")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void, never> {
    if (input.budget.exhausted) return;
    const resolvedDirectory = yield* orUndefined(fileSystem.realPath(directory), input.budget);
    if (!resolvedDirectory) return;
    if (visitedDirectories.has(resolvedDirectory)) return;
    visitedDirectories.add(resolvedDirectory);
    const insideRoot =
      resolvedDirectory === rootDirectory ||
      resolvedDirectory.startsWith(`${rootDirectory}${path.sep}`);

    const skillPath = path.join(directory, "SKILL.md");
    const skillInfo = yield* orUndefined(fileSystem.stat(skillPath), input.budget);
    if (skillInfo?.type === "File") {
      let frontmatter: DroidSkillFrontmatter | undefined = {};
      if (skillInfo.size <= MAX_SKILL_BYTES && skillInfo.size <= input.budget.remainingBytes) {
        const contents = yield* orUndefined(fileSystem.readFileString(skillPath));
        if (contents !== undefined) {
          input.budget.remainingBytes -= skillInfo.size;
          frontmatter = parseSkillFrontmatter(contents);
        }
      }
      const name = path.basename(directory).trim();
      if (frontmatter && name) {
        skills.push({
          name,
          path: skillPath,
          scope: input.scope,
          enabled: frontmatter.userInvocable !== false,
          ...(frontmatter.displayName && frontmatter.displayName !== name
            ? { displayName: frontmatter.displayName }
            : {}),
          ...(frontmatter.description ? { description: frontmatter.description } : {}),
          ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
        });
      }
    }

    if (!insideRoot) return;
    const entries = yield* orUndefined(fileSystem.readDirectory(directory), input.budget);
    if (!entries) return;
    for (const entry of [...entries].sort()) {
      if (input.budget.remainingEntries === 0) {
        input.budget.exhausted = true;
        return;
      }
      input.budget.remainingEntries -= 1;
      const child = path.join(directory, entry);
      const info = yield* orUndefined(fileSystem.stat(child), input.budget);
      if (info?.type !== "Directory") continue;
      if (depth >= MAX_SKILL_DEPTH) {
        input.budget.exhausted = true;
        return;
      }
      yield* visit(child, depth + 1);
    }
  });

  yield* visit(rootDirectory, 0);
  return skills;
});

const inspectDroidSkills = Effect.fn("inspectDroidSkills")(function* (
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const path = yield* Path.Path;
  const userHome = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
  const rootsBelow = (base: string, scope: "user" | "project") => [
    { directory: path.join(base, ".factory", "skills"), scope },
    { directory: path.join(base, ".agents", "skills"), scope },
    { directory: path.join(base, ".agent", "skills"), scope },
  ];
  const roots = [...(cwd ? rootsBelow(cwd, "project") : []), ...rootsBelow(userHome, "user")];

  const skillsByName = new Map<string, ServerProviderSkill>();
  const budget: DroidSkillScanBudget = {
    remainingEntries: MAX_SKILL_SCAN_ENTRIES,
    remainingBytes: MAX_SKILL_SCAN_BYTES,
    exhausted: false,
    incomplete: false,
  };
  for (const root of roots) {
    if (budget.exhausted) break;
    const skills = yield* discoverSkillsInRoot({ ...root, budget });
    for (const skill of skills) {
      if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
    }
  }
  return {
    skills: [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    failureReason: budget.exhausted
      ? ("scan-budget-exhausted" as const)
      : budget.incomplete
        ? ("filesystem-error" as const)
        : undefined,
  };
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
  return HAS_SKILL_MENTION_PATTERN.test(prompt);
}

export function rewriteDroidSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/${name}` : match,
  );
}
