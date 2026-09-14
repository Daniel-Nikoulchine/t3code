import { describe, expect, it } from "@effect/vitest";

import {
  hasOpenClawSkillMention,
  parseOpenClawSkillsList,
  rewriteOpenClawSkillMentions,
} from "./OpenClawSkills.ts";

const skillsPayload = (skills: ReadonlyArray<unknown>) => JSON.stringify({ skills });

describe("parseOpenClawSkillsList", () => {
  it("maps skills list entries onto provider skills, sorted by name", () => {
    const skills = parseOpenClawSkillsList(
      skillsPayload([
        {
          name: "writing-docs",
          description: "Write user docs.",
          source: "openclaw-bundled",
          userInvocable: true,
        },
        {
          name: "add-model-provider",
          description: "Add a model provider.",
          source: "openclaw-custodian",
          eligible: true,
          userInvocable: true,
        },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "add-model-provider",
        path: "openclaw://skills/add-model-provider",
        enabled: true,
        scope: "openclaw-custodian",
        description: "Add a model provider.",
      },
      {
        name: "writing-docs",
        path: "openclaw://skills/writing-docs",
        enabled: true,
        scope: "openclaw-bundled",
        description: "Write user docs.",
      },
    ]);
  });

  it("disables skills the CLI marks as disabled or not user-invocable", () => {
    const skills = parseOpenClawSkillsList(
      skillsPayload([
        { name: "internal-helper", source: "openclaw-bundled", userInvocable: false },
        { name: "needs-setup", source: "openclaw-bundled", disabled: true },
      ]),
    );

    expect(skills).toEqual([
      {
        name: "internal-helper",
        path: "openclaw://skills/internal-helper",
        enabled: false,
        scope: "openclaw-bundled",
        userInvocable: false,
      },
      {
        name: "needs-setup",
        path: "openclaw://skills/needs-setup",
        enabled: false,
        scope: "openclaw-bundled",
      },
    ]);
  });

  it("skips entries without a name and tolerates invalid JSON", () => {
    expect(parseOpenClawSkillsList(skillsPayload([{ description: "no name" }, "nope"]))).toEqual(
      [],
    );
    expect(parseOpenClawSkillsList("not json")).toEqual([]);
    expect(parseOpenClawSkillsList(JSON.stringify({}))).toEqual([]);
  });
});

describe("openclaw skill mentions", () => {
  const names = new Set(["plan", "deploy"]);

  it("detects $mentions", () => {
    expect(hasOpenClawSkillMention("please $plan this")).toBe(true);
    expect(hasOpenClawSkillMention("no mentions")).toBe(false);
  });

  it("rewrites known $mentions and leaves unknown ones alone", () => {
    expect(rewriteOpenClawSkillMentions("run $plan and $unknown", names)).toBe(
      "run /plan and $unknown",
    );
  });
});
