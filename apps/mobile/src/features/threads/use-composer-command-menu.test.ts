import { describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));

vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import {
  buildComposerSlashCommandItems,
  resolveComposerCommandSelection,
} from "./use-composer-command-menu";

describe("mobile slash commands", () => {
  const antigravity = {
    driver: ProviderDriverKind.make("antigravity"),
    slashCommands: [{ name: "plan", description: "Plan with Antigravity" }],
  };

  it("keeps native /plan as plain text", () => {
    const items = buildComposerSlashCommandItems({
      query: "pl",
      atMessageStart: true,
      hasThread: true,
      selectedProviderStatus: antigravity,
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("provider-slash-command");
    const item = items[0];
    if (!item) throw new Error("Expected the native plan command");
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/pl",
        trigger: { rangeStart: 0, rangeEnd: 3 },
        item,
      }),
    ).toEqual({ text: "/plan ", cursor: 6 });
  });

  it("does not offer a native command inside the message", () => {
    expect(
      buildComposerSlashCommandItems({
        query: "plan",
        atMessageStart: false,
        hasThread: false,
        selectedProviderStatus: antigravity,
      }),
    ).toEqual([]);
  });

  it("treats /plan as plain text with no mode switch", () => {
    const items = buildComposerSlashCommandItems({
      query: "plan",
      atMessageStart: true,
      hasThread: true,
      selectedProviderStatus: {
        driver: ProviderDriverKind.make("codex"),
        slashCommands: [],
      },
    });
    // No T3 plan command remains; only provider commands match.
    expect(items).toEqual([]);

    const providerPlan = {
      id: "pcmd:plan",
      type: "provider-slash-command" as const,
      command: { name: "plan", description: "Plan with provider" },
      label: "/plan",
      description: "Plan with provider",
    };
    expect(
      resolveComposerCommandSelection({
        draftMessage: "/plan",
        trigger: { rangeStart: 0, rangeEnd: 5 },
        item: providerPlan,
      }),
    ).toEqual({ text: "/plan ", cursor: 6 });
  });
});
