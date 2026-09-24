import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const draft: ServerProviderDraft = {
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const baseInput = {
  instanceId: ProviderInstanceId.make("cursor_proxy"),
  driverKind: ProviderDriverKind.make("cursor"),
  displayName: "Cursor",
  accentColor: undefined,
  continuationGroupKey: "cursor:instance:cursor_proxy",
  backend: undefined,
} as const;

describe("withInstanceIdentity backend stamp", () => {
  it("omits backend when no backend is configured (native = absent)", () => {
    const stamped = withInstanceIdentity(baseInput)(draft);

    expect(stamped.backend).toBeUndefined();
  });

  it("stamps native backend as non-proxied without degraded capabilities", () => {
    const stamped = withInstanceIdentity({
      ...baseInput,
      backend: { kind: "native" as const },
    })(draft);

    expect(stamped.backend).toEqual({ kind: "native", viaProxy: false });
  });

  it("stamps openai-compatible backend as proxied with degraded capabilities", () => {
    const stamped = withInstanceIdentity({
      ...baseInput,
      backend: {
        kind: "openai-compatible" as const,
        baseUrl: "http://127.0.0.1:20128/v1",
        displayName: "OmniRoute",
      },
    })(draft);

    expect(stamped.backend).toEqual({
      kind: "openai-compatible",
      displayName: "OmniRoute",
      viaProxy: true,
      capabilitiesDegraded: true,
    });
  });

  it("stamps an orphaned connection as native with the fallback marker", () => {
    const stamped = withInstanceIdentity({
      ...baseInput,
      backend: undefined,
      nativeFallback: true,
    })(draft);

    expect(stamped.backend).toEqual({ kind: "native", viaProxy: false, nativeFallback: true });
  });
});
