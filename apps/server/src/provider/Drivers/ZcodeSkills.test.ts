import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { discoverZcodeSkills, parseZcodeSkillsList } from "./ZcodeSkills.ts";

const listPayload = (skills: ReadonlyArray<unknown>) =>
  JSON.stringify({ cwd: "/tmp", diagnostics: [], skills, totalDiscovered: skills.length });

describe("parseZcodeSkillsList", () => {
  it("maps skills entries onto provider skills, sorted by name", () => {
    const skills = parseZcodeSkillsList(
      listPayload([
        {
          name: "writing-docs",
          description: "Write user docs.",
          directory: "/home/dev/.agents/skills/writing-docs",
          path: "/home/dev/.agents/skills/writing-docs/SKILL.md",
          scope: "user",
          source: "agents",
        },
        {
          name: "control-browser",
          description: "Drive the browser.",
          path: "/home/dev/.zcode/cli/plugins/cache/official/browser-use/0.4.2/skills/control-browser/SKILL.md",
          scope: "system",
          source: "plugin",
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "control-browser",
        description: "Drive the browser.",
        path: "/home/dev/.zcode/cli/plugins/cache/official/browser-use/0.4.2/skills/control-browser/SKILL.md",
        scope: "system",
        enabled: true,
      },
      {
        name: "writing-docs",
        description: "Write user docs.",
        path: "/home/dev/.agents/skills/writing-docs/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("skips entries without a name or a filesystem path", () => {
    const skills = parseZcodeSkillsList(
      listPayload([
        { name: "  ", path: "/tmp/skills/a/SKILL.md" },
        { name: "no-path" },
        { name: "no-path-at-all", path: "   " },
        "not-an-object",
        { name: "kept", path: "/repo/skills/kept/SKILL.md" },
      ]),
    );

    expect(skills).toEqual([{ name: "kept", path: "/repo/skills/kept/SKILL.md", enabled: true }]);
  });

  it("dedupes repeated names, keeping the last entry", () => {
    const skills = parseZcodeSkillsList(
      listPayload([
        { name: "dup", path: "/first/SKILL.md" },
        { name: "dup", path: "/second/SKILL.md", scope: "user" },
      ]),
    );

    expect(skills).toEqual([
      { name: "dup", path: "/second/SKILL.md", scope: "user", enabled: true },
    ]);
  });

  it("returns an empty list for unparseable output", () => {
    expect(parseZcodeSkillsList("not json")).toEqual([]);
    expect(parseZcodeSkillsList(JSON.stringify({}))).toEqual([]);
    expect(parseZcodeSkillsList(JSON.stringify({ skills: "nope" }))).toEqual([]);
  });
});

describe("discoverZcodeSkills", () => {
  it.effect("spawns in the configured cwd and rejects a failed probe", () => {
    const spawnCwds: Array<string | undefined> = [];
    let exitCode = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      spawnCwds.push(command._tag === "StandardCommand" ? command.options.cwd : undefined);
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(
            Stream.make(
              listPayload([
                {
                  name: "kept",
                  path: "/workspaces/demo/skills/kept/SKILL.md",
                  scope: "user",
                },
              ]),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });

    return Effect.gen(function* () {
      const skills = yield* discoverZcodeSkills(
        { binaryPath: "zcode" },
        {},
        "/workspaces/demo",
      ).pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));

      expect(spawnCwds).toEqual(["/workspaces/demo"]);
      expect(skills.map((skill) => skill.name)).toEqual(["kept"]);

      exitCode = 1;
      const failed = yield* discoverZcodeSkills({ binaryPath: "zcode" }).pipe(
        Effect.result,
        Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
      expect(failed._tag).toBe("Failure");
    });
  });
});
