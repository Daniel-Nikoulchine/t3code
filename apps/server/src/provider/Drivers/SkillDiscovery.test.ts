import { describe, expect, it } from "vite-plus/test";

import {
  extractFrontmatterBlock,
  hasSkillMention,
  makeSkillScanBudget,
  parseFrontmatterRecord,
  rewriteSkillMentions,
} from "./SkillDiscovery.ts";

const MENTION = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;
const HAS_MENTION = /(^|\s)\$[a-zA-Z][a-zA-Z0-9:_-]*(?=\s|$)/;

describe("SkillDiscovery primitives", () => {
  it("extracts the frontmatter block only when present", () => {
    expect(extractFrontmatterBlock("---\nname: x\n---\nbody")).toBe("name: x");
    expect(extractFrontmatterBlock("no frontmatter here")).toBeUndefined();
  });

  it("parses records and rejects invalid YAML", () => {
    expect(parseFrontmatterRecord("name: x")).toEqual({ name: "x" });
    // Non-record YAML passes through like in every driver: mappers read
    // named fields off it and treat a list as empty frontmatter.
    expect(parseFrontmatterRecord("- just\n- a\n- list")).toEqual(["just", "a", "list"]);
    expect(parseFrontmatterRecord("{unclosed")).toBeUndefined();
  });

  it("scans and rewrites $mentions with a driver render target", () => {
    expect(hasSkillMention(HAS_MENTION, "use $ask-matt please")).toBe(true);
    expect(hasSkillMention(HAS_MENTION, "no mention")).toBe(false);
    expect(
      rewriteSkillMentions(
        MENTION,
        "use $ask-matt and $unknown",
        new Set(["ask-matt"]),
        (name) => `/${name}`,
      ),
    ).toBe("use /ask-matt and $unknown");
  });

  it("starts budgets with the shared limits", () => {
    const budget = makeSkillScanBudget();
    expect(budget.remainingEntries).toBe(10_000);
    expect(budget.exhausted).toBe(false);
    expect(budget.incomplete).toBe(false);
  });
});
