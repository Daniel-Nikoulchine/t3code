import { useNavigation } from "@react-navigation/native";
import {
  resolveProviderBackendLabel,
  resolveProviderInstanceDisplayName,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { ModelProxyConfig } from "@t3tools/contracts";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { relativeTime } from "../../lib/time";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { SettingsSection } from "./components/SettingsSection";

/**
 * Read-only connections overview plus per-instance Own login/Provider status
 * (per-surface decision, not a gap: mobile has no settings-form
 * infrastructure, so there is no connection editor here).
 *
 * The top card lists every `ServerSettings.modelBackendConnections` entry per
 * environment: display name, base URL, and API key *variable name* only —
 * never secret values (settings only ever name the server-environment
 * variable). Each instance row then names the harness instance (shared
 * `resolveProviderInstanceDisplayName` helper, same as web) and its routing
 * from the provider snapshot (`resolveProviderBackendLabel` returns
 * `undefined` for native/direct connections — the same rule as
 * `isProviderProxied` in contracts): `Provider: <label>` when routed,
 * `Own login` otherwise. A `connectionId` whose entry is gone (deleted
 * connection) routes natively and the row calls it out. Editing (adding
 * connections and the per-instance selection) lives in the web/desktop app
 * under Settings → Providers (list plus button) and Settings → Harness
 * (selection).
 *
 * Deliberately no "Test connection" button here either (same scope boundary
 * as the editor): probing needs the Operate scope plus the settings-form
 * values that only web/desktop hold, and there is no polling or auto-test
 * anywhere. The "Last successful turn" age below is read-only snapshot data
 * (`backendLastVerifiedAt`, stamped by executed turns only), so it renders on
 * mobile like on web; it is omitted when absent (never verified).
 */
export function SettingsProvidersRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const connectionBlocks = environments.map((environment) => ({
    environment,
    connections: (environment.serverConfig?.settings?.modelBackendConnections ?? {}) as Readonly<
      Record<string, ModelProxyConfig>
    >,
  }));
  const rows = environments.flatMap((environment) =>
    (environment.serverConfig?.providers ?? []).map((snapshot) => {
      const connections: Readonly<Record<string, unknown>> =
        environment.serverConfig?.settings?.modelBackendConnections ?? {};
      const rawConnectionId =
        environment.serverConfig?.settings?.providerInstances?.[snapshot.instanceId]?.connectionId;
      const connectionId = rawConnectionId === undefined ? undefined : String(rawConnectionId);
      return {
        environment,
        snapshot,
        orphan: connectionId !== undefined && connections[connectionId] === undefined,
      };
    }),
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Providers" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Model providers" card>
          {connectionBlocks.map(({ environment, connections }, index) => {
            const entries = Object.entries(connections);
            return (
              <View
                key={environment.environmentId}
                className={index === 0 ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"}
              >
                <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                  {environment.label}
                </Text>
                {entries.length === 0 ? (
                  <Text className="text-base text-foreground-muted">
                    Not configured — add one in the web or desktop app under Settings → Providers.
                  </Text>
                ) : (
                  entries.map(([connectionId, connection]) => (
                    <View key={connectionId} className="gap-1 pt-2">
                      <View className="flex-row items-baseline justify-between gap-3">
                        <Text className="min-w-0 flex-1 text-lg text-foreground" numberOfLines={1}>
                          {connection.displayName?.trim() || connectionId}
                        </Text>
                        <Text className="shrink-0 text-base text-foreground-muted">Configured</Text>
                      </View>
                      <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                        {connection.baseUrl}
                      </Text>
                      {connection.apiKeyEnv ? (
                        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                          Key variable: {connection.apiKeyEnv}
                        </Text>
                      ) : null}
                    </View>
                  ))
                )}
              </View>
            );
          })}
          {connectionBlocks.length === 0 ? (
            <View className="p-4">
              <Text className="text-base text-foreground-muted">
                Connect an environment to see its model providers.
              </Text>
            </View>
          ) : null}
        </SettingsSection>
        <SettingsSection title="Model backends" card>
          {rows.map(({ environment, snapshot, orphan }, index) => {
            const backendLabel = resolveProviderBackendLabel(snapshot);
            const proxied = backendLabel !== undefined;
            const status = proxied ? `Provider: ${backendLabel}` : "Own login";
            return (
              <View
                key={`${environment.environmentId}:${snapshot.instanceId}`}
                className={index === 0 ? "gap-1 p-4" : "gap-1 border-t border-border-subtle p-4"}
              >
                <View className="flex-row items-baseline justify-between gap-3">
                  <Text className="min-w-0 flex-1 text-lg text-foreground" numberOfLines={1}>
                    {resolveProviderInstanceDisplayName(snapshot)}
                  </Text>
                  <Text className="shrink-0 text-base text-foreground-muted">{status}</Text>
                </View>
                <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                  {environment.label}
                </Text>
                {orphan ? (
                  <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                    Connection deleted — routing directly; pick another in the web or desktop app.
                  </Text>
                ) : null}
                {snapshot.backendLastVerifiedAt !== undefined ? (
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    Last successful turn: {relativeTime(snapshot.backendLastVerifiedAt)} ago
                  </Text>
                ) : null}
              </View>
            );
          })}
          {rows.length === 0 ? (
            <View className="p-4">
              <Text className="text-base text-foreground-muted">
                Connect an environment to see its model backends.
              </Text>
            </View>
          ) : null}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Edit providers and the per-harness selection in the web or desktop app under Settings →
          Providers and Settings → Harness.
        </Text>
      </ScrollView>
    </View>
  );
}
