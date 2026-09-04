import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverHermesSkills,
  hasHermesSkillMention,
  probeHermesSkills,
  rewriteHermesSkillMentions,
} from "./HermesSkills.ts";

it.layer(NodeServices.layer)("HermesSkills", (it) => {
  it.effect("discovers flat and nested skills under HERMES_HOME", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const hermesHome = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "hermes-skills-home-",
      });
      const writeSkill = Effect.fn("writeHermesSkill")(function* (
        root: string,
        name: string,
        contents: string,
      ) {
        const skillDirectory = path.join(root, name);
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
      });

      yield* writeSkill(
        path.join(hermesHome, "skills"),
        "ask-matt",
        "---\nname: ask-matt\ndescription: Ask which skill fits.\ndisable-model-invocation: true\n---\n",
      );
      yield* writeSkill(
        path.join(hermesHome, "skills", "autonomous-ai-agents"),
        "t3-code",
        "---\nname: t3-code\ndescription: Build T3 Code.\n---\n",
      );

      const skills = yield* discoverHermesSkills({ HERMES_HOME: hermesHome });
      assert.deepStrictEqual(skills, [
        {
          name: "ask-matt",
          path: path.join(hermesHome, "skills", "ask-matt", "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Ask which skill fits.",
          userInvocationOnly: true,
        },
        {
          name: "t3-code",
          path: path.join(hermesHome, "skills", "autonomous-ai-agents", "t3-code", "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Build T3 Code.",
        },
      ]);
      assert.strictEqual(
        (yield* probeHermesSkills({ HERMES_HOME: hermesHome }).pipe(Effect.result))._tag,
        "Success",
      );
    }),
  );

  it("rewrites only known $mentions to native slash form", () => {
    assert.isTrue(hasHermesSkillMention("use $ask-matt here"));
    assert.isFalse(hasHermesSkillMention("no mention"));
    assert.strictEqual(
      rewriteHermesSkillMentions("run $ask-matt then $unknown", new Set(["ask-matt"])),
      "run /ask-matt then $unknown",
    );
  });
});
