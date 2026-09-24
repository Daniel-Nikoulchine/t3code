/**
 * SkillDiscovery — the mechanics every Agent Skills scanner repeats.
 *
 * Six drivers walk the same shape (budget-tracked recursion over skill
 * roots, `SKILL.md` frontmatter, `$mention` rewrite) with different data:
 * root directories, frontmatter fields, and mention targets. The walk,
 * budget accounting, symlink containment, dedupe/sort, and failure reasons
 * live here exactly once; each driver supplies its roots, its frontmatter
 * mapping, and its mention pattern.
 *
 * Deliberately NOT shared: frontmatter field semantics (e.g. Cursor's
 * `surfaces: cli` gate vs Devin's `triggers` rule vs Droid's `enabled`
 * mapping) and symlink policies beyond containment. Those stay per-driver
 * so unifying mechanics cannot regress tested behavior.
 *
 * Pure Effect over FileSystem + Path; no layers involved.
 *
 * @module provider/Drivers/SkillDiscovery
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MAX_SKILL_DEPTH = 10;
const MAX_SKILL_BYTES = ByteSize.bytes(1_000_000);
const MAX_SKILL_SCAN_ENTRIES = 10_000;
const MAX_SKILL_SCAN_BYTES = ByteSize.bytes(8_000_000);

export interface SkillScanBudget {
  remainingEntries: number;
  remainingBytes: bigint;
  exhausted: boolean;
  incomplete: boolean;
}

export const makeSkillScanBudget = (): SkillScanBudget => ({
  remainingEntries: MAX_SKILL_SCAN_ENTRIES,
  remainingBytes: MAX_SKILL_SCAN_BYTES,
  exhausted: false,
  incomplete: false,
});

export interface SkillRoot {
  readonly directory: string;
  readonly scope: "user" | "project";
}

export type SkillInspectionFailure = "scan-budget-exhausted" | "filesystem-error";

/**
 * The raw frontmatter block of a SKILL.md file: `undefined` when the file
 * carries none. Drivers map the block (or its absence) to their own
 * frontmatter shape — including different no-match defaults.
 */
export function extractFrontmatterBlock(contents: string): string | undefined {
  return FRONTMATTER_PATTERN.exec(contents)?.[1];
}

/**
 * Parse a frontmatter block into a plain record: `undefined` when the YAML
 * is unparseable or not an object. Drivers read their own fields off it.
 */
export function parseFrontmatterRecord(block: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(block);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * Shared frontmatter boolean coercion (`true/yes/on/1` vs `false/no/off/0`).
 * Seven `*Skills.ts` modules carried this copy; single owner here so a
 * spelling change lands everywhere. Case-insensitive, trims input.
 */
export function parseFrontmatterBoolean(value: unknown): boolean | undefined {
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

const orUndefined = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
  budget?: SkillScanBudget,
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

export interface SkillRecordInput<Frontmatter> {
  readonly name: string;
  readonly skillPath: string;
  readonly scope: "user" | "project";
  readonly frontmatter: Frontmatter | undefined;
}

/**
 * How the walk treats a directory whose resolved location left its root.
 * `"contain"` rejects it outright (everything is read through the resolved
 * path). `"package-boundary"` treats it as a skill package boundary: its
 * own SKILL.md is still read through the visited path, but the target tree
 * is never walked. The boundary form exists for harnesses whose skill
 * libraries arrive as symlinks; it is pinned by tests, not by convention.
 */
export type SkillSymlinkPolicy = "contain" | "package-boundary";

/**
 * Walk skill roots with budget-tracked, symlink-contained recursion.
 * `parseFrontmatter` sees every SKILL.md: the file contents when readable
 * and within budget, `undefined` otherwise (missing file, over budget,
 * unreadable). Drivers encode their own absent-file default there, so a
 * present-but-unparseable file stays distinguishable from a missing one.
 * `toSkill` filters and maps; returning `undefined` skips the skill.
 */
export const discoverSkillsInRoots = Effect.fn("discoverSkillsInRoots")(function* <
  Frontmatter,
>(input: {
  readonly roots: ReadonlyArray<SkillRoot>;
  readonly budget: SkillScanBudget;
  readonly parseFrontmatter: (contents: string | undefined) => Frontmatter | undefined;
  readonly toSkill: (skill: SkillRecordInput<Frontmatter>) => ServerProviderSkill | undefined;
  readonly symlinkPolicy?: SkillSymlinkPolicy;
}): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const policy = input.symlinkPolicy ?? "contain";
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: ServerProviderSkill[] = [];

  const discoverInRoot = Effect.fn("discoverSkillsInRoot")(function* (root: SkillRoot) {
    if (input.budget.exhausted) return;
    const rootDirectory = yield* orUndefined(fileSystem.realPath(root.directory), input.budget);
    if (!rootDirectory) return;
    const visitedDirectories = new Set<string>();

    const visit = Effect.fn("visitSkillDirectory")(function* (
      directory: string,
      depth: number,
    ): Effect.fn.Return<void, never> {
      if (input.budget.exhausted) return;
      const resolvedDirectory = yield* orUndefined(fileSystem.realPath(directory), input.budget);
      if (!resolvedDirectory) {
        return;
      }
      if (visitedDirectories.has(resolvedDirectory)) {
        return;
      }
      visitedDirectories.add(resolvedDirectory);
      const insideRoot =
        resolvedDirectory === rootDirectory ||
        resolvedDirectory.startsWith(`${rootDirectory}${path.sep}`);
      if (policy === "contain" && !insideRoot) {
        return;
      }
      // Boundary walks read through the visited path so a linked skill
      // library keeps its link location; containment walks read through the
      // resolved path so nothing escapes the root.
      const base = policy === "contain" ? resolvedDirectory : directory;

      const skillPath = path.join(base, "SKILL.md");
      const skillInfo = yield* orUndefined(fileSystem.stat(skillPath), input.budget);
      if (skillInfo?.type === "File") {
        let contents: string | undefined = undefined;
        if (skillInfo.size <= MAX_SKILL_BYTES && skillInfo.size <= input.budget.remainingBytes) {
          contents = yield* orUndefined(fileSystem.readFileString(skillPath));
          if (contents !== undefined) {
            input.budget.remainingBytes -= skillInfo.size;
          }
        }
        const frontmatter = input.parseFrontmatter(contents);
        const name = path.basename(base).trim();
        const skill = name
          ? input.toSkill({ name, skillPath, scope: root.scope, frontmatter })
          : undefined;
        if (skill) skills.push(skill);
      }

      if (policy === "package-boundary" && !insideRoot) {
        return;
      }
      const entries = yield* orUndefined(fileSystem.readDirectory(base), input.budget);
      if (!entries) {
        return;
      }
      for (const entry of [...entries].sort()) {
        if (input.budget.remainingEntries === 0) {
          input.budget.exhausted = true;
          return;
        }
        input.budget.remainingEntries -= 1;
        const child = path.join(base, entry);
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
  });

  for (const root of input.roots) {
    if (input.budget.exhausted) break;
    yield* discoverInRoot(root);
  }
  return skills;
});

export interface SkillRootsContext {
  readonly cwd: string | undefined;
  readonly userHome: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly path: Path.Path;
}

/**
 * Full inspection: resolve the user home, build roots, walk them, dedupe by
 * name (first root wins — project roots come first), sort, and report the
 * failure reason. Drivers supply `buildRoots`; everything else is shared.
 */
export const inspectSkills = Effect.fn("inspectSkills")(function* <Frontmatter>(input: {
  readonly cwd: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly buildRoots: (context: SkillRootsContext) => ReadonlyArray<SkillRoot>;
  readonly parseFrontmatter: (contents: string | undefined) => Frontmatter | undefined;
  readonly toSkill: (skill: SkillRecordInput<Frontmatter>) => ServerProviderSkill | undefined;
  readonly symlinkPolicy?: SkillSymlinkPolicy;
}): Effect.fn.Return<
  {
    readonly skills: ReadonlyArray<ServerProviderSkill>;
    readonly failureReason: SkillInspectionFailure | undefined;
  },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const environment = input.environment ?? process.env;
  const path = yield* Path.Path;
  const userHome = environment.HOME?.trim() || environment.USERPROFILE?.trim() || NodeOS.homedir();
  const roots = input.buildRoots({ cwd: input.cwd, userHome, environment, path });
  const budget = makeSkillScanBudget();
  const skills = yield* discoverSkillsInRoots({
    roots,
    budget,
    parseFrontmatter: input.parseFrontmatter,
    toSkill: input.toSkill,
    ...(input.symlinkPolicy === undefined ? {} : { symlinkPolicy: input.symlinkPolicy }),
  });
  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const skill of skills) {
    if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
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

export function hasSkillMention(pattern: RegExp, prompt: string): boolean {
  return pattern.test(prompt);
}

export function rewriteSkillMentions(
  pattern: RegExp,
  prompt: string,
  skillNames: ReadonlySet<string>,
  render: (name: string) => string,
): string {
  return prompt.replace(pattern, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}${render(name)}` : match,
  );
}
