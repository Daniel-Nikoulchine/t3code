import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverKiloSkills,
  hasKiloSkillMention,
  probeKiloSkills,
  rewriteKiloSkillMentions,
} from "./KiloSkills.ts";

it.layer(NodeServices.layer)("KiloSkills", (it) => {
  it.effect("discovers project and user-global skills with scopes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const writeSkill = Effect.fn("writeKiloSkill")(function* (
        root: string,
        name: string,
        contents: string,
      ) {
        const skillDirectory = path.join(root, name);
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
      });

      const workspace = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "kilo-skills-workspace-",
      });
      const fakeHome = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "kilo-skills-home-",
      });

      yield* writeSkill(
        path.join(workspace, ".kilo", "skills"),
        "ask-matt",
        "---\nname: ask-matt\ndescription: Ask which skill fits.\ndisable-model-invocation: true\n---\n",
      );
      yield* writeSkill(
        path.join(workspace, ".agents", "skills"),
        "shared-skill",
        "---\nname: shared-skill\ndescription: Shared skill.\n---\n",
      );
      yield* writeSkill(
        path.join(fakeHome, ".config", "kilo", "skills"),
        "global-skill",
        "---\nname: global-skill\ndescription: Global skill.\n---\n",
      );

      const skills = yield* discoverKiloSkills(workspace, { HOME: fakeHome });
      assert.deepStrictEqual(skills, [
        {
          name: "ask-matt",
          path: path.join(workspace, ".kilo", "skills", "ask-matt", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Ask which skill fits.",
          userInvocationOnly: true,
        },
        {
          name: "global-skill",
          path: path.join(fakeHome, ".config", "kilo", "skills", "global-skill", "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Global skill.",
        },
        {
          name: "shared-skill",
          path: path.join(workspace, ".agents", "skills", "shared-skill", "SKILL.md"),
          scope: "project",
          enabled: true,
          description: "Shared skill.",
        },
      ]);
      assert.strictEqual(
        (yield* probeKiloSkills(workspace, { HOME: fakeHome }).pipe(Effect.result))._tag,
        "Success",
      );
    }),
  );

  it("rewrites only known $mentions to native slash form", () => {
    assert.isTrue(hasKiloSkillMention("use $ask-matt here"));
    assert.isFalse(hasKiloSkillMention("no mention"));
    assert.strictEqual(
      rewriteKiloSkillMentions("run $ask-matt then $unknown", new Set(["ask-matt"])),
      "run /ask-matt then $unknown",
    );
  });
});
