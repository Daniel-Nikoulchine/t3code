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
 * @module provider/Drivers/HermesSkills
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
const SKILL_MENTION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const HAS_SKILL_MENTION_PATTERN = /(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?=\s|$)/;
const MAX_SKILL_DEPTH = 10;
const MAX_SKILL_BYTES = FileSystem.Size(1_000_000);
const MAX_SKILL_SCAN_ENTRIES = 10_000;
const MAX_SKILL_SCAN_BYTES = FileSystem.Size(8_000_000);

interface HermesSkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
}

interface HermesSkillScanBudget {
  remainingEntries: number;
  remainingBytes: bigint;
  exhausted: boolean;
  incomplete: boolean;
}

class HermesSkillsProbeError extends Schema.TaggedErrorClass<HermesSkillsProbeError>()(
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

const orUndefined = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  budget?: HermesSkillScanBudget,
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

function parseSkillFrontmatter(contents: string): HermesSkillFrontmatter | undefined {
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

const discoverSkillsInRoot = Effect.fn("discoverHermesSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project";
  readonly budget: HermesSkillScanBudget;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: ServerProviderSkill[] = [];
  if (input.budget.exhausted) return skills;
  const rootDirectory = yield* orUndefined(fileSystem.realPath(input.directory), input.budget);
  if (!rootDirectory) return skills;
  const visitedDirectories = new Set<string>();

  const visit = Effect.fn("visitHermesSkillDirectory")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void, never> {
    if (input.budget.exhausted) return;
    const resolvedDirectory = yield* orUndefined(fileSystem.realPath(directory), input.budget);
    if (!resolvedDirectory) {
      return;
    }
    if (
      visitedDirectories.has(resolvedDirectory) ||
      (resolvedDirectory !== rootDirectory &&
        !resolvedDirectory.startsWith(`${rootDirectory}${path.sep}`))
    ) {
      return;
    }
    visitedDirectories.add(resolvedDirectory);

    const skillPath = path.join(resolvedDirectory, "SKILL.md");
    const skillInfo = yield* orUndefined(fileSystem.stat(skillPath), input.budget);
    if (skillInfo?.type === "File") {
      let frontmatter: HermesSkillFrontmatter | undefined = {};
      if (skillInfo.size <= MAX_SKILL_BYTES && skillInfo.size <= input.budget.remainingBytes) {
        const contents = yield* orUndefined(fileSystem.readFileString(skillPath));
        if (contents !== undefined) {
          input.budget.remainingBytes -= skillInfo.size;
          frontmatter = parseSkillFrontmatter(contents);
        }
      }
      // Hermes requires `name:` in SKILL.md; fall back to the directory name
      // for foreign skill trees without one.
      const name = frontmatter?.name?.trim() || path.basename(resolvedDirectory).trim();
      if (frontmatter && name) {
        skills.push({
          name,
          path: skillPath,
          scope: input.scope,
          enabled: true,
          ...(frontmatter.name && frontmatter.name !== name
            ? { displayName: frontmatter.name }
            : {}),
          ...(frontmatter.description ? { description: frontmatter.description } : {}),
          ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
          ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
        });
      }
    }

    const entries = yield* orUndefined(fileSystem.readDirectory(resolvedDirectory), input.budget);
    if (!entries) {
      return;
    }
    for (const entry of [...entries].sort()) {
      if (input.budget.remainingEntries === 0) {
        input.budget.exhausted = true;
        return;
      }
      input.budget.remainingEntries -= 1;
      const child = path.join(resolvedDirectory, entry);
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

const inspectHermesSkills = Effect.fn("inspectHermesSkills")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const path = yield* Path.Path;
  // The driver already folds the configured homePath into HERMES_HOME via
  // makeHermesEnvironment, so profiles and custom homes resolve here.
  const hermesHome =
    environment.HERMES_HOME?.trim() ||
    path.join(
      environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir(),
      ".hermes",
    );
  // Hermes reads the user home only: no project roots, unlike Cursor.
  const roots = [{ directory: path.join(hermesHome, "skills"), scope: "user" as const }];

  const skillsByName = new Map<string, ServerProviderSkill>();
  const budget: HermesSkillScanBudget = {
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
  return HAS_SKILL_MENTION_PATTERN.test(prompt);
}

export function rewriteHermesSkillMentions(
  prompt: string,
  skillNames: ReadonlySet<string>,
): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/${name}` : match,
  );
}
