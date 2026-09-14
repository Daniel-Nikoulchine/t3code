import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { cn } from "../../lib/utils";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { ExpandableText } from "./ExpandableText";
import {
  classifyProviderEnvironmentAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
} from "./ProviderSettingsPanel.logic";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";

export const providerCardClassName = "rounded-xl border border-border/60 bg-card/40 shadow-xs/5";
// Shared by the editor grid and the placeholder states so switching devices
// never changes the card's footprint.
export const providerCardHeightClassName = "lg:h-[min(44rem,calc(100dvh-11rem))] lg:min-h-[32rem]";

/**
 * Same chrome as the provider editor (section heading, floating device tabs,
 * tall card) for states that cannot render provider settings yet.
 */
export function ProviderSettingsPlaceholder({
  searchAnchorId,
  deviceTabs,
  icon,
  title,
  description,
  children,
}: {
  readonly searchAnchorId: SettingsSearchItemId;
  readonly deviceTabs?: ReactNode;
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <SettingsSection {...searchableSetting(searchAnchorId)} hideTitle variant="plain">
      {deviceTabs ? (
        <div className="flex min-h-11 min-w-0 items-center px-3 sm:px-4">{deviceTabs}</div>
      ) : null}
      <div
        className={cn(
          providerCardClassName,
          providerCardHeightClassName,
          "flex overflow-x-hidden overflow-y-auto",
        )}
      >
        <Empty className="min-h-88">
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          {children ? <EmptyContent className="max-w-xl">{children}</EmptyContent> : null}
        </Empty>
      </div>
    </SettingsSection>
  );
}

function EnvironmentUnavailablePlaceholder({
  searchAnchorId,
  environment,
  access,
  deviceTabs,
}: {
  readonly searchAnchorId: SettingsSearchItemId;
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
  readonly deviceTabs?: ReactNode;
}) {
  const isLoading = access.kind === "loading";
  const title = isLoading
    ? "Loading harness settings"
    : access.kind === "error"
      ? "Could not connect to this device"
      : "Harness settings are unavailable";
  // Keep the description to a short status; the raw failure can be a
  // multi-paragraph CLI dump, so it goes below, clamped and expandable.
  const description = isLoading
    ? access.reason === "permissions"
      ? "Checking what this session is allowed to change."
      : `Waiting for ${environment.label}'s configuration.`
    : connectionStatusTitle(environment.connection);
  const error = isLoading ? null : environment.connection.error;
  // No spinner: this state can persist indefinitely for a wedged device, and a
  // continuously repainting animation would run the whole time.
  return (
    <ProviderSettingsPlaceholder
      searchAnchorId={searchAnchorId}
      deviceTabs={deviceTabs}
      icon={
        <EnvironmentMachineIcon kind={resolveEnvironmentMachineKind(environment.serverConfig)} />
      }
      title={title}
      description={description}
    >
      {error ? (
        <ExpandableText
          key={environment.environmentId}
          text={error}
          className="w-full text-left font-mono text-xs leading-relaxed text-muted-foreground"
        />
      ) : null}
    </ProviderSettingsPlaceholder>
  );
}

export interface ProviderSettingsEnvironmentRenderProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /**
   * Grey out and freeze every write control when this session's credential
   * lacks `orchestration:operate` on the environment. Selecting providers
   * still works so the real configuration stays readable; switches, forms,
   * and the health interval are inert so no write is offered and then rejected.
   */
  readonly readOnly: boolean;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
}

interface ProviderSettingsEnvironmentGateProps {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
  /**
   * Which search anchor the placeholder sections register. The Harness tab
   * passes `"providers"`, the Providers tab `"provider-backends"` — the
   * placeholder must scroll-target the tab it renders on.
   */
  readonly searchAnchorId: SettingsSearchItemId;
  readonly render: (props: ProviderSettingsEnvironmentRenderProps) => ReactNode;
}

/**
 * Session + connection gate shared by the Harness tab and the backend-centric
 * Providers tab: resolves operate access for the selected environment and
 * either renders the per-environment settings via `render` or a placeholder.
 */
export function SelectedEnvironmentProviderSettings({
  environment,
  deviceTabs,
  targetInstanceId,
  searchAnchorId,
  render,
}: ProviderSettingsEnvironmentGateProps) {
  const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
  if (isPrimary) {
    // The desktop app owns its primary server outright; a browser session
    // checks the scopes its cookie session was granted.
    if (isElectron) {
      return (
        <AccessGatedProviderSettings
          environment={environment}
          operateAccess="granted"
          deviceTabs={deviceTabs}
          targetInstanceId={targetInstanceId}
          searchAnchorId={searchAnchorId}
          render={render}
        />
      );
    }
    return (
      <PrimarySessionGatedProviderSettings
        environment={environment}
        deviceTabs={deviceTabs}
        targetInstanceId={targetInstanceId}
        searchAnchorId={searchAnchorId}
        render={render}
      />
    );
  }
  return (
    <RemoteSessionGatedProviderSettings
      environment={environment}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
      searchAnchorId={searchAnchorId}
      render={render}
    />
  );
}

function PrimarySessionGatedProviderSettings({
  environment,
  deviceTabs,
  targetInstanceId,
  searchAnchorId,
  render,
}: ProviderSettingsEnvironmentGateProps) {
  const primarySessionState = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: primarySessionState.data,
    isPending: primarySessionState.isPending,
    hasError: primarySessionState.error !== null,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
      searchAnchorId={searchAnchorId}
      render={render}
    />
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  deviceTabs,
  targetInstanceId,
  searchAnchorId,
  render,
}: ProviderSettingsEnvironmentGateProps) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      deviceTabs={deviceTabs}
      targetInstanceId={targetInstanceId}
      searchAnchorId={searchAnchorId}
      render={render}
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  deviceTabs,
  targetInstanceId,
  searchAnchorId,
  render,
}: ProviderSettingsEnvironmentGateProps & {
  readonly operateAccess: ProviderOperateAccess;
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <EnvironmentUnavailablePlaceholder
        searchAnchorId={searchAnchorId}
        environment={environment}
        access={access}
        deviceTabs={deviceTabs}
      />
    );
  }
  return (
    <>
      {render({
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        readOnly: access.kind === "read-only",
        ...(deviceTabs !== undefined ? { deviceTabs } : {}),
        ...(targetInstanceId !== undefined ? { targetInstanceId } : {}),
      })}
    </>
  );
}
