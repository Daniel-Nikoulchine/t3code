/**
 * OpenClawSkills — skill discovery for the `$` picker via
 * `openclaw skills list --json`.
 *
 * The CLI reports its full skill catalog itself: `skills[]` with `name`,
 * `description`, `source` (e.g. `openclaw-bundled`, `openclaw-custodian`),
 * `userInvocable`, and `disabled`. Asking the CLI beats scanning the
 * filesystem because the catalog honors OpenClaw's own skill config
 * (allowlists, agent filters, eligibility) and needs no gateway — the
 * command works offline against local state. Probe failures stay typed so
 * workspace snapshots do not cache an empty catalog; machine-level
 * discovery recovers them to an empty list without degrading the provider.
 *
 * `ServerProviderSkill.path` requires a non-empty string, but OpenClaw
 * reports no filesystem path per skill. We synthesize a stable
 * `openclaw://skills/<name>` URI so rows render and stay addressable.
 *
 * @module provider/Drivers/OpenClawSkills
 */
import type { OpenClawSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { runCliJsonProbe } from "../cliProbe.ts";

const OPENCLAW_SKILLS_PROBE_TIMEOUT_MS = 4_000;
const SKILL_MENTION_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const HAS_SKILL_MENTION_PATTERN = /(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?=\s|$)/;

class OpenClawSkillsProbeError extends Schema.TaggedError<OpenClawSkillsProbeError>()(
  "OpenClawSkillsProbeError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "decode"]),
    cwd: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const location = this.cwd === undefined ? "" : ` for '${this.cwd}'`;
    const exitCode = this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`;
    return `\`openclaw skills list --json\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

/**
 * Map `openclaw skills list --json` output onto provider skills. Entries
 * without a name are skipped; `userInvocable: false` or `disabled: true`
 * skills are kept but disabled so pickers that filter on `enabled` hide
 * them.
 */
function decodeOpenClawSkillsList(stdout: string): ReadonlyArray<ServerProviderSkill> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const entries = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(entries)) {
    return undefined;
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) {
      continue;
    }
    const scope = typeof record.source === "string" ? record.source.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    const enabled = record.disabled !== true && record.userInvocable !== false;
    skillsByName.set(name, {
      name,
      path: `openclaw://skills/${name}`,
      enabled,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
      ...(record.userInvocable === false ? { userInvocable: false } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function parseOpenClawSkillsList(stdout: string): ReadonlyArray<ServerProviderSkill> {
  return decodeOpenClawSkillsList(stdout) ?? [];
}

/**
 * Run `openclaw skills list --json` and map the reported catalog onto
 * provider skills. Callers that need best-effort discovery can recover this
 * effect to an empty list; workspace callers leave failures typed so they
 * are not cached.
 */
export const discoverOpenClawSkills = Effect.fn("discoverOpenClawSkills")(function* (
  openclawSettings: Pick<OpenClawSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = openclawSettings.binaryPath || "openclaw";
  return yield* runCliJsonProbe({
    command,
    args: ["skills", "list", "--json"],
    environment,
    ...(cwd ? { cwd } : {}),
    timeoutMs: OPENCLAW_SKILLS_PROBE_TIMEOUT_MS,
    makeError: (input) =>
      new OpenClawSkillsProbeError({
        stage: input.stage,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        ...(input.cause !== undefined ? { cause: input.cause } : {}),
      }),
    decode: decodeOpenClawSkillsList,
  });
});

/** OpenClaw invokes skills natively as `/name`; T3 composers insert `$name`. */
export function hasOpenClawSkillMention(prompt: string): boolean {
  return HAS_SKILL_MENTION_PATTERN.test(prompt);
}

export function rewriteOpenClawSkillMentions(
  prompt: string,
  skillNames: ReadonlySet<string>,
): string {
  return prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) =>
    skillNames.has(name) ? `${prefix}/${name}` : match,
  );
}
