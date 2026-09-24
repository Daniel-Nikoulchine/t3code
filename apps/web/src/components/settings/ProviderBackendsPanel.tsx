import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ModelCredential,
  ModelProxyConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import { PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Spinner } from "../ui/spinner";
import { AddBackendConnectionDialog } from "./AddBackendConnectionDialog";
import { ProviderAuthSection } from "./ProviderAuthSection";
import { isSignedInProviderAccount } from "./providerAccounts.logic";
import {
  countConnectionReferences,
  inferBackendConnectionDriverKind,
  removeBackendConnection,
  toTestBackend,
} from "./providerBackend.logic";
import { useBackendConnectionProbe } from "./useBackendConnectionProbe";
import {
  providerCardClassName,
  providerCardHeightClassName,
  SelectedEnvironmentProviderSettings,
} from "./providerSettingsEnvironment";
import { searchableSetting } from "./settingsSearch";
import {
  PolicyTooltip,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  backgroundActivityOverrideSettings,
  durationToSeconds,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";
import { UsageProviderSettings } from "./UsageProviderSettings";
import { ProviderInstanceTitleIcon } from "../chat/ProviderInstanceIcon";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ProviderBackendsTarget {
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
  readonly scoped?: boolean;
}

/**
 * The Providers tab: the API connections harness instances can run on,
 * scoped to one environment. API keys are created inline from the
 * Add-provider dialog ("New key"). Harness instances themselves (sign-in,
 * connection, models, runtime, environment) live on the Harness tab.
 */
export function ProviderBackendsPanel(target: ProviderBackendsTarget) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Routes always render this tab scoped (see `routes/settings.providers.tsx`):
  // the breadcrumb scope picks the environment, so there are no device tabs.
  const effectiveEnvironmentId = target.environmentId ?? primaryEnvironmentId;
  const selectedEnvironment =
    environments.find((environment) => environment.environmentId === effectiveEnvironmentId) ??
    null;
  if (!selectedEnvironment) {
    return (
      <SettingsPageContainer width="wide" className="gap-8">
        <p className="p-8 text-sm text-muted-foreground">
          {isReady
            ? "Connect an environment to set up its model provider."
            : "Reading connected execution environments."}
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer width="wide" className="gap-8">
      <SelectedEnvironmentProviderSettings
        key={selectedEnvironment.environmentId}
        environment={selectedEnvironment}
        searchAnchorId="provider-backends"
        render={(gated) => (
          <EnvironmentProviderBackends
            environmentId={gated.environmentId}
            environmentLabel={gated.environmentLabel}
            readOnly={gated.readOnly}
          />
        )}
      />
    </SettingsPageContainer>
  );
}

export function EnvironmentProviderBackends({
  environmentId,
  environmentLabel,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /**
   * Grey out and freeze every write control when this session's credential
   * lacks `orchestration:operate` on the environment. The connection list
   * stays readable so the real routing stays visible.
   */
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  // Named connections are whole-map replacement (same as the server-side
  // `applyServerSettingsPatch` semantics): add/remove send the full map.
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const connections: Record<string, ModelProxyConfig> = settings.modelBackendConnections;
  const credentials: Record<string, ModelCredential> = settings.modelCredentials;
  const entries = Object.entries(connections);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  // Signed-in OAuth accounts (ChatGPT, Claude subscription) list above the
  // connections: they are what the OAuth choice in Add provider creates, and
  // without them a freshly signed-in account would read as "nothing added".
  const accounts = serverProviders.filter(isSignedInProviderAccount);
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshingRef = useRef(false);
  // Same master-detail chrome as the harness editor: the connection list on
  // the left, the selected connection on the right. Falls back to the first
  // entry when the selection is gone (e.g. after a deletion).
  const selectedEntry = entries.find(([id]) => id === selectedId) ?? entries[0] ?? null;
  // Provider probe cadence: a provider (not harness) setting, so it lives on
  // this tab with the connections it refreshes.
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const providerHealthPreset = getBackgroundActivityPresetSettings(
    resolvedBackgroundActivity.profile,
  ).providerHealthRefreshInterval;
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const defaultProviderHealthRefreshIntervalSeconds = durationToSeconds(providerHealthPreset);

  const removeConnection = (id: string) => {
    updateSettings({ modelBackendConnections: removeBackendConnection(connections, id) });
  };

  const refreshProviders = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      try {
        await refreshServerProviders({
          environmentId,
          input: { refreshModels: true },
        });
      } finally {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      }
    })();
  };

  return (
    <>
      <SettingsSection {...searchableSetting("provider-backends")} hideTitle variant="plain">
        <div className="flex min-h-11 min-w-0 items-center gap-2 px-3 sm:px-4">
          <span className="inline-flex h-6 shrink-0 items-center text-sm font-normal tracking-[-0.005em] text-foreground/70">
            Provider
          </span>
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    disabled={isRefreshingProviders}
                    aria-busy={isRefreshingProviders}
                    onClick={refreshProviders}
                  >
                    <RefreshIcon refreshing={isRefreshingProviders} />
                    <span className="sr-only">Refresh provider status</span>
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh provider status</TooltipPopup>
            </Tooltip>
            {readOnly ? null : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      onClick={() => setAdding(true)}
                      aria-label="Add provider"
                    >
                      <PlusIcon />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Add provider</TooltipPopup>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="space-y-4">
          {readOnly ? (
            <div className={cn(providerCardClassName, "overflow-hidden")}>
              <SettingsRow
                title="Limited permissions"
                description={`This session can view ${environmentLabel}'s providers but can't change them.`}
              />
            </div>
          ) : null}
          {accounts.length > 0 ? (
            <div className={cn(providerCardClassName, "divide-y divide-border/50 overflow-hidden")}>
              {accounts.map((provider) => (
                <ProviderAuthSection
                  key={provider.instanceId}
                  environmentId={environmentId}
                  environmentLabel={environmentLabel}
                  instanceId={provider.instanceId}
                  driver={provider.driver}
                  displayName={resolveProviderInstanceDisplayName(provider)}
                  provider={provider}
                  readOnly={readOnly}
                  onRefreshStatus={() => {
                    void refreshServerProviders({
                      environmentId,
                      input: { refreshModels: true },
                    });
                  }}
                />
              ))}
            </div>
          ) : null}
          <div
            className={cn(
              providerCardClassName,
              providerCardHeightClassName,
              "overflow-hidden lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]",
            )}
          >
            <div className="border-b border-border/60 bg-muted/10 lg:flex lg:min-h-0 lg:flex-col lg:border-r lg:border-b-0">
              <ScrollArea scrollFade chainVerticalScroll className="lg:min-h-0 lg:flex-1">
                <div className="divide-y divide-border/50">
                  {entries.map(([connectionId, connection]) => {
                    const title = connection.displayName?.trim() || connectionId;
                    const selected = selectedEntry?.[0] === connectionId;
                    const credentialId =
                      connection.apiKeyCredentialId !== undefined
                        ? String(connection.apiKeyCredentialId)
                        : undefined;
                    const driverKind = inferBackendConnectionDriverKind({
                      connectionId,
                      connection,
                      credentialVendor:
                        credentialId !== undefined ? credentials[credentialId]?.vendor : undefined,
                    });
                    return (
                      <button
                        key={connectionId}
                        type="button"
                        onClick={() => setSelectedId(connectionId)}
                        aria-label={`Select ${title}`}
                        aria-pressed={selected}
                        className={cn(
                          "flex min-h-18 w-full items-center gap-3 px-3 py-3 text-left transition-colors sm:px-4",
                          selected ? "bg-muted/45" : "hover:bg-muted/25",
                        )}
                      >
                        <ProviderInstanceTitleIcon
                          displayName={title}
                          driverKind={driverKind}
                          accentColor={undefined}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {title}
                          </span>
                          <span className="block truncate text-[13px] leading-[1.45] text-muted-foreground/80">
                            {connection.baseUrl}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
            <div className="min-w-0 lg:min-h-0">
              {selectedEntry !== null ? (
                <ScrollArea scrollFade chainVerticalScroll className="lg:h-full">
                  <BackendConnectionRow
                    key={selectedEntry[0]}
                    environmentId={environmentId}
                    environmentLabel={environmentLabel}
                    connectionId={selectedEntry[0]}
                    connection={selectedEntry[1]}
                    credential={
                      selectedEntry[1].apiKeyCredentialId !== undefined
                        ? (credentials[String(selectedEntry[1].apiKeyCredentialId)] ?? undefined)
                        : undefined
                    }
                    referenceCount={countConnectionReferences(
                      settings.providerInstances,
                      selectedEntry[0],
                    )}
                    readOnly={readOnly}
                    onEdit={() => setEditingId(selectedEntry[0])}
                    onRemove={() => removeConnection(selectedEntry[0])}
                  />
                </ScrollArea>
              ) : (
                <SettingsRow
                  title={
                    accounts.length > 0 ? "No API connections added." : "No API providers added."
                  }
                  description={
                    accounts.length > 0
                      ? "The signed-in accounts above run on their own login. Add a connection to serve models from an external endpoint."
                      : readOnly
                        ? `No provider connections on ${environmentLabel}.`
                        : "Add a provider connection to route harness instances through an external endpoint."
                  }
                />
              )}
            </div>
          </div>
        </div>
      </SettingsSection>

      <UsageProviderSettings
        key={environmentId}
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        sources={settings.usageLimitSources}
        readOnly={readOnly}
      />

      <SettingsSection title="Advanced">
        <SettingsRow
          id={searchableSetting("provider-health-check-interval").id}
          title={
            <span className="inline-flex items-center gap-1.5">
              {searchableSetting("provider-health-check-interval").title}
              <PolicyTooltip>
                This interval is configured here, then the shared Background activity policy decides
                whether provider probes may run when the timer fires. Custom intervals appear as
                Advanced in General settings.
              </PolicyTooltip>
            </span>
          }
          description="Refresh provider status, versions, and models in the background. Set to 0 to disable."
          resetAction={
            providerHealthRefreshIntervalSeconds !== defaultProviderHealthRefreshIntervalSeconds ? (
              <span inert={readOnly} className={readOnly ? "opacity-50" : undefined}>
                <SettingResetButton
                  label="provider health check interval"
                  onClick={() =>
                    updateSettings(
                      backgroundActivityOverrideSettings(
                        settings.backgroundActivity,
                        resolvedBackgroundActivity,
                        { providerHealthRefreshInterval: undefined },
                      ),
                    )
                  }
                />
              </span>
            ) : null
          }
          control={
            <div
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={cn(
                "flex shrink-0 items-center gap-2",
                readOnly && "opacity-50 select-none",
              )}
            >
              <NumberField
                value={providerHealthRefreshIntervalSeconds}
                min={0}
                step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                size="sm"
                className="w-32"
                onValueChange={(value) =>
                  updateSettings(
                    backgroundActivityOverrideSettings(
                      settings.backgroundActivity,
                      resolvedBackgroundActivity,
                      {
                        providerHealthRefreshInterval: Duration.seconds(
                          normalizeIntervalSeconds(value),
                        ),
                      },
                    ),
                  )
                }
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="Decrease provider health check interval" />
                  <NumberFieldInput aria-label="Provider health check interval in seconds" />
                  <NumberFieldIncrement aria-label="Increase provider health check interval" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">seconds</span>
            </div>
          }
        />
      </SettingsSection>

      {adding && !readOnly ? (
        <AddBackendConnectionDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          connections={connections}
          credentials={credentials}
        />
      ) : null}
      {editingId !== null && connections[editingId] && !readOnly ? (
        <AddBackendConnectionDialog
          open
          onOpenChange={() => setEditingId(null)}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          connections={connections}
          credentials={credentials}
          editingId={editingId}
        />
      ) : null}
    </>
  );
}

/**
 * One added connection: brand icon where the endpoint is recognizable
 * (same glyph as the template picker — OpenCode, OpenAI/Codex, …),
 * initials fallback for genuinely custom endpoints, display name plus the
 * base URL, key reference, and protocol/model summary as plain status text,
 * Test/Edit/Remove right. The status is config, not live state: snapshots
 * carry no connection id, so no row matches a snapshot and no pill is
 * invented.
 */
function BackendConnectionRow({
  environmentId,
  environmentLabel,
  connectionId,
  connection,
  credential,
  referenceCount,
  readOnly,
  onEdit,
  onRemove,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connectionId: string;
  readonly connection: ModelProxyConfig;
  readonly credential: ModelCredential | undefined;
  readonly referenceCount: number;
  readonly readOnly: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const title = connection.displayName?.trim() || connectionId;
  const probe = useBackendConnectionProbe(environmentId);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // A dangling credential reference (deleted key) degrades to keyless, same
  // orphan rule as a deleted connection.
  const missingCredential = connection.apiKeyCredentialId !== undefined && credential === undefined;
  const keyHint = missingCredential
    ? "stored key missing"
    : (credential?.displayName?.trim() ?? connection.apiKeyEnv?.trim());
  const protocolSummary =
    connection.protocols.includes("openai") && connection.protocols.includes("anthropic")
      ? ""
      : ` · ${connection.protocols.includes("anthropic") ? "Anthropic" : "OpenAI"} only`;
  const modelSummary =
    connection.models !== undefined && connection.models.length > 0
      ? ` · ${connection.models.length} ${connection.models.length === 1 ? "model" : "models"}`
      : "";
  return (
    <div className="flex min-h-18 items-center gap-3 px-3 py-3 sm:px-4">
      <ProviderInstanceTitleIcon
        displayName={title}
        driverKind={inferBackendConnectionDriverKind({
          connectionId,
          connection,
          credentialVendor: credential?.vendor,
        })}
        accentColor={undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {title !== connectionId ? (
            <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
              {connectionId}
            </code>
          ) : null}
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-[13px] leading-[1.45]",
            missingCredential ? "text-warning" : "text-muted-foreground/80",
          )}
        >
          {connection.baseUrl}
          {keyHint ? ` · ${keyHint}` : ""}
          {protocolSummary}
          {modelSummary}
        </span>
        {probe.description ? (
          <span
            role={probe.description.tone === "fail" ? "alert" : undefined}
            className={cn(
              "mt-0.5 flex items-center gap-1.5 text-[13px] leading-[1.45]",
              probe.description.tone === "fail" && "text-destructive",
              probe.description.tone === "ok" && "text-success",
            )}
          >
            {probe.description.tone === "pending" ? <Spinner className="size-3" /> : null}
            <span className="truncate">{probe.description.text}</span>
          </span>
        ) : null}
      </span>
      {readOnly ? null : (
        <span className="flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={probe.pending}
            onClick={() =>
              void probe.run(
                toTestBackend(connection),
                connection.apiKeyCredentialId !== undefined
                  ? String(connection.apiKeyCredentialId)
                  : undefined,
              )
            }
          >
            {probe.pending ? <Spinner className="size-3.5" /> : null}
            Test
          </Button>
          <Button size="xs" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirmingRemove(true)}>
            Remove
          </Button>
        </span>
      )}
      <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {title}?</AlertDialogTitle>
            <AlertDialogDescription>
              The connection is deleted from {environmentLabel}.{" "}
              {referenceCount === 0
                ? "No harness instance uses it."
                : referenceCount === 1
                  ? "1 harness instance uses this connection and will route directly until you pick another."
                  : `${referenceCount} harness instances use this connection and will route directly until you pick another.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingRemove(false);
                onRemove();
              }}
            >
              Remove provider
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
