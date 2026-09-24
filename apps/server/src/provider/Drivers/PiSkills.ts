/**
 * PiSkills — skill discovery for the `$` picker via the Agent Skills standard.
 *
 * Pi loads skills from user roots (`~/.pi/agent/skills/`,
 * `~/.agents/skills/`) and project roots (`.pi/skills/`, `.agents/skills/`
 * in `cwd` and ancestors). Directories containing `SKILL.md` are discovered
 * recursively; root-level `.md` files under the pi roots are also skills
 * (pi rule — `.agents` roots ignore root `.md` files).
 *
 * Pi invokes skills as `/skill:name`; T3 composers insert `$name`.
 *
 * @module provider/Drivers/PiSkills
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
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
const MAX_SKILL_BYTES = ByteSize.bytes(1_000_000);
const MAX_SKILL_SCAN_ENTRIES = 10_000;
const MAX_SKILL_SCAN_BYTES = ByteSize.bytes(8_000_000);

interface PiSkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly userInvocationOnly?: boolean;
  readonly userInvocable?: boolean;
}

interface PiSkillScanBudget {
  remainingEntries: number;
  remainingBytes: bigint;
  exhausted: boolean;
  incomplete: boolean;
}

class PiSkillsProbeError extends Schema.TaggedError<PiSkillsProbeError>()("PiSkillsProbeError", {
  reason: Schema.Literals(["scan-budget-exhausted", "filesystem-error"]),
  cwd: Schema.optional(Schema.String),
}) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    return `Pi skill discovery${location} was incomplete (${this.reason}).`;
  }
}

const orUndefined = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  budget?: PiSkillScanBudget,
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

export function parsePiSkillFrontmatter(contents: string): PiSkillFrontmatter | undefined {
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

function piHomeDir(environment: NodeJS.ProcessEnv): string {
  return environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
}

function piAgentDir(environment: NodeJS.ProcessEnv, path: Path.Path): string {
  const configured = environment.PI_CODING_AGENT_DIR?.trim() || environment.PI_AGENT_DIR?.trim();
  if (configured) return configured;
  return path.join(piHomeDir(environment), ".pi", "agent");
}

const discoverSkillsInRoot = Effect.fn("discoverPiSkillsInRoot")(function* (input: {
  readonly directory: string;
  readonly scope: "user" | "project";
  readonly budget: PiSkillScanBudget;
  readonly includeRootMdFiles: boolean;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: ServerProviderSkill[] = [];
  if (input.budget.exhausted) return skills;
  const rootDirectory = yield* orUndefined(fileSystem.realPath(input.directory), input.budget);
  if (!rootDirectory) return skills;
  const visitedDirectories = new Set<string>();

  const readSkillFile = Effect.fn("readPiSkillFile")(function* (
    skillPath: string,
    fallbackName: string,
  ): Effect.fn.Return<void, never> {
    const info = yield* orUndefined(fileSystem.stat(skillPath), input.budget);
    if (info?.type !== "File") return;
    // Pi requires a description; entries without one are not loaded.
    if (info.size > MAX_SKILL_BYTES || info.size > input.budget.remainingBytes) return;
    const contents = yield* orUndefined(fileSystem.readFileString(skillPath));
    if (contents === undefined) return;
    input.budget.remainingBytes -= info.size;
    const frontmatter = parsePiSkillFrontmatter(contents);
    const name = frontmatter?.name?.trim() || fallbackName.trim();
    if (!frontmatter || !name || !frontmatter.description) return;
    skills.push({
      name,
      path: skillPath,
      scope: input.scope,
      enabled: true,
      ...(frontmatter.name && frontmatter.name !== name ? { displayName: frontmatter.name } : {}),
      description: frontmatter.description,
      ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
      ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
    });
  });

  const visit = Effect.fn("visitPiSkillDirectory")(function* (
    directory: string,
    depth: number,
  ): Effect.fn.Return<void, never> {
    if (input.budget.exhausted) return;
    const resolvedDirectory = yield* orUndefined(fileSystem.realPath(directory), input.budget);
    if (!resolvedDirectory) return;
    if (
      visitedDirectories.has(resolvedDirectory) ||
      (resolvedDirectory !== rootDirectory &&
        !resolvedDirectory.startsWith(`${rootDirectory}${path.sep}`))
    ) {
      return;
    }
    visitedDirectories.add(resolvedDirectory);

    // `SKILL.md` in this directory (flat or grouped layout).
    yield* readSkillFile(
      path.join(resolvedDirectory, "SKILL.md"),
      path.basename(resolvedDirectory),
    );

    const entries = yield* orUndefined(fileSystem.readDirectory(resolvedDirectory), input.budget);
    if (!entries) return;
    for (const entry of [...entries].sort()) {
      if (input.budget.remainingEntries === 0) {
        input.budget.exhausted = true;
        return;
      }
      input.budget.remainingEntries -= 1;
      const child = path.join(resolvedDirectory, entry);
      // Root-level `.md` files are skills in pi roots (not in `.agents` roots).
      if (depth === 0 && input.includeRootMdFiles && entry.toLowerCase().endsWith(".md")) {
        const info = yield* orUndefined(fileSystem.stat(child), input.budget);
        if (info?.type === "File" && entry.toLowerCase() !== "skill.md") {
          yield* readSkillFile(child, entry.replace(/\.[^.]+$/, ""));
        }
        continue;
      }
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

function projectRootsForCwd(cwd: string | undefined, path: Path.Path): string[] {
  if (!cwd?.trim()) return [];
  const roots: string[] = [];
  let current = path.resolve(cwd.trim());
  for (let depth = 0; depth < 32; depth += 1) {
    roots.push(path.join(current, ".pi", "skills"));
    roots.push(path.join(current, ".agents", "skills"));
    const parent = path.dirname(current);
    if (parent === current) break;
    // Stop at filesystem root; git-root detection would need process access
    // the snapshot layer does not have — ancestor walk is a superset.
    current = parent;
  }
  return roots;
}

const inspectPiSkills = Effect.fn("inspectPiSkills")(function* (
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const path = yield* Path.Path;
  const agentDir = piAgentDir(environment, path);
  const home = piHomeDir(environment);
  const roots: Array<{
    readonly directory: string;
    readonly scope: "user" | "project";
    readonly includeRootMdFiles: boolean;
  }> = [
    {
      directory: path.join(agentDir, "skills"),
      scope: "user",
      includeRootMdFiles: true,
    },
    { directory: path.join(home, ".agents", "skills"), scope: "user", includeRootMdFiles: false },
  ];
  for (const directory of projectRootsForCwd(cwd, path)) {
    roots.push({
      directory,
      scope: "project",
      includeRootMdFiles: directory.endsWith(`${path.sep}.pi${path.sep}skills`),
    });
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  const budget: PiSkillScanBudget = {
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

export const discoverPiSkills = Effect.fn("discoverPiSkills")(function* (
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  return (yield* inspectPiSkills(environment, cwd)).skills;
});

export const probePiSkills = Effect.fn("probePiSkills")(function* (
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const inspection = yield* inspectPiSkills(environment, cwd);
  if (inspection.failureReason) {
    return yield* new PiSkillsProbeError({
      reason: inspection.failureReason,
      ...(cwd ? { cwd } : {}),
    });
  }
  return inspection.skills;
});

/** Pi invokes skills with `/skill:name`; T3 composers insert `$name`. */
export function hasPiSkillMention(prompt: string): boolean {
  return HAS_SKILL_MENTION_PATTERN.test(prompt);
}

export function rewritePiSkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) => {
    const base = name.split(":")[0] ?? name;
    const hit = skillNames.has(name) || (base !== name && skillNames.has(base));
    return hit ? `${prefix}/skill:${name}` : match;
  });
}
