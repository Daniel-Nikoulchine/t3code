import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { getProviderLoginCommand, getProviderLoginHint } from "./providerLoginCommands";

describe("providerLoginCommands", () => {
  it("returns the terminal login command per driver", () => {
    expect(getProviderLoginCommand(ProviderDriverKind.make("codex"))).toBe("codex login");
    expect(getProviderLoginCommand(ProviderDriverKind.make("claudeAgent"))).toBe(
      "claude auth login",
    );
    expect(getProviderLoginCommand(ProviderDriverKind.make("opencode"))).toBe(
      "opencode auth login",
    );
    expect(getProviderLoginCommand(ProviderDriverKind.make("freebuff"))).toBe("freebuff login");
  });

  it("has no terminal command for in-app sign-in drivers", () => {
    expect(getProviderLoginCommand(ProviderDriverKind.make("antigravity"))).toBeNull();
    expect(getProviderLoginCommand(undefined)).toBeNull();
  });

  it("hints at non-plain logins", () => {
    expect(getProviderLoginHint(ProviderDriverKind.make("pi"))).toContain("/login");
    expect(getProviderLoginHint(ProviderDriverKind.make("codex"))).toBeNull();
  });
});
