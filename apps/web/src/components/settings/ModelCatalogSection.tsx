import { useAtomValue } from "@effect/atom-react";
import {
  deriveModelCatalog,
  type ModelAvailabilityReason,
} from "@t3tools/client-runtime/model-catalog";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { buildInstanceConnections } from "./providerCredentials.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";

/** Why an instance cannot serve a model yet, in one short label. */
const GAP_REASON_LABELS: Readonly<Record<ModelAvailabilityReason, string>> = {
  "requires-api-key": "Needs API key",
  "subscription-bound": "Subscription-bound",
  "protocol-unsupported": "Protocol unsupported",
  "vendor-locked": "Vendor-locked",
};

/**
 * Read-only "Models" matrix of the Providers tab: one row per logical model
 * (exact slug), with the instances that serve it and the ones that plausibly
 * could but cannot yet. Derived entirely client-side via
 * `deriveModelCatalog` from provider snapshots plus the settings' connections
 * and instance links — no default-route editing here; the routing contract
 * lands with the model router.
 */
export function ModelCatalogSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const connections = settings.modelBackendConnections;
  const catalog = useMemo(
    () =>
      deriveModelCatalog({
        providers: serverProviders,
        connections,
        instanceConnections: buildInstanceConnections(settings.providerInstances),
      }),
    [serverProviders, connections, settings.providerInstances],
  );

  return (
    <SettingsSection {...searchableSetting("model-catalog")}>
      <p className="px-3 pb-1 text-xs text-muted-foreground sm:px-4">
        What each instance can serve today, and what is missing elsewhere. Read-only — models come
        from the instances' own lists and their provider connections.
      </p>
      {catalog.length === 0 ? (
        <div className="px-3 py-3 sm:px-4">
          <p className="text-sm font-medium text-foreground">No models discovered yet.</p>
          <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">
            Models appear once an enabled instance has loaded its model list.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border/50 overflow-hidden">
          {catalog.map((model) => (
            <div
              key={model.modelId}
              className="flex min-h-14 items-start gap-3 px-3 py-2.5 sm:px-4"
            >
              <span className="flex min-w-0 basis-64 shrink-0 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {model.displayName}
                  </span>
                  {model.displayName !== model.modelId ? (
                    <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                      {model.modelId}
                    </code>
                  ) : null}
                </span>
                {model.vendor ? (
                  <Badge variant="outline" size="sm" className="mt-0.5 w-fit font-normal">
                    {model.vendor}
                  </Badge>
                ) : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 pt-0.5">
                {model.sources.map((source) => (
                  <span
                    key={`s-${source.instanceId}`}
                    className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-foreground/80"
                  >
                    {source.instanceId}
                    {source.authMode === "subscription" ? (
                      <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                        Subscription
                      </span>
                    ) : null}
                  </span>
                ))}
                {model.gaps.map((gap) => (
                  <span
                    key={`g-${gap.instanceId}`}
                    className="inline-flex items-center rounded-md border border-border/50 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {gap.instanceId} · {GAP_REASON_LABELS[gap.reason]}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
