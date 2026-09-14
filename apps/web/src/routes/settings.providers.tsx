import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { ProviderBackendsPanel } from "../components/settings/ProviderBackendsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

/**
 * All provider settings live on this tab (connections, API keys, the models
 * matrix, and the harness instance editor), scoped to one environment: the
 * chosen one, or the representative of the selection. A project crumb narrows
 * the candidates to the environments that project is registered on. The old
 * `/settings/harness` route redirects here, carrying its search along.
 */
function SettingsProvidersRoute() {
  const { instanceId } = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its providers.`
          : "Connect an environment to set up its providers."}
      </p>
    );
  }
  return (
    <ProviderBackendsPanel
      environmentId={environment.environmentId}
      {...(instanceId ? { instanceId } : {})}
      scoped
    />
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsProvidersRoute,
});
