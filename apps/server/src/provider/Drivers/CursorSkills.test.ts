// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverCursorSkills,
  hasCursorSkillMention,
  probeCursorSkills,
  rewriteCursorSkillMentions,
} from "./CursorSkills.ts";

it.layer(NodeServices.layer)("CursorSkills", (it) => {
  it.effect("discovers project and user skills", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "cursor-skills-home-",
      });
      const project = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "cursor-skills-project-",
      });
      const skillDirectory = path.join(home, ".cursor", "skills", "review-pr");
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(skillDirectory, "SKILL.md"),
        "---\nname: review-pr\ndescription: Review the pull request.\n---\n",
      );

      const skills = yield* discoverCursorSkills(project, { HOME: home });
      assert.deepStrictEqual(skills, [
        {
          name: "review-pr",
          path: path.join(skillDirectory, "SKILL.md"),
          scope: "user",
          enabled: true,
          description: "Review the pull request.",
        },
      ]);
      assert.strictEqual(
        (yield* probeCursorSkills(project, { HOME: home }).pipe(Effect.result))._tag,
        "Success",
      );
    }),
  );

  it("detects and rewrites $skill mentions to native slash form", () => {
    assert.isTrue(hasCursorSkillMention("please run $review-pr now"));
    assert.isFalse(hasCursorSkillMention("no mention here"));
    assert.isFalse(hasCursorSkillMention("costs $100 and $20k"));
    assert.strictEqual(
      rewriteCursorSkillMentions("run $review-pr and $unknown", new Set(["review-pr"])),
      "run /review-pr and $unknown",
    );
  });

  it.effect.skipIf(!symlinksSupported)(
    "reads a linked skill library without walking the target tree",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-boundary-home-",
        });
        const project = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-boundary-project-",
        });
        const library = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-boundary-library-",
        });
        const nested = path.join(library, "nested");
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(library, "SKILL.md"),
          "---\nname: linked-lib\ndescription: Linked skill library.\n---\n",
        );
        yield* fileSystem.writeFileString(
          path.join(nested, "SKILL.md"),
          "---\nname: nested-escape\ndescription: Must stay out.\n---\n",
        );
        const linkParent = path.join(project, ".cursor", "skills");
        yield* fileSystem.makeDirectory(linkParent, { recursive: true });
        yield* fileSystem.symlink(library, path.join(linkParent, "linked"));

        const skills = yield* discoverCursorSkills(project, { HOME: home });
        assert.deepStrictEqual(skills, [
          {
            name: "linked",
            path: path.join(linkParent, "linked", "SKILL.md"),
            scope: "project",
            enabled: true,
            displayName: "linked-lib",
            description: "Linked skill library.",
          },
        ]);
      }),
  );
});
