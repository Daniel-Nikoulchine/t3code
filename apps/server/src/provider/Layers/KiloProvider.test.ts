import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  kiloModelsFromSettings,
  kiloSlashCommands,
  parseKiloAuthListOutput,
  parseKiloModelsCliOutput,
  parseKiloVersion,
} from "./KiloProvider.ts";

describe("Kilo provider metadata", () => {
  it("reads the CLI version", () => {
    expect(parseKiloVersion("7.4.23")).toBe("7.4.23");
    expect(parseKiloVersion("kilo version 7.4.23 (abc1234)")).toBe("7.4.23");
    expect(parseKiloVersion("no version here")).toBeNull();
  });

  it("parses provider/model lines from kilo models", () => {
    expect(
      parseKiloModelsCliOutput(
        [
          "kilo/anthropic/claude-opus-4.7",
          "anthropic/claude-sonnet-4-20250514",
          "openai/gpt-5.4",
          "",
          "Models cache refreshed",
          "anthropic/claude-sonnet-4-20250514",
          "not-a-model-line",
        ].join("\n"),
      ),
    ).toEqual([
      {
        slug: "kilo/anthropic/claude-opus-4.7",
        name: "claude-opus-4.7",
        isCustom: false,
        subProvider: "kilo/anthropic",
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "anthropic/claude-sonnet-4-20250514",
        name: "claude-sonnet-4-20250514",
        isCustom: false,
        subProvider: "anthropic",
        capabilities: { optionDescriptors: [] },
      },
      {
        slug: "openai/gpt-5.4",
        name: "gpt-5.4",
        isCustom: false,
        subProvider: "openai",
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("surfaces the upstream for nested Kilo Gateway ids", () => {
    expect(parseKiloModelsCliOutput("kilo/~anthropic/claude-fable-latest")).toEqual([
      {
        slug: "kilo/~anthropic/claude-fable-latest",
        name: "claude-fable-latest",
        isCustom: false,
        subProvider: "kilo/anthropic",
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("returns no models for empty or unparseable output", () => {
    expect(parseKiloModelsCliOutput("")).toEqual([]);
    expect(parseKiloModelsCliOutput("help text without models\n--verbose\n")).toEqual([]);
  });

  it("never surfaces the t3-backend harness bucket as subProvider", () => {
    expect(parseKiloModelsCliOutput("t3-backend/opencode-go/gpt-5.6")).toEqual([
      {
        slug: "t3-backend/opencode-go/gpt-5.6",
        name: "gpt-5.6",
        isCustom: false,
        subProvider: "opencode-go",
        capabilities: { optionDescriptors: [] },
      },
    ]);
    expect(parseKiloModelsCliOutput("t3-backend/gpt-5.6")).toEqual([
      {
        slug: "t3-backend/gpt-5.6",
        name: "gpt-5.6",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("degrades a stale bucket-prefixed kilo id to the bare model", () => {
    expect(parseKiloModelsCliOutput("t3-backend/t3-backend/probe-go")).toEqual([
      {
        slug: "t3-backend/probe-go",
        name: "probe-go",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("interprets kilo auth list output", () => {
    expect(parseKiloAuthListOutput("You are logged in with Kilo.")).toBe(true);
    expect(parseKiloAuthListOutput("Logged in as user@example.com")).toBe(true);
    expect(parseKiloAuthListOutput("2 credentials")).toBe(true);
    expect(parseKiloAuthListOutput("0 credentials")).toBe(false);
    expect(parseKiloAuthListOutput("Not logged in. Run `kilo auth login`.")).toBe(false);
    expect(parseKiloAuthListOutput("No providers configured.")).toBe(false);
    expect(parseKiloAuthListOutput("provider status table")).toBeNull();
  });

  it("keeps the auto sentinel as the built-in default and merges customs", () => {
    const models = kiloModelsFromSettings([
      " anthropic/claude-sonnet-4-20250514 ",
      "anthropic/claude-sonnet-4-20250514",
    ]);
    expect(models.map((model) => model.slug)).toEqual([
      "auto",
      "anthropic/claude-sonnet-4-20250514",
    ]);
    expect(models[0]).toEqual(
      expect.objectContaining({ slug: "auto", isDefault: true, isCustom: false }),
    );
  });

  it("normalizes advertised slash command names and hints", () => {
    expect(
      kiloSlashCommands([
        { name: "/model", description: "Switch model", input: { hint: "provider/model" } },
      ]),
    ).toEqual([{ name: "model", description: "Switch model", input: { hint: "provider/model" } }]);
  });

  it("tolerates advertised commands without an input hint", () => {
    expect(
      kiloSlashCommands([
        {
          name: "steer",
          description: "Redirect active work",
          input: {},
        } as unknown as EffectAcpSchema.AvailableCommand,
      ]),
    ).toEqual([{ name: "steer", description: "Redirect active work" }]);
  });

  it("strips all leading slashes from advertised slash command names", () => {
    expect(
      kiloSlashCommands([
        { name: "//steer", description: "Redirect active work", input: { hint: "" } },
      ]),
    ).toEqual([{ name: "steer", description: "Redirect active work" }]);
  });
});
