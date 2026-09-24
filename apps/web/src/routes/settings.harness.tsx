import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

import { EnvironmentProviderSettings } from "../components/settings/ProviderSettingsPanel";
import { SelectedEnvironmentProviderSettings } from "../components/settings/providerSettingsEnvironment";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

/**
 * The Harness tab: the full per-environment harness instance editor
 * (Display, Setup, Sign in, Connection, Models, Runtime, Environment).
 * The Providers tab holds only the shared model backend settings
 * (connections, API keys, routing) below no instance editor.
 */
function SettingsHarnessRoute() {
  const { instanceId } = Route.useSearch();
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its harness instances.`
          : "Connect an environment to set up its harness instances."}
      </p>
    );
  }
  return (
    <SettingsPageContainer width="wide" className="gap-8">
      <SelectedEnvironmentProviderSettings
        key={environment.environmentId}
        environment={environment}
        searchAnchorId="providers"
        targetInstanceId={instanceId}
        render={(gated) => (
          <EnvironmentProviderSettings
            environmentId={gated.environmentId}
            environmentLabel={gated.environmentLabel}
            readOnly={gated.readOnly}
            headerLabel="Harness"
            {...(gated.targetInstanceId !== undefined
              ? { targetInstanceId: gated.targetInstanceId }
              : {})}
          />
        )}
      />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/harness")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: SettingsHarnessRoute,
});
