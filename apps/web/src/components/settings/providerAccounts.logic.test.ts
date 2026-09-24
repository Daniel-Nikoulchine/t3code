import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isSignedInProviderAccount } from "./providerAccounts.logic";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated", type: "chatgpt", label: "ChatGPT Plus Subscription" },
    checkedAt: "2026-09-16T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("isSignedInProviderAccount", () => {
  it("counts a signed-in ChatGPT account", () => {
    expect(isSignedInProviderAccount(provider())).toBe(true);
  });

  it("counts a signed-in Claude account", () => {
    expect(
      isSignedInProviderAccount(
        provider({
          driver: ProviderDriverKind.make("claudeAgent"),
          auth: { status: "authenticated", type: "max", label: "Max" },
        }),
      ),
    ).toBe(true);
  });

  it("keeps API-key logins out of the account rows", () => {
    expect(
      isSignedInProviderAccount(
        provider({ auth: { status: "authenticated", type: "apiKey", label: "OpenAI API Key" } }),
      ),
    ).toBe(false);
  });

  it("ignores unauthenticated, disabled, and non-OAuth drivers", () => {
    expect(isSignedInProviderAccount(provider({ auth: { status: "unauthenticated" } }))).toBe(
      false,
    );
    expect(isSignedInProviderAccount(provider({ enabled: false }))).toBe(false);
    expect(
      isSignedInProviderAccount(provider({ driver: ProviderDriverKind.make("deepseek") })),
    ).toBe(false);
  });
});
