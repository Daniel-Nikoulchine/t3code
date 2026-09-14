import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ModelCredential,
  ModelProxyConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
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
import { Spinner } from "../ui/spinner";
import { AddBackendConnectionDialog } from "./AddBackendConnectionDialog";
import { ModelCatalogSection } from "./ModelCatalogSection";
import { ModelRouterSection } from "./ModelRouterSection";
import {
  countConnectionReferences,
  removeBackendConnection,
  toTestBackend,
} from "./providerBackend.logic";
import { ProviderCredentialsSection } from "./ProviderCredentialsSection";
import { useBackendConnectionProbe } from "./useBackendConnectionProbe";
import {
  providerCardClassName,
  SelectedEnvironmentProviderSettings,
} from "./providerSettingsEnvironment";
import { EnvironmentProviderSettings } from "./ProviderSettingsPanel";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface ProviderBackendsTarget {
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
  readonly scoped?: boolean;
}

/**
 * The Providers tab: model backend connections, stored API keys, the models
 * matrix, and beneath them the per-instance harness editor (instances,
 * usage sources, advanced rows) — all scoped to one environment.
 */
export function ProviderBackendsPanel(target: ProviderBackendsTarget) {
  return (
    <SettingsPageContainer width="wide" className="gap-8">
      <ProviderBackendsPanelContent key={target.environmentId ?? ""} {...target} />
    </SettingsPageContainer>
  );
}

function ProviderBackendsPanelContent(target: ProviderBackendsTarget) {
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
      <p className="p-8 text-sm text-muted-foreground">
        {isReady
          ? "Connect an environment to set up its model provider."
          : "Reading connected execution environments."}
      </p>
    );
  }
  return (
    <SelectedEnvironmentProviderSettings
      key={selectedEnvironment.environmentId}
      environment={selectedEnvironment}
      searchAnchorId="provider-backends"
      targetInstanceId={
        target.environmentId === undefined ||
        selectedEnvironment.environmentId === target.environmentId
          ? target.instanceId
          : undefined
      }
      render={(gated) => (
        <>
          <EnvironmentProviderBackends
            environmentId={gated.environmentId}
            environmentLabel={gated.environmentLabel}
            readOnly={gated.readOnly}
          />
          <EnvironmentProviderSettings
            environmentId={gated.environmentId}
            environmentLabel={gated.environmentLabel}
            readOnly={gated.readOnly}
            {...(gated.targetInstanceId !== undefined
              ? { targetInstanceId: gated.targetInstanceId }
              : {})}
          />
        </>
      )}
    />
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
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const removeConnection = (id: string) => {
    updateSettings({ modelBackendConnections: removeBackendConnection(connections, id) });
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("provider-backends")}
        headerAction={
          readOnly ? null : (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add provider
            </Button>
          )
        }
      >
        {readOnly ? (
          <div className={cn(providerCardClassName, "overflow-hidden")}>
            <SettingsRow
              title="Limited permissions"
              description={`This session can view ${environmentLabel}'s providers but can't change them.`}
            />
          </div>
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow
            title="No providers added."
            description={
              readOnly
                ? `No provider connections on ${environmentLabel}.`
                : "Add a provider connection to route harness instances through an external endpoint."
            }
          />
        ) : (
          <div className={cn(providerCardClassName, "divide-y divide-border/50 overflow-hidden")}>
            {entries.map(([connectionId, connection]) => (
              <BackendConnectionRow
                key={connectionId}
                environmentId={environmentId}
                environmentLabel={environmentLabel}
                connectionId={connectionId}
                connection={connection}
                credential={
                  connection.apiKeyCredentialId !== undefined
                    ? (credentials[String(connection.apiKeyCredentialId)] ?? undefined)
                    : undefined
                }
                referenceCount={countConnectionReferences(settings.providerInstances, connectionId)}
                readOnly={readOnly}
                onEdit={() => setEditingId(connectionId)}
                onRemove={() => removeConnection(connectionId)}
              />
            ))}
          </div>
        )}
      </SettingsSection>
      <ProviderCredentialsSection
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        connections={connections}
        readOnly={readOnly}
      />
      <ModelCatalogSection environmentId={environmentId} />
      {/* Routing sits after the models matrix: its routes reference
          connections, keys, and the model IDs the matrix discovers. */}
      <ModelRouterSection
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        readOnly={readOnly}
      />
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
 * One added connection: initials left (same fallback as the instance rows —
 * connections are user entries, so no brand icons), display name plus the
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
      <span
        className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] leading-none font-semibold text-foreground/80"
        aria-hidden
      >
        {providerInstanceInitials(title)}
      </span>
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
