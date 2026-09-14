import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderInstanceTitle } from "./ProviderInstanceIcon";

describe("resolveProviderInstanceTitle", () => {
  it("prefers the explicit display name, trimmed", () => {
    expect(
      resolveProviderInstanceTitle({
        displayName: "  Work  ",
        driverLabel: "Codex",
        driver: "codex",
        accentColor: "#ff8800",
      }),
    ).toEqual({
      displayName: "Work",
      accentColor: "#ff8800",
      driverKind: ProviderDriverKind.make("codex"),
    });
  });

  it("falls back to the driver label when the name is blank", () => {
    expect(
      resolveProviderInstanceTitle({
        displayName: "   ",
        driverLabel: "Codex",
        driver: "codex",
        accentColor: undefined,
      }),
    ).toMatchObject({ displayName: "Codex" });
  });

  it("falls back to the raw driver slug without a label", () => {
    expect(
      resolveProviderInstanceTitle({
        displayName: undefined,
        driverLabel: undefined,
        driver: "codex",
        accentColor: undefined,
      }),
    ).toMatchObject({ displayName: "codex" });
  });

  it("passes non-slug drivers through as a null kind", () => {
    expect(
      resolveProviderInstanceTitle({
        displayName: undefined,
        driverLabel: undefined,
        driver: "not a driver!",
        accentColor: undefined,
      }),
    ).toEqual({ displayName: "not a driver!", accentColor: undefined, driverKind: null });
  });

  it("treats a non-hex accent color as unset", () => {
    expect(
      resolveProviderInstanceTitle({
        displayName: "Codex",
        driverLabel: "Codex",
        driver: "codex",
        accentColor: "blue",
      }),
    ).toMatchObject({ accentColor: undefined });
  });
});
