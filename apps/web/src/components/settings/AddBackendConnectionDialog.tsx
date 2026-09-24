import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useAtomValue } from "@effect/atom-react";
import {
  PROVIDER_PRESET_LIST,
  type ModelProviderPreset,
} from "@t3tools/client-runtime/state/model-provider-presets";
import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ModelBackendConfig,
  ModelCredential,
  ModelProxyConfig,
} from "@t3tools/contracts";
import { CheckIcon, KeyRoundIcon, LogInIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironments } from "../../state/environments";
import { cn } from "../../lib/utils";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup } from "../ui/radio-group";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { ClaudeAI, DeepSeekIcon, GrokIcon, OpenAI, OpenCodeIcon, type Icon } from "../Icons";
import {
  addBackendConnection,
  allocateBackendConnectionId,
  applyProviderPreset,
  slugifyBackendConnectionId,
  toModelProxyConfig,
  toTestBackend,
  validateBackendConnectionId,
} from "./providerBackend.logic";
import { addCredential, allocateCredentialId } from "./providerCredentials.logic";
import {
  ModelCredentialId,
  ModelVendor,
  MODEL_CREDENTIAL_VALUE_REDACTED,
} from "@t3tools/contracts";
import { ProviderAuthSection } from "./ProviderAuthSection";
import {
  asksForAuthMethod,
  OPENAI_HARNESS_INSTANCE_ID,
  PROVIDER_OAUTH_TARGETS,
  type ProviderOAuthTarget,
} from "./AddBackendConnectionDialog.logic";
import { useBackendConnectionProbe } from "./useBackendConnectionProbe";

const NO_CREDENTIAL = "";

/**
 * Add (or edit) one named model-backend connection on an environment. Adding
 * starts at a provider pick: OAuth-only account cards first (they sign the
 * harness in without creating a connection), then endpoint templates
 * (one-way prefill, no auto-save); both modes edit the connection id (add
 * only — proposals slugified from the template label, editable, collisions
 * suffixed on save), base URL, API key,
 * key-variable name, display name, and the model list (fetched from the
 * endpoint via the probe RPC or typed by hand), with an unpersisted probe
 * before saving. The save sends the whole connections map.
 */
export function AddBackendConnectionDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  connections,
  credentials,
  editingId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connections: Readonly<Record<string, ModelProxyConfig>>;
  readonly credentials: Readonly<Record<string, ModelCredential>>;
  /** When set, the dialog edits that entry instead of adding one. */
  readonly editingId?: string | undefined;
}) {
  const editing = editingId !== undefined ? connections[editingId] : undefined;
  const { environments } = useEnvironments();
  const persistSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [pendingCopies, setPendingCopies] = useState<ReadonlyArray<{
    environmentId: EnvironmentId;
    label: string;
    connectionId: string;
    credentialId: string;
    connection: ModelProxyConfig;
    credential: ModelCredential;
  }> | null>(null);
  const copyToTargets = async (targets: NonNullable<typeof pendingCopies>) => {
    const results = await Promise.all(
      targets.map(async (target) => {
        const environment = environments.find(
          (entry) => entry.environmentId === target.environmentId,
        );
        const settings = environment?.serverConfig?.settings;
        if (!settings || environment.connection.phase !== "connected") return target;
        try {
          const outcome = await persistSettings({
            environmentId: target.environmentId,
            input: {
              patch: {
                modelCredentials: addCredential(
                  settings.modelCredentials,
                  target.credentialId,
                  target.credential,
                ),
                modelBackendConnections: addBackendConnection(
                  settings.modelBackendConnections,
                  target.connectionId,
                  target.connection,
                ),
              },
            },
          });
          return outcome._tag === "Success" ? null : target;
        } catch {
          return target;
        }
      }),
    );
    const failed = results.filter((target) => target !== null);
    setPendingCopies(failed.length > 0 ? failed : null);
    if (failed.length > 0) {
      setSaveError(
        `Provider saved on ${environmentLabel}. Could not copy to: ${failed.map((target) => target.label).join(", ")}. Retry to finish.`,
      );
    } else {
      onOpenChange(false);
    }
  };
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [preset, setPreset] = useState<ModelProviderPreset | null>(null);
  const [oauth, setOauth] = useState<ProviderOAuthTarget | null>(null);
  // Pick stage (template grid) → optional method stage (OAuth vs API key,
  // OpenAI only) → OAuth sign-in stage or the connection form. Selection
  // prefills the draft via `pickPreset` exactly as before; `Next` only
  // advances the stage. Editing skips the pick and method stages entirely.
  const [stage, setStage] = useState<"pick" | "method" | "oauth" | "form">(
    editing ? "form" : "pick",
  );
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [apiKeyEnv, setApiKeyEnv] = useState(editing?.apiKeyEnv ?? "");
  const [displayName, setDisplayName] = useState(editing?.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string>(
    editing?.apiKeyCredentialId ?? NO_CREDENTIAL,
  );
  const [models, setModels] = useState<ReadonlyArray<string>>(editing?.models ?? []);
  const [fetchHint, setFetchHint] = useState<string | null>(null);
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const probe = useBackendConnectionProbe(environmentId);

  const pickPreset = (next: ModelProviderPreset) => {
    const draft = applyProviderPreset(next);
    setOauth(null);
    setPreset(next);
    setConnectionId(null);
    setBaseUrl(draft.baseUrl);
    setApiKeyEnv(draft.apiKeyEnv);
    setDisplayName(draft.displayName);
    setSaveError(null);
    setCredentialId(NO_CREDENTIAL);
    setApiKey("");
    setModels([]);
    setFetchHint(null);
    setHasAttemptedSave(false);
  };

  const pickOauth = (next: ProviderOAuthTarget) => {
    setPreset(null);
    setOauth(next);
  };

  const proposedId =
    connectionId ?? (preset ? slugifyBackendConnectionId(preset.label) : "connection");
  const idError = editing ? null : validateBackendConnectionId(proposedId);
  const candidate = toModelProxyConfig({
    baseUrl,
    apiKeyEnv,
    displayName,
    apiKeyCredentialId: credentialId,
    models,
  });
  const canSave = idError === null && candidate !== undefined && !saving && !probe.pending;
  const credentialsAvailable =
    credentialId !== NO_CREDENTIAL && credentials[credentialId] !== undefined;
  // Draft keys travel only in the probe request; connection settings hold a reference.
  const runProbe = (backend: ModelBackendConfig) =>
    probe.run(
      apiKey.trim() ? { ...backend, apiKey: apiKey.trim() } : backend,
      !apiKey.trim() && credentialsAvailable ? credentialId : undefined,
    );

  const save = async () => {
    setHasAttemptedSave(true);
    if (!canSave || candidate === undefined) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (pendingCopies !== null) {
        await copyToTargets(pendingCopies);
        return;
      }
      const result = await runProbe(toTestBackend(candidate));
      if (!result || (!result.protocols?.length && !result.ok)) {
        setSaveError(
          "Could not detect the endpoint's API protocol. Check the URL and API key, then try again.",
        );
        return;
      }
      // Some gateways reject validation probes before parsing the payload.
      // Keep a reachable connection usable without claiming detection succeeded.
      // Allocate a new secret when replacing a key: other connections may share the old one.
      const savedCredentialId = apiKey.trim()
        ? allocateCredentialId(`${editingId ?? proposedId}-key`, Object.keys(credentials))
        : credentialId;
      const credential: ModelCredential | undefined = apiKey.trim()
        ? {
            displayName: `${displayName.trim() || editingId || proposedId} API key`,
            vendor: ModelVendor.make(preset?.id ?? "custom"),
            value: apiKey.trim(),
          }
        : undefined;
      const detected = {
        ...candidate,
        ...(credential ? { apiKeyCredentialId: ModelCredentialId.make(savedCredentialId) } : {}),
        protocols: result.protocols?.length
          ? result.protocols
          : editing?.baseUrl === candidate.baseUrl
            ? editing.protocols
            : candidate.protocols,
      };
      const id = editingId ?? allocateBackendConnectionId(proposedId, Object.keys(connections));
      const outcome = await persistSettings({
        environmentId,
        input: {
          patch: {
            modelBackendConnections: addBackendConnection(connections, id, detected),
            ...(credential
              ? { modelCredentials: addCredential(credentials, savedCredentialId, credential) }
              : {}),
          },
        },
      });
      if (outcome._tag !== "Success") {
        setSaveError("Could not save the provider. Try again.");
        return;
      }
      if (
        editingId === undefined &&
        credential?.value.trim() &&
        credential.value !== MODEL_CREDENTIAL_VALUE_REDACTED
      ) {
        const targets = environments
          .filter(
            (target) =>
              target.environmentId !== environmentId && target.connection.phase === "connected",
          )
          .map((target) => {
            const settings = target.serverConfig?.settings;
            const targetCredentialId = allocateCredentialId(
              savedCredentialId,
              Object.keys(settings?.modelCredentials ?? {}),
            );
            return {
              environmentId: target.environmentId,
              label: target.label,
              connectionId: allocateBackendConnectionId(
                id,
                Object.keys(settings?.modelBackendConnections ?? {}),
              ),
              credentialId: targetCredentialId,
              credential,
              connection: {
                ...detected,
                apiKeyCredentialId: ModelCredentialId.make(targetCredentialId),
              },
            };
          });
        await copyToTargets(targets);
      } else {
        onOpenChange(false);
      }
    } catch {
      setSaveError("Could not save the provider. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const fetchModels = async () => {
    const trimmedUrl = baseUrl.trim();
    if (trimmedUrl.length === 0 || probe.pending) return;
    const backend: ModelBackendConfig = {
      kind: "openai-compatible",
      baseUrl: trimmedUrl,
      ...(apiKeyEnv.trim().length > 0 ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
    };
    const result = await runProbe(backend);
    if (result === undefined) return;
    if (result.models !== undefined && result.models.length > 0) {
      setModels(result.models);
      setFetchHint(null);
    } else {
      setFetchHint("The endpoint returned no model list.");
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!saving) onOpenChange(next);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Edit ${editing?.displayName?.trim() || editingId}` : "Add provider"}
            </DialogTitle>
            <DialogDescription>
              {!editing && (preset === null || stage === "pick") && oauth === null ? (
                <>
                  Pick a provider on {environmentLabel}: sign in an account or prefill a connection.
                </>
              ) : !editing && stage === "method" ? (
                <>Connect OpenAI with your ChatGPT subscription sign-in or an API key.</>
              ) : !editing && stage === "oauth" ? (
                <>
                  Sign in{oauth !== null ? <> with your {oauth.account}</> : null}. This logs in the{" "}
                  {oauth !== null && oauth.driver === "claudeAgent" ? "Claude" : "Codex"} harness on{" "}
                  {environmentLabel}.
                </>
              ) : !editing && preset !== null ? (
                <>
                  Name the {preset.label} connection on {environmentLabel}.
                </>
              ) : (
                <>Update the connection on {environmentLabel}.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {!editing && (preset === null || stage === "pick") && oauth === null ? (
              <div className="grid gap-2">
                {PROVIDER_OAUTH_TARGETS.map((target) => (
                  <ProviderGridCard
                    key={target.dialogId}
                    value={target.dialogId}
                    onSelect={() => {
                      pickOauth(target);
                      setStage("oauth");
                    }}
                    ariaLabel={`Sign in with your ${target.account}`}
                    label={target.account}
                    icon={OAUTH_TARGET_ICONS[target.driver]}
                  />
                ))}
                <div
                  role="separator"
                  aria-label="API connections"
                  className="flex items-center gap-3 px-1 pt-1 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase"
                >
                  <span aria-hidden className="h-px flex-1 bg-border/70" />
                  API connections
                  <span aria-hidden className="h-px flex-1 bg-border/70" />
                </div>
                <RadioGroup
                  value={preset?.id ?? ""}
                  onValueChange={(value) => {
                    const next = PROVIDER_PRESET_LIST.find((entry) => entry.id === value);
                    if (next) pickPreset(next);
                  }}
                  aria-label="Provider template"
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                >
                  {PROVIDER_PRESET_LIST.map((entry) => (
                    <PresetGridCard key={entry.id} preset={entry} />
                  ))}
                </RadioGroup>
              </div>
            ) : !editing && stage === "method" ? (
              <RadioGroup
                value=""
                onValueChange={(value) => {
                  if (value === "api-key") {
                    setStage("form");
                    return;
                  }
                  if (value === "oauth") {
                    // The ChatGPT subscription is the Codex CLI's own login;
                    // run it right here instead of leaving for the harness tab.
                    setStage("oauth");
                  }
                }}
                aria-label="OpenAI connection method"
                className="grid grid-cols-1 gap-2"
              >
                <AuthMethodCard
                  value="api-key"
                  icon={KeyRoundIcon}
                  label="API key"
                  description={`Store an OpenAI API key and point a connection at ${preset?.baseUrl ?? "api.openai.com"}. Use this for API billing or gateways.`}
                />
                <AuthMethodCard
                  value="oauth"
                  icon={LogInIcon}
                  label="ChatGPT subscription (OAuth)"
                  description={`Sign in with your ChatGPT account, like the Codex CLI does. This signs in the Codex harness on ${environmentLabel}; no key is stored and no connection is created.`}
                />
              </RadioGroup>
            ) : !editing && stage === "oauth" ? (
              <ProviderAuthSection
                environmentId={environmentId}
                environmentLabel={environmentLabel}
                instanceId={oauth?.instanceId ?? OPENAI_HARNESS_INSTANCE_ID}
                driver={oauth?.driver ?? "codex"}
                displayName={oauth?.account ?? "OpenAI"}
                provider={serverProviders.find((provider) =>
                  oauth !== null
                    ? provider.instanceId === oauth.instanceId
                    : provider.instanceId === OPENAI_HARNESS_INSTANCE_ID,
                )}
                readOnly={false}
                // Mirror the harness card: nudge a status refresh the moment
                // sign-in succeeds so the card stops reading "not signed in".
                onRefreshStatus={() => {
                  void refreshServerProviders({
                    environmentId,
                    input: { refreshModels: true },
                  });
                }}
              />
            ) : (
              <fieldset disabled={saving} className="grid min-w-0 gap-4">
                {editing ? null : (
                  <div className="grid gap-1.5">
                    <Label htmlFor="backend-connection-id">Connection ID</Label>
                    <Input
                      id="backend-connection-id"
                      value={connectionId ?? slugifyBackendConnectionId(preset?.label ?? "")}
                      onChange={(event) => setConnectionId(event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      autoFocus
                    />
                    {hasAttemptedSave && idError !== null ? (
                      <p role="alert" className="text-xs text-destructive">
                        {idError}
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Stable key in settings; taken names get a numeric suffix on save.
                      </p>
                    )}
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="backend-connection-url">Base URL</Label>
                  <Input
                    id="backend-connection-url"
                    className="font-mono"
                    placeholder="https://proxy.example/v1"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus={editing !== undefined}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="backend-connection-credential">API key</Label>
                  <Input
                    id="backend-connection-credential"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      credentialsAvailable
                        ? "Stored key — enter a new key to replace"
                        : "Paste your API key"
                    }
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    spellCheck={false}
                  />
                  <p className="text-xs text-muted-foreground">
                    {credentialsAvailable
                      ? "Leave blank to keep the stored key."
                      : "Stored on the server when you save this provider."}
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="backend-connection-key">API key variable</Label>
                  <Input
                    id="backend-connection-key"
                    className="font-mono"
                    placeholder="PROVIDER_API_KEY"
                    value={apiKeyEnv}
                    onChange={(event) => setApiKeyEnv(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Variable name only — the value comes from the server environment.
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="backend-connection-name">Display name (optional)</Label>
                  <Input
                    id="backend-connection-name"
                    placeholder={preset?.label ?? editing?.displayName?.trim()}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    spellCheck={false}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="backend-connection-model-add">Models</Label>
                  {models.length > 0 ? (
                    <div className="grid gap-1">
                      {models.map((model, index) => (
                        <div
                          key={`${model}:${index}`}
                          className="flex min-w-0 items-center gap-1.5"
                        >
                          <code className="min-w-0 flex-1 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                            {model}
                          </code>
                          <Button
                            type="button"
                            size="icon-micro"
                            variant="ghost-muted"
                            className="[--control-icon-color:currentColor]"
                            onClick={() =>
                              setModels((current) => current.filter((_, i) => i !== index))
                            }
                            aria-label={`Remove model ${model}`}
                          >
                            <XIcon className="size-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <DraftInput
                      id="backend-connection-model-add"
                      size="sm"
                      className="min-w-0 flex-1 font-mono"
                      value=""
                      onCommit={(next) => {
                        const slug = next.trim();
                        if (slug.length === 0) return;
                        setModels((current) =>
                          current.includes(slug) ? current : [...current, slug],
                        );
                      }}
                      placeholder="Add model slug"
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={baseUrl.trim().length === 0 || probe.pending}
                      onClick={() => void fetchModels()}
                    >
                      {probe.pending ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <RefreshIcon refreshing={false} />
                      )}
                      Fetch models
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {fetchHint ??
                      "Fetch the endpoint's model list, or add slugs by hand. Saved with the connection."}
                  </p>
                </div>
                {candidate === undefined ? null : (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={probe.pending}
                      onClick={() => void runProbe(toTestBackend(candidate))}
                    >
                      {probe.pending ? <Spinner className="size-3.5" /> : null}
                      Test connection
                    </Button>
                    {probe.description ? (
                      <span
                        role={probe.description.tone === "fail" ? "alert" : undefined}
                        className={cn(
                          "inline-flex items-center gap-1.5 text-xs",
                          probe.description.tone === "fail" && "text-destructive",
                          probe.description.tone === "ok" && "text-success",
                        )}
                      >
                        {probe.description.tone === "pending" ? (
                          <Spinner className="size-3" />
                        ) : null}
                        {probe.description.text}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Probes the field values without saving anything.
                      </span>
                    )}
                  </div>
                )}
                {saveError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {saveError}
                  </p>
                ) : null}
              </fieldset>
            )}
          </DialogPanel>
          <DialogFooter variant="bare">
            {!editing && stage === "oauth" ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (oauth === null) {
                      setStage("method");
                      return;
                    }
                    // Harness rows jump straight into sign-in from the grid;
                    // Back drops the target so the pick grid renders again.
                    setOauth(null);
                    setStage("pick");
                  }}
                >
                  Back
                </Button>
                <Button onClick={() => onOpenChange(false)}>Done</Button>
              </>
            ) : !editing && stage === "method" ? (
              <Button variant="outline" onClick={() => setStage("pick")}>
                Back
              </Button>
            ) : !editing && ((preset === null && oauth === null) || stage === "pick") ? (
              <>
                <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    setStage(
                      asksForAuthMethod({ presetId: preset?.id, editing: false })
                        ? "method"
                        : "form",
                    );
                  }}
                  disabled={preset === null}
                >
                  Next
                </Button>
              </>
            ) : !editing ? (
              <>
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setPreset(null);
                    setStage("pick");
                  }}
                >
                  Templates
                </Button>
                <Button onClick={save} disabled={!canSave}>
                  {saving
                    ? "Saving…"
                    : pendingCopies !== null
                      ? "Retry failed machines"
                      : "Add provider"}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={save} disabled={!canSave}>
                  {saving ? "Detecting protocols…" : "Save changes"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/**
 * Brand glyphs reused from `Icons.tsx` — no new SVGs. OAuth accounts reuse
 * the harness brand marks (ChatGPT uses the OpenAI glyph, Claude its own);
 * endpoint presets do the same where one exists (OpenAI, xAI via the Grok
 * mark, DeepSeek, OpenCode Zen/Go via the OpenCode mark) and Custom shares
 * the Harness rows' initials fallback (`providerInstanceInitials`) for a
 * uniform look.
 */
const PROVIDER_PRESET_ICONS: Partial<Record<string, Icon>> = {
  openai: OpenAI,
  xai: GrokIcon,
  deepseek: DeepSeekIcon,
  "opencode-zen": OpenCodeIcon,
  "opencode-go": OpenCodeIcon,
};

const OAUTH_TARGET_ICONS: Partial<Record<string, Icon>> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
};

/**
 * One provider row: an OAuth account or an endpoint template card. Same
 * chrome for both steps — `RadioPrimitive.Root` / `RadioPrimitive.Indicator`
 * / `CheckIcon` primitives and the same ring tokens — since the two rows on
 * the pick step read as one list, not two controls. The template-card
 * comment used to mirror the harness driver grid in
 * `AddProviderInstanceDialog.tsx`; OAuth and template rows are inline here
 * because the endpoint presets carry string ids and an initials fallback
 * with no badges, while the driver grid is hard-wired to `DriverOption`
 * (driver kinds plus badges).
 */
/**
 * Template card mirroring the harness driver grid in
 * `AddProviderInstanceDialog.tsx`: same selectable-row chrome as the OAuth
 * rows above. Not shared as a component — the harness cards are inline and
 * hard-wired to `DriverOption` (driver kinds plus badges), while presets
 * carry string ids and an initials fallback with no badges.
 */
function PresetGridCard({ preset }: { readonly preset: ModelProviderPreset }) {
  return (
    <ProviderGridCard
      value={preset.id}
      onSelect={undefined}
      ariaLabel={`Use ${preset.label} template`}
      label={preset.label}
      icon={PROVIDER_PRESET_ICONS[preset.id]}
    />
  );
}

/**
 * One selectable provider row. OAuth rows (`onSelect` set) are immediate
 * buttons that open the sign-in sheet for an in-app harness login, so they
 * stay outside the template radio group. Template rows (`onSelect`
 * undefined) are radio items: the group drives the selection and `Next`
 * moves into the connection form. Both share the same chrome so the pick
 * step reads as one list even though the rows behave differently.
 */
function ProviderGridCard({
  value,
  onSelect,
  ariaLabel,
  label,
  icon: CardIcon,
}: {
  readonly value: string;
  readonly onSelect: (() => void) | undefined;
  readonly ariaLabel: string;
  readonly label: string;
  readonly icon: Icon | undefined;
}) {
  const chrome =
    "relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15";
  const glyph = CardIcon ? (
    <span className="inline-flex size-5 shrink-0 items-center justify-center">
      <CardIcon className="size-4 text-foreground/80" aria-hidden />
    </span>
  ) : (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] leading-none font-semibold text-foreground/80"
      aria-hidden
    >
      {providerInstanceInitials(label)}
    </span>
  );
  const rows = (
    <>
      {glyph}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{label}</span>
      </span>
      {onSelect !== undefined ? null : (
        <RadioPrimitive.Indicator
          className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
          aria-hidden
        >
          <CheckIcon className="size-3.5 shrink-0" />
        </RadioPrimitive.Indicator>
      )}
    </>
  );
  if (onSelect !== undefined) {
    return (
      <button type="button" onClick={onSelect} aria-label={ariaLabel} className={chrome}>
        {rows}
      </button>
    );
  }
  return (
    <RadioPrimitive.Root value={value} aria-label={ariaLabel} className={chrome}>
      {rows}
    </RadioPrimitive.Root>
  );
}

/**
 * One way to connect the selected provider account: an API key connection or
 * the CLI's own OAuth sign-in. Same card chrome as `PresetGridCard`, but with
 * a description line since the two choices differ in outcome, not just name.
 */
function AuthMethodCard({
  value,
  icon: MethodIcon,
  label,
  description,
}: {
  readonly value: string;
  readonly icon: Icon;
  readonly label: string;
  readonly description: string;
}) {
  return (
    <RadioPrimitive.Root
      value={value}
      aria-label={label}
      className="relative flex cursor-pointer items-start gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
    >
      <span className="inline-flex size-5 shrink-0 items-center justify-center">
        <MethodIcon className="size-4 text-foreground/80" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
          {description}
        </span>
      </span>
      <RadioPrimitive.Indicator
        className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
        aria-hidden
      >
        <CheckIcon className="size-3.5 shrink-0" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}
