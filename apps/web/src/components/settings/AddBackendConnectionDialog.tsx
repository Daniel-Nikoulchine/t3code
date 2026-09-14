import { Radio as RadioPrimitive } from "@base-ui/react/radio";
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
  ModelProxyProtocol,
} from "@t3tools/contracts";
import { CheckIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { DeepSeekIcon, GrokIcon, OpenAI, type Icon } from "../Icons";
import {
  addBackendConnection,
  allocateBackendConnectionId,
  applyProviderPreset,
  slugifyBackendConnectionId,
  toModelProxyConfig,
  toTestBackend,
  validateBackendConnectionId,
} from "./providerBackend.logic";
import { credentialVendorLabel } from "./providerCredentials.logic";
import { useBackendConnectionProbe } from "./useBackendConnectionProbe";

const NO_CREDENTIAL = "";
const BOTH_PROTOCOLS: ReadonlyArray<ModelProxyProtocol> = ["openai", "anthropic"];

/**
 * Add (or edit) one named model-backend connection on an environment. Adding
 * starts at a provider template pick (one-way prefill, no auto-save); both
 * modes edit the connection id (add only — proposals slugified from the
 * template label, editable, collisions suffixed on save), base URL, wire
 * protocols, stored-key reference, key-variable name, display name, and the
 * model list (fetched from the endpoint via the probe RPC or typed by hand),
 * with an unpersisted probe before saving. The save sends the whole
 * connections map.
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
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [preset, setPreset] = useState<ModelProviderPreset | null>(null);
  // Pick stage (template grid) vs. form stage. Selection prefills the draft
  // via `pickPreset` exactly as before; `Next` only advances the stage.
  // Editing skips the pick stage entirely.
  const [stage, setStage] = useState<"pick" | "form">(editing ? "form" : "pick");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? "");
  const [apiKeyEnv, setApiKeyEnv] = useState(editing?.apiKeyEnv ?? "");
  const [displayName, setDisplayName] = useState(editing?.displayName ?? "");
  const [protocols, setProtocols] = useState<ReadonlyArray<ModelProxyProtocol>>(
    editing?.protocols ?? BOTH_PROTOCOLS,
  );
  const [credentialId, setCredentialId] = useState<string>(
    editing?.apiKeyCredentialId ?? NO_CREDENTIAL,
  );
  const [models, setModels] = useState<ReadonlyArray<string>>(editing?.models ?? []);
  const [fetchHint, setFetchHint] = useState<string | null>(null);
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);
  const probe = useBackendConnectionProbe(environmentId);

  const pickPreset = (next: ModelProviderPreset) => {
    const draft = applyProviderPreset(next);
    setPreset(next);
    setConnectionId(null);
    setBaseUrl(draft.baseUrl);
    setApiKeyEnv(draft.apiKeyEnv);
    setDisplayName(draft.displayName);
    setProtocols(BOTH_PROTOCOLS);
    setCredentialId(NO_CREDENTIAL);
    setModels([]);
    setFetchHint(null);
    setHasAttemptedSave(false);
  };

  const proposedId =
    connectionId ?? (preset ? slugifyBackendConnectionId(preset.label) : "connection");
  const idError = editing ? null : validateBackendConnectionId(proposedId);
  const candidate = toModelProxyConfig({
    baseUrl,
    apiKeyEnv,
    displayName,
    protocols,
    apiKeyCredentialId: credentialId,
    models,
  });
  const protocolError =
    protocols.includes("openai") || protocols.includes("anthropic")
      ? null
      : "Pick at least one protocol.";
  const canSave = idError === null && candidate !== undefined && protocolError === null;
  const credentialsAvailable =
    credentialId !== NO_CREDENTIAL && credentials[credentialId] !== undefined;

  const save = () => {
    setHasAttemptedSave(true);
    if (!canSave || candidate === undefined) return;
    if (editingId !== undefined) {
      updateSettings({
        modelBackendConnections: { ...connections, [editingId]: candidate },
      });
    } else {
      const id = allocateBackendConnectionId(proposedId, Object.keys(connections));
      updateSettings({ modelBackendConnections: addBackendConnection(connections, id, candidate) });
    }
    onOpenChange(false);
  };

  const fetchModels = async () => {
    const trimmedUrl = baseUrl.trim();
    if (trimmedUrl.length === 0 || probe.pending) return;
    const backend: ModelBackendConfig = {
      kind: "openai-compatible",
      baseUrl: trimmedUrl,
      ...(apiKeyEnv.trim().length > 0 ? { apiKeyEnv: apiKeyEnv.trim() } : {}),
    };
    const result = await probe.run(backend, credentialsAvailable ? credentialId : undefined);
    if (result === undefined) return;
    if (result.models !== undefined && result.models.length > 0) {
      setModels(result.models);
      setFetchHint(null);
    } else {
      setFetchHint("The endpoint returned no model list.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${editing?.displayName?.trim() || editingId}` : "Add provider"}
          </DialogTitle>
          <DialogDescription>
            {!editing && (preset === null || stage === "pick") ? (
              <>Pick a template to prefill the connection on {environmentLabel}.</>
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
          {!editing && (preset === null || stage === "pick") ? (
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
          ) : (
            <div className="grid gap-4">
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
                <Label>Protocols</Label>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={protocols.includes("openai")}
                      onCheckedChange={(checked) =>
                        setProtocols((current) =>
                          checked
                            ? [...new Set([...current, "openai" as const])]
                            : current.filter((protocol) => protocol !== "openai"),
                        )
                      }
                      aria-label="OpenAI-compatible protocol"
                    />
                    OpenAI-compatible
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      checked={protocols.includes("anthropic")}
                      onCheckedChange={(checked) =>
                        setProtocols((current) =>
                          checked
                            ? [...new Set([...current, "anthropic" as const])]
                            : current.filter((protocol) => protocol !== "anthropic"),
                        )
                      }
                      aria-label="Anthropic-compatible protocol"
                    />
                    Anthropic-compatible
                  </label>
                </div>
                {hasAttemptedSave && protocolError !== null ? (
                  <p role="alert" className="text-xs text-destructive">
                    {protocolError}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Which wire protocols the endpoint speaks; instances only get the variables of
                    the declared ones.
                  </p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="backend-connection-credential">Stored API key</Label>
                <Select
                  value={credentialId === NO_CREDENTIAL ? NO_CREDENTIAL : credentialId}
                  onValueChange={(next) => {
                    if (typeof next !== "string") return;
                    setCredentialId(next);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full"
                    aria-label="Stored API key for this connection"
                  >
                    <SelectValue>
                      {credentialId === NO_CREDENTIAL
                        ? "None"
                        : credentials[credentialId]?.displayName?.trim() || credentialId}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    <SelectItem value={NO_CREDENTIAL}>None</SelectItem>
                    {Object.entries(credentials).map(([id, credential]) => (
                      <SelectItem key={id} value={id}>
                        {`${credential.displayName.trim()} · ${credentialVendorLabel(credential.vendor)}`}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  A stored key from the API keys section wins over the API key variable below.
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
                      <div key={`${model}:${index}`} className="flex min-w-0 items-center gap-1.5">
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
                    onClick={() =>
                      void probe.run(
                        toTestBackend(candidate),
                        credentialsAvailable ? credentialId : undefined,
                      )
                    }
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
                      {probe.description.tone === "pending" ? <Spinner className="size-3" /> : null}
                      {probe.description.text}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Probes the field values without saving anything.
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          {!editing && (preset === null || stage === "pick") ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => setStage("form")} disabled={preset === null}>
                Next
              </Button>
            </>
          ) : !editing ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setPreset(null);
                  setStage("pick");
                }}
              >
                Templates
              </Button>
              <Button onClick={save} disabled={!canSave}>
                Add provider
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={!canSave}>
                Save changes
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Brand glyphs reused from `Icons.tsx` — no new SVGs. Only OpenAI and
 * DeepSeek ship exact provider icons there; xAI reuses the Grok mark (xAI's
 * consumer brand, same company). The rest share the Harness rows' initials
 * fallback (`providerInstanceInitials`) for a uniform look.
 */
const PROVIDER_PRESET_ICONS: Partial<Record<string, Icon>> = {
  openai: OpenAI,
  deepseek: DeepSeekIcon,
  xai: GrokIcon,
};

/**
 * Template card mirroring the harness driver grid in
 * `AddProviderInstanceDialog.tsx`: same `RadioPrimitive.Root` /
 * `RadioPrimitive.Indicator` / `CheckIcon` primitives and the same ring
 * tokens. Not shared as a component — the harness cards are inline and
 * hard-wired to `DriverOption` (driver kinds plus badges), while presets
 * carry string ids and an initials fallback with no badges.
 */
function PresetGridCard({ preset }: { readonly preset: ModelProviderPreset }) {
  const PresetIcon = PROVIDER_PRESET_ICONS[preset.id];
  return (
    <RadioPrimitive.Root
      value={preset.id}
      aria-label={`Use ${preset.label} template`}
      className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
    >
      {PresetIcon ? (
        <span className="inline-flex size-5 shrink-0 items-center justify-center">
          <PresetIcon className="size-4 text-foreground/80" aria-hidden />
        </span>
      ) : (
        <span
          className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] leading-none font-semibold text-foreground/80"
          aria-hidden
        >
          {providerInstanceInitials(preset.label)}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{preset.label}</span>
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
