/**
 * ZcodeSkills — skill discovery for the `$` picker via `zcode skills list --json`.
 *
 * The ZCode CLI reports its full skill catalog itself: `skills list --json`
 * returns `skills[]` with `name`, `description`, `path` (the absolute
 * `SKILL.md` path), `scope` (`user` / `system` / …), and `source`
 * (`agents` / `plugin` / …). Asking the CLI beats scanning the filesystem
 * because the catalog honors ZCode's own skill config and includes plugin
 * skills, which live deep under the plugin cache where a flat scan cannot
 * see them. This mirrors how the Grok driver reads `grok inspect --json`.
 * Probe failures stay typed so workspace snapshots do not cache an empty
 * catalog; machine-level discovery recovers them to an empty list without
 * degrading the provider.
 *
 * @module provider/Drivers/ZcodeSkills
 */
import type { ServerProviderSkill, ZcodeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../providerSnapshot.ts";

const ZCODE_SKILLS_PROBE_TIMEOUT_MS = 8_000;

class ZcodeSkillsProbeError extends Schema.TaggedError<ZcodeSkillsProbeError>()(
  "ZcodeSkillsProbeError",
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
    return `\`zcode skills list --json\` failed during ${this.stage}${location}${exitCode}.`;
  }
}

/**
 * Map `zcode skills list --json` output onto provider skills. Entries without
 * a name or a filesystem path are skipped; the CLI reports no invocability
 * flag, so every reported skill stays enabled.
 */
function decodeZcodeSkillsListSkills(
  stdout: string,
): ReadonlyArray<ServerProviderSkill> | undefined {
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
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!name || !path) {
      continue;
    }
    const scope = typeof record.scope === "string" ? record.scope.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    skillsByName.set(name, {
      name,
      path,
      enabled: true,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function parseZcodeSkillsList(stdout: string): ReadonlyArray<ServerProviderSkill> {
  return decodeZcodeSkillsListSkills(stdout) ?? [];
}

/**
 * Run `zcode skills list --json` and map the reported catalog onto provider
 * skills. Callers that need best-effort discovery can recover this effect to
 * an empty list; workspace callers leave failures typed so they are not cached.
 */
export const discoverZcodeSkills = Effect.fn("discoverZcodeSkills")(function* (
  zcodeSettings: Pick<ZcodeSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
) {
  const command = zcodeSettings.binaryPath || "zcode";
  const listResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["skills", "list", "--json"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ZcodeSkillsProbeError({
          stage: "spawn",
          ...(cwd ? { cwd } : {}),
          cause,
        }),
    ),
    Effect.timeoutOption(ZCODE_SKILLS_PROBE_TIMEOUT_MS),
  );

  if (Option.isNone(listResult)) {
    return yield* new ZcodeSkillsProbeError({
      stage: "timeout",
      ...(cwd ? { cwd } : {}),
    });
  }
  const output = listResult.value;
  if (output.code !== 0) {
    return yield* new ZcodeSkillsProbeError({
      stage: "exit",
      ...(cwd ? { cwd } : {}),
      exitCode: output.code,
    });
  }
  const skills = decodeZcodeSkillsListSkills(output.stdout);
  if (!skills) {
    return yield* new ZcodeSkillsProbeError({
      stage: "decode",
      ...(cwd ? { cwd } : {}),
    });
  }
  return skills;
});
