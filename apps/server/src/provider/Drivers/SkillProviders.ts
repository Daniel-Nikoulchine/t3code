/**
 * SkillProviders — one config table instead of N `*Skills.ts` modules.
 *
 * `SkillDiscovery.ts` owns the walk mechanics; each `*Skills.ts` module only
 * carried data: root directories, frontmatter gate, mention pattern, and
 * invoke syntax. That data lives here exactly once so a new harness adds one
 * row instead of a new module. The existing `*Skills.ts` modules stay as thin
 * backward-compatible wrappers (tests import them); new code should use the
 * generic `discoverSkillsForProvider` / `hasSkillMentionForProvider` /
 * `rewriteSkillMentionsForProvider` below.
 *
 * Custom walks (Pi ancestor walk, Claude overrides, Antigravity layout,
 * CLI probes for Grok/Zcode/OpenClaw) stay in their modules on purpose —
 * unifying their semantics would regress tested behavior.
 *
 * @module provider/Drivers/SkillProviders
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import {
  hasSkillMention,
  inspectSkills,
  rewriteSkillMentions,
  type SkillRoot,
  type SkillRootsContext,
  type SkillSymlinkPolicy,
} from "./SkillDiscovery.ts";

const MONEY_SAFE_PATTERN_SOURCE = String.raw`(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)`;
const SIMPLE_PATTERN_SOURCE = String.raw`(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)`;

const MONEY_SAFE_PATTERN = new RegExp(MONEY_SAFE_PATTERN_SOURCE, "g");
const MONEY_SAFE_HAS_PATTERN = new RegExp(MONEY_SAFE_PATTERN_SOURCE);
const SIMPLE_PATTERN = new RegExp(SIMPLE_PATTERN_SOURCE, "g");
const SIMPLE_HAS_PATTERN = new RegExp(SIMPLE_PATTERN_SOURCE);

export type SkillMentionKind = "money-safe" | "simple" | "none";

export interface SkillProviderDecl {
  readonly projectDirs: ReadonlyArray<string>;
  readonly userDirs: ReadonlyArray<string>;
  /** Extra user roots that are not `<home>/<dir>` (e.g. Kilo config root, Devin XDG/Codeium channels). */
  readonly buildExtraUserRoots?: (
    context: SkillRootsContext,
  ) => ReadonlyArray<{ directory: string; scope: "user" }>;
  /** Hermes-style: no project roots, home comes from env (HERMES_HOME). */
  readonly homeEnvVar?: string;
  readonly symlinkPolicy?: SkillSymlinkPolicy;
  readonly mention: SkillMentionKind;
}

const rootsBelow = (
  context: SkillRootsContext,
  base: string,
  scope: "user" | "project",
  dirs: ReadonlyArray<string>,
): Array<SkillRoot> => dirs.map((dir) => ({ directory: context.path.join(base, dir), scope }));

function buildDeclRoots(decl: SkillProviderDecl): (context: SkillRootsContext) => Array<SkillRoot> {
  return (context) => {
    if (decl.homeEnvVar !== undefined) {
      const home = context.environment[decl.homeEnvVar]?.trim() || context.userHome;
      return [{ directory: context.path.join(home, "skills"), scope: "user" as const }];
    }
    const projectRoots = context.cwd
      ? rootsBelow(context, context.cwd, "project", decl.projectDirs)
      : [];
    const userRoots = rootsBelow(context, context.userHome, "user", decl.userDirs);
    const extra = decl.buildExtraUserRoots?.(context) ?? [];
    return [...projectRoots, ...userRoots, ...extra];
  };
}

const skillProviderTable = {
  cursor: {
    projectDirs: [".cursor/skills", ".agents/skills", ".codex/skills", ".claude/skills"],
    userDirs: [".cursor/skills", ".agents/skills", ".codex/skills", ".claude/skills"],
    symlinkPolicy: "package-boundary",
    mention: "money-safe",
  },
  cline: {
    projectDirs: [".cline/skills", ".agents/skills", ".claude/skills", ".codex/skills"],
    userDirs: [".cline/skills", ".agents/skills", ".claude/skills", ".codex/skills"],
    mention: "simple",
  },
  kilo: {
    projectDirs: [".kilo/skills", ".agents/skills"],
    userDirs: [],
    buildExtraUserRoots: (context: SkillRootsContext) => [
      {
        directory: context.path.join(context.userHome, ".config", "kilo", "skills"),
        scope: "user",
      },
    ],
    mention: "simple",
  },
  droid: {
    projectDirs: [".factory/skills", ".agents/skills", ".agent/skills"],
    userDirs: [".factory/skills", ".agents/skills", ".agent/skills"],
    symlinkPolicy: "package-boundary",
    mention: "money-safe",
  },
  devin: {
    projectDirs: [".devin/skills", ".windsurf/skills", ".agents/skills"],
    userDirs: [".devin/skills", ".windsurf/skills", ".agents/skills"],
    buildExtraUserRoots: (context: SkillRootsContext) => {
      const configHome =
        context.environment.XDG_CONFIG_HOME?.trim() ||
        context.path.join(context.userHome, ".config");
      return [
        { directory: context.path.join(configHome, "devin", "skills"), scope: "user" },
        ...["windsurf", "windsurf-next", "windsurf-insiders"].map((channel) => ({
          directory: context.path.join(context.userHome, ".codeium", channel, "skills"),
          scope: "user" as const,
        })),
      ];
    },
    mention: "simple",
  },
  hermes: {
    projectDirs: [],
    userDirs: [],
    homeEnvVar: "HERMES_HOME",
    mention: "simple",
  },
  copilot: { projectDirs: [], userDirs: [], mention: "none" },
  minimax: { projectDirs: [], userDirs: [], mention: "none" },
  omp: { projectDirs: [], userDirs: [], mention: "simple" },
} as const;

export type SkillProviderId = keyof typeof skillProviderTable;

export const SKILL_PROVIDERS: Record<SkillProviderId, SkillProviderDecl> =
  skillProviderTable as unknown as Record<SkillProviderId, SkillProviderDecl>;

const mentionPatterns = (kind: SkillMentionKind): { has: RegExp; rewrite: RegExp } | undefined => {
  switch (kind) {
    case "money-safe":
      return { has: MONEY_SAFE_HAS_PATTERN, rewrite: MONEY_SAFE_PATTERN };
    case "simple":
      return { has: SIMPLE_HAS_PATTERN, rewrite: SIMPLE_PATTERN };
    case "none":
      return undefined;
  }
};

/**
 * Filesystem discovery for a table-driven provider. Stub entries
 * (`copilot`, `minimax`) resolve to `[]` without touching the filesystem.
 * Custom-walk harnesses (pi, claude, antigravity, grok, zcode, openclaw) are
 * intentionally absent here — see the module doc.
 */
export const discoverSkillsForProvider = Effect.fn("discoverSkillsForProvider")(function* (
  provider: SkillProviderId,
  options?: { readonly cwd?: string; readonly environment?: NodeJS.ProcessEnv },
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const decl = SKILL_PROVIDERS[provider];
  if (
    decl.projectDirs.length === 0 &&
    decl.userDirs.length === 0 &&
    decl.buildExtraUserRoots === undefined &&
    decl.homeEnvVar === undefined
  ) {
    return [];
  }
  // Table covers roots + mention syntax; frontmatter semantics stay
  // per-driver (surfaces-cli gate vs triggers rule vs enabled mapping), so
  // reuse the shared walk with a permissive pass-through and let the adapter
  // filter by its own probe. This keeps one walk for listing without
  // regressing tested frontmatter gates.
  const inspection = yield* inspectSkills({
    cwd: options?.cwd,
    environment: options?.environment ?? process.env,
    buildRoots: buildDeclRoots(decl),
    parseFrontmatter: () => ({}),
    toSkill: (skill) => ({
      name: skill.name,
      path: skill.skillPath,
      scope: skill.scope,
      enabled: true,
    }),
    ...(decl.symlinkPolicy === undefined ? {} : { symlinkPolicy: decl.symlinkPolicy }),
  });
  return inspection.skills;
});

export function hasSkillMentionForProvider(provider: SkillProviderId, prompt: string): boolean {
  const patterns = mentionPatterns(SKILL_PROVIDERS[provider].mention);
  if (!patterns) return false;
  patterns.has.lastIndex = 0;
  return hasSkillMention(patterns.has, prompt);
}

export function rewriteSkillMentionsForProvider(
  provider: SkillProviderId,
  prompt: string,
  skillNames: ReadonlySet<string>,
): string {
  const decl = SKILL_PROVIDERS[provider];
  const patterns = mentionPatterns(decl.mention);
  if (!patterns) return prompt;
  const render = (name: string): string => (provider === "omp" ? `/skill:${name}` : `/${name}`);
  return rewriteSkillMentions(patterns.rewrite, prompt, skillNames, render);
}
