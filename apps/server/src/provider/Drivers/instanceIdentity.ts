import type { ModelBackendConfig, ProviderDriverKind, ServerProvider } from "@t3tools/contracts";

import type { ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * driver-kind-only snapshot helpers. Every driver builds its snapshot without
 * knowing its own instance, so it pipes the draft through this stamper before
 * publishing. `backend` is always passed explicitly (possibly `undefined`):
 * the absent-backend-means-no-backend-block rule lives here, not in a
 * conditional spread at each call site — except for a silent native fallback
 * (`nativeFallback`), which emits a native backend block carrying the marker
 * so the fallback stays visible in the snapshot. Once `buildServerProvider`
 * in `providerSnapshot.ts` is widened to accept `instanceId`/`driver`, this
 * wrapper disappears.
 */
export const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly driverKind: ProviderDriverKind;
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly backend: ModelBackendConfig | undefined;
    readonly nativeFallback?: boolean | undefined;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => {
    const backendKind = input.backend?.kind ?? "native";
    return {
      ...snapshot,
      instanceId: input.instanceId,
      driver: input.driverKind,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: input.continuationGroupKey },
      ...(input.backend === undefined && input.nativeFallback !== true
        ? {}
        : {
            backend: {
              kind: backendKind,
              ...(input.backend?.displayName ? { displayName: input.backend.displayName } : {}),
              viaProxy: backendKind !== "native",
              ...(backendKind !== "native" ? { capabilitiesDegraded: true as const } : {}),
              ...(input.nativeFallback === true ? { nativeFallback: true as const } : {}),
            },
          }),
    };
  };
