import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import {
  discoverDevinSkills,
  hasDevinSkillMention,
  probeDevinSkills,
  rewriteDevinSkillMentions,
} from "./DevinSkills.ts";

const writeSkill = Effect.fn("writeSkill")(function* (directory: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const skillPath = path.join(directory, "SKILL.md");
  yield* fileSystem.writeFileString(skillPath, contents);
  return skillPath;
});

describe("Devin skill mentions", () => {
  it("detects $mentions and rewrites known skills to slash commands", () => {
    expect(hasDevinSkillMention("please $review this")).toBe(true);
    expect(hasDevinSkillMention("no mentions here")).toBe(false);
    expect(rewriteDevinSkillMentions("run $review and $deploy", new Set(["review"]))).toBe(
      "run /review and $deploy",
    );
  });
});

it.layer(NodeServices.layer)("discoverDevinSkills", (it) => {
  it.effect("reads project and user skills, preferring the first root per name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-devin-skills-",
      });
      const cwd = path.join(temporaryDirectory, "workspace");
      const home = path.join(temporaryDirectory, "home");
      const environment = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
      };

      const projectSkillPath = yield* writeSkill(
        path.join(cwd, ".devin", "skills", "review"),
        "---\nname: review\ndescription: Review code changes.\n---\n# Review\n",
      );
      const userSkillPath = yield* writeSkill(
        path.join(home, ".config", "devin", "skills", "deploy"),
        "---\nname: deploy\ndescription: Deploy the app.\n---\n# Deploy\n",
      );
      // A duplicate name in a later root must not shadow the first one.
      yield* writeSkill(
        path.join(home, ".agents", "skills", "review"),
        "---\nname: review\ndescription: Shadowed duplicate.\n---\n# Shadow\n",
      );

      assert.deepEqual(yield* discoverDevinSkills(cwd, environment), [
        {
          name: "deploy",
          description: "Deploy the app.",
          path: userSkillPath,
          scope: "user",
          enabled: true,
        },
        {
          name: "review",
          description: "Review code changes.",
          path: projectSkillPath,
          scope: "project",
          enabled: true,
        },
      ]);
    }),
  );

  it.effect("returns no skills when all roots are missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-devin-skills-empty-",
      });
      const environment = {
        ...process.env,
        HOME: path.join(temporaryDirectory, "home"),
        XDG_CONFIG_HOME: path.join(temporaryDirectory, "home", ".config"),
      };
      assert.deepEqual(
        yield* discoverDevinSkills(path.join(temporaryDirectory, "workspace"), environment),
        [],
      );
    }),
  );

  it.effect("probeDevinSkills succeeds on a readable workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-devin-skills-probe-",
      });
      const environment = {
        ...process.env,
        HOME: path.join(temporaryDirectory, "home"),
        XDG_CONFIG_HOME: path.join(temporaryDirectory, "home", ".config"),
      };
      assert.deepEqual(
        yield* probeDevinSkills(path.join(temporaryDirectory, "workspace"), environment),
        [],
      );
    }),
  );
});
