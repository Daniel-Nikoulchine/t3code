import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverClineSkills,
  hasClineSkillMention,
  probeClineSkills,
  rewriteClineSkillMentions,
} from "./ClineSkills.ts";

it.layer(NodeServices.layer)("ClineSkills", (it) => {
  it.effect("discovers user skills below ~/.cline/skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "cline-skills-home-",
      });
      const skillDirectory = path.join(home, ".cline", "skills", "ask-matt");
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(skillDirectory, "SKILL.md"),
        "---\nname: ask-matt\ndescription: Ask which skill fits.\n---\n",
      );

      const skills = yield* discoverClineSkills(undefined, { HOME: home });
      assert.deepStrictEqual(skills, [
        {
          name: "ask-matt",
          path: path.join(skillDirectory, "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Ask which skill fits.",
        },
      ]);
    }),
  );

  it.effect("prefers project skills over same-named user skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "cline-skills-home-",
      });
      const project = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "cline-skills-project-",
      });
      for (const [base, scope] of [
        [home, "user"],
        [project, "project"],
      ] as const) {
        const skillDirectory = path.join(base, ".cline", "skills", "shared");
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(skillDirectory, "SKILL.md"),
          `---\nname: shared\ndescription: ${scope} copy.\n---\n`,
        );
      }

      const skills = yield* probeClineSkills(project, { HOME: home });
      assert.deepStrictEqual(skills, [
        {
          name: "shared",
          path: path.join(project, ".cline", "skills", "shared", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "project copy.",
        },
      ]);
    }),
  );

  it.effect("returns no skills for an empty home", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "cline-skills-empty-",
      });
      assert.deepStrictEqual(yield* discoverClineSkills(undefined, { HOME: home }), []);
    }),
  );
});

it("detects and rewrites $skill mentions", () => {
  assert.isTrue(hasClineSkillMention("ask $ask-matt now"));
  assert.isFalse(hasClineSkillMention("no mention here"));
  assert.equal(
    rewriteClineSkillMentions("ask $ask-matt and $unknown now", new Set(["ask-matt"])),
    "ask /ask-matt and $unknown now",
  );
});
