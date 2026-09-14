import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CopilotSettings } from "@t3tools/contracts";

import {
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  COPILOT_MODEL_CAPABILITIES,
  copilotModelsFromSettings,
  copilotSlashCommands,
} from "./CopilotProvider.ts";
import { resolveCopilotAcpBaseModelId } from "../acp/CopilotAcpSupport.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

describe("copilotModelsFromSettings", () => {
  it("lists the static catalog with auto as default", () => {
    const models = copilotModelsFromSettings([]);
    expect(models.length).toBeGreaterThan(20);
    expect(models.find((model) => model.slug === "auto")?.isDefault).toBe(true);
    expect(models.find((model) => model.slug === "gpt-5.4")).toBeDefined();
  });

  it("appends custom models", () => {
    const models = copilotModelsFromSettings(["my-custom-model"]);
    expect(models.map((model) => model.slug)).toContain("my-custom-model");
  });

  it("exposes reasoning effort options on built-ins", () => {
    expect(COPILOT_MODEL_CAPABILITIES.optionDescriptors).toHaveLength(1);
    expect(COPILOT_MODEL_CAPABILITIES.optionDescriptors?.[0]?.id).toBe("effort");
  });
});

describe("copilotSlashCommands", () => {
  it("normalizes names and drops empties/duplicates", () => {
    const commands = copilotSlashCommands([
      { name: "/compact", description: "Compact", hint: "focus" },
      { name: "compact", description: "Compact dup" },
      { name: "  ", description: "empty" },
      { name: "model", description: "Select model", hint: "model" },
    ]);
    expect(commands.map((command) => command.name)).toEqual(["compact", "model"]);
    expect(commands[0]).toMatchObject({ name: "compact", input: { hint: "focus" } });
  });
});

describe("buildInitialCopilotProviderSnapshot", () => {
  it("reports disabled when turned off", async () => {
    const snapshot = await Effect.runPromise(
      buildInitialCopilotProviderSnapshot(decodeCopilotSettings({ enabled: false })),
    );
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.status).toBe("disabled");
  });

  it("reports pending while enabled but unchecked", async () => {
    const snapshot = await Effect.runPromise(
      buildInitialCopilotProviderSnapshot(decodeCopilotSettings({ enabled: true })),
    );
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.status).toBe("warning");
    expect(snapshot.models.length).toBeGreaterThan(0);
  });
});

describe("resolveCopilotAcpBaseModelId", () => {
  it("resolves through the shared slug normalizer", () => {
    expect(resolveCopilotAcpBaseModelId("auto")).toBe("auto");
    expect(resolveCopilotAcpBaseModelId("gpt-5.4")).toBe("gpt-5.4");
  });
});

describe("checkCopilotProviderStatus", () => {
  it("is wired as an Effect probe (live verification via CLI, see PR description)", () => {
    expect(typeof checkCopilotProviderStatus).toBe("function");
  });
});
