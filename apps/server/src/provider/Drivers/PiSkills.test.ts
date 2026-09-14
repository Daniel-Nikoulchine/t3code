import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverPiSkills,
  hasPiSkillMention,
  parsePiSkillFrontmatter,
  probePiSkills,
  rewritePiSkillMentions,
} from "./PiSkills.ts";

it.layer(NodeServices.layer)("PiSkills", (it) => {
  it.effect("discovers flat and nested skills under PI_CODING_AGENT_DIR", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const piHome = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "pi-skills-home-",
      });
      const emptyHome = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "pi-skills-empty-home-",
      });
      const isolatedEnv = {
        PI_CODING_AGENT_DIR: piHome,
        HOME: emptyHome,
        USERPROFILE: emptyHome,
      };
      const writeSkill = Effect.fn("writePiSkill")(function* (
        root: string,
        name: string,
        contents: string,
      ) {
        const skillDirectory = path.join(root, name);
        yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
        yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
      });

      yield* writeSkill(
        path.join(piHome, "skills"),
        "ask-matt",
        "---\nname: ask-matt\ndescription: Ask which skill fits.\ndisable-model-invocation: true\n---\n",
      );
      yield* writeSkill(
        path.join(piHome, "skills", "grouped"),
        "t3-code",
        "---\nname: t3-code\ndescription: Build T3 Code.\n---\n",
      );
      // Skills without a description are not loaded by pi.
      yield* writeSkill(
        path.join(piHome, "skills"),
        "undescribed",
        "---\nname: undescribed\n---\n",
      );

      const skills = yield* discoverPiSkills(isolatedEnv);
      assert.deepStrictEqual(skills, [
        {
          name: "ask-matt",
          path: path.join(piHome, "skills", "ask-matt", "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Ask which skill fits.",
          userInvocationOnly: true,
        },
        {
          name: "t3-code",
          path: path.join(piHome, "skills", "grouped", "t3-code", "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Build T3 Code.",
        },
      ]);
      assert.strictEqual((yield* probePiSkills(isolatedEnv).pipe(Effect.result))._tag, "Success");
    }),
  );

  it.effect("discovers project skills below the workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "pi-skills-workspace-",
      });
      const emptyHome = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "pi-skills-empty-home-",
      });
      const skillDirectory = path.join(workspace, ".pi", "skills", "review");
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(skillDirectory, "SKILL.md"),
        "---\nname: review\ndescription: Review code.\n---\n",
      );

      const skills = yield* discoverPiSkills(
        {
          PI_CODING_AGENT_DIR: path.join(workspace, "empty-pi-home"),
          HOME: emptyHome,
          USERPROFILE: emptyHome,
        },
        workspace,
      );
      assert.deepStrictEqual(
        skills.map((skill) => ({ name: skill.name, scope: skill.scope })),
        [{ name: "review", scope: "project" }],
      );
    }),
  );

  it("rewrites only known $mentions to /skill: form", () => {
    assert.isTrue(hasPiSkillMention("use $ask-matt here"));
    assert.isFalse(hasPiSkillMention("no mention"));
    assert.strictEqual(
      rewritePiSkillMentions("run $ask-matt then $unknown", new Set(["ask-matt"])),
      "run /skill:ask-matt then $unknown",
    );
  });

  it("parses skill frontmatter", () => {
    assert.deepStrictEqual(parsePiSkillFrontmatter("---\nname: x\ndescription: Y.\n---\nbody"), {
      name: "x",
      description: "Y.",
    });
    assert.isUndefined(parsePiSkillFrontmatter("---\n: bad: [\n---\n"));
  });
});
