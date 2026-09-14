import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverDroidSkills,
  hasDroidSkillMention,
  probeDroidSkills,
  rewriteDroidSkillMentions,
} from "./DroidSkills.ts";

it.layer(NodeServices.layer)("DroidSkills", (it) => {
  it.effect("discovers project and personal skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "droid-skills-home-",
      });
      const project = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "droid-skills-project-",
      });
      const writeSkill = Effect.fn("writeDroidSkill")(function* (
        root: string,
        name: string,
        contents: string,
      ) {
        const skillDirectory = path.join(root, name);
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
      });

      yield* writeSkill(
        path.join(project, ".factory", "skills"),
        "summarize-diff",
        "---\nname: summarize-diff\ndescription: Summarize the staged git diff.\n---\n",
      );
      yield* writeSkill(
        path.join(project, ".agents", "skills"),
        "compat-skill",
        "---\nname: compat-skill\ndescription: Compatibility folder skill.\n---\n",
      );
      yield* writeSkill(
        path.join(home, ".factory", "skills"),
        "personal-skill",
        "---\nname: personal-skill\ndescription: Personal workflow.\nuser-invocable: false\n---\n",
      );

      const skills = yield* discoverDroidSkills(project, { HOME: home });
      assert.deepStrictEqual(skills, [
        {
          name: "compat-skill",
          path: path.join(project, ".agents", "skills", "compat-skill", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Compatibility folder skill.",
        },
        {
          name: "personal-skill",
          path: path.join(home, ".factory", "skills", "personal-skill", "SKILL.md"),
          scope: "user",
          enabled: false,
          description: "Personal workflow.",
          userInvocable: false,
        },
        {
          name: "summarize-diff",
          path: path.join(project, ".factory", "skills", "summarize-diff", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Summarize the staged git diff.",
        },
      ]);
      assert.strictEqual(
        (yield* probeDroidSkills(project, { HOME: home }).pipe(Effect.result))._tag,
        "Success",
      );
    }),
  );

  it("detects and rewrites $skill mentions to native slash form", () => {
    assert.isTrue(hasDroidSkillMention("please run $summarize-diff now"));
    assert.isFalse(hasDroidSkillMention("no mention here"));
    assert.strictEqual(
      rewriteDroidSkillMentions("run $summarize-diff and $unknown", new Set(["summarize-diff"])),
      "run /summarize-diff and $unknown",
    );
  });
});
