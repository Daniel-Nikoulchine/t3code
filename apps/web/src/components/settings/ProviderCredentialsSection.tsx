import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ModelBackendConfig,
  ModelCredential,
  ModelProxyConfig,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
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
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import {
  CREDENTIAL_VENDOR_PRESETS,
  addCredential,
  allocateCredentialId,
  countCredentialReferences,
  credentialProbeUrl,
  credentialSecretState,
  credentialVendorLabel,
  isPresetVendor,
  nextCredentialWithSecret,
  referencingConnection,
  removeCredential,
  slugifyCredentialId,
  validateCredentialId,
  validateVendorSlug,
} from "./providerCredentials.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";
import { useBackendConnectionProbe } from "./useBackendConnectionProbe";

const CUSTOM_VENDOR = "custom";
const PICK_VENDOR = "pick";

/**
 * Stored API keys ("API keys" section of the Providers tab). One credential
 * is a vendor slug plus a display name and a secret that lives in the
 * server's secret store — clients only ever see the redacted sentinel, and
 * sending it back means "keep". Connections reference credentials via
 * `apiKeyCredentialId` (the stored key wins over the connection's
 * `apiKeyEnv`). Writes are whole-map patches; the Test button probes the
 * stored key through the vendor's public API root (preset vendors) or
 * through the first referencing connection (custom vendors).
 */
export function ProviderCredentialsSection({
  environmentId,
  environmentLabel,
  connections,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connections: Readonly<Record<string, ModelProxyConfig>>;
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  // Widened so id lookups with plain strings stay type-clean; the branded
  // record is assignably identical.
  const credentials: Record<string, ModelCredential> = settings.modelCredentials;
  const entries = Object.entries(credentials);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <>
      <SettingsSection
        {...searchableSetting("provider-credentials")}
        headerAction={
          readOnly ? null : (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              Add key
            </Button>
          )
        }
      >
        {entries.length === 0 ? (
          <div className="px-3 py-3 sm:px-4">
            <p className="text-sm font-medium text-foreground">No API keys stored.</p>
            <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">
              {readOnly
                ? `No stored API keys on ${environmentLabel}.`
                : "Store a vendor API key once and reference it from any provider connection."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/50 overflow-hidden">
            {entries.map(([credentialId, credential]) => (
              <CredentialRow
                key={credentialId}
                environmentId={environmentId}
                environmentLabel={environmentLabel}
                credentialId={credentialId}
                credential={credential}
                connections={connections}
                readOnly={readOnly}
                onEdit={() => setEditingId(credentialId)}
                onRemove={() =>
                  updateSettings({
                    modelCredentials: removeCredential(credentials, credentialId),
                  })
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <CredentialDialog
          open
          onOpenChange={setAdding}
          environmentLabel={environmentLabel}
          credentials={credentials}
          onSave={(id, credential) => {
            updateSettings({ modelCredentials: addCredential(credentials, id, credential) });
          }}
        />
      ) : null}
      {editingId !== null && credentials[editingId] ? (
        <CredentialDialog
          open
          onOpenChange={() => setEditingId(null)}
          environmentLabel={environmentLabel}
          credentials={credentials}
          editingId={editingId}
          initial={credentials[editingId]!}
          onSave={(id, credential) => {
            updateSettings({ modelCredentials: { ...credentials, [id]: credential } });
          }}
        />
      ) : null}
    </>
  );
}

function CredentialRow({
  environmentId,
  environmentLabel,
  credentialId,
  credential,
  connections,
  readOnly,
  onEdit,
  onRemove,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly credentialId: string;
  readonly credential: ModelCredential;
  readonly connections: Readonly<Record<string, ModelProxyConfig>>;
  readonly readOnly: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const probe = useBackendConnectionProbe(environmentId);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const secret = credentialSecretState(credential);
  const referenceCount = countCredentialReferences(connections, credentialId);
  const showTitle = credential.displayName.trim() || credentialId;
  // Preset vendors probe against their public API root; custom vendors have
  // no default URL and only probe through a referencing connection.
  const probeTarget: ModelBackendConfig | undefined = (() => {
    const url = credentialProbeUrl(credential.vendor);
    if (url !== undefined) {
      return { kind: "openai-compatible", baseUrl: url, protocols: ["openai"] };
    }
    const reference = referencingConnection(connections, credentialId);
    return reference
      ? {
          kind: "openai-compatible",
          baseUrl: reference.baseUrl,
          protocols: ["openai"],
          ...(reference.apiKeyEnv !== undefined ? { apiKeyEnv: reference.apiKeyEnv } : {}),
        }
      : undefined;
  })();
  return (
    <div className="flex min-h-18 items-center gap-3 px-3 py-3 sm:px-4">
      <span
        className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] leading-none font-semibold text-foreground/80"
        aria-hidden
      >
        {providerInstanceInitials(showTitle)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{showTitle}</span>
          <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
            {credentialVendorLabel(credential.vendor)}
          </code>
          {showTitle !== credentialId ? (
            <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
              {credentialId}
            </code>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-[13px] leading-[1.45] text-muted-foreground/80">
          {secret.kind === "stored"
            ? `Stored secret${secret.lastFour ? ` · ends in ${secret.lastFour}` : ""}`
            : "No key stored yet"}
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
          {probeTarget ? (
            <Button
              size="xs"
              variant="outline"
              disabled={probe.pending}
              onClick={() => void probe.run(probeTarget, credentialId)}
            >
              {probe.pending ? <Spinner className="size-3.5" /> : null}
              Test
            </Button>
          ) : null}
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
            <AlertDialogTitle>Remove {showTitle}?</AlertDialogTitle>
            <AlertDialogDescription>
              The stored key is deleted from {environmentLabel}.{" "}
              {referenceCount === 0
                ? "No connection uses it."
                : referenceCount === 1
                  ? "1 connection references this key and will connect without a stored key until you pick another."
                  : `${referenceCount} connections reference this key and will connect without a stored key until you pick another.`}
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
              Remove key
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/**
 * Add/edit form for one credential. Vendors start from a preset; Custom
 * reveals a free-text vendor slug. The key field is a password input — the
 * env-row placeholder from the instance editor marks the stored-secret state,
 * and leaving it blank on edit keeps the stored secret (the sentinel travels
 * back untouched). The id is only editable while adding; saves allocate a
 * free id so a collision suffixes instead of overwriting.
 */
function CredentialDialog({
  open,
  onOpenChange,
  environmentLabel,
  credentials,
  editingId,
  initial,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentLabel: string;
  readonly credentials: Readonly<Record<string, ModelCredential>>;
  readonly editingId?: string | undefined;
  readonly initial?: ModelCredential | undefined;
  readonly onSave: (id: string, credential: ModelCredential) => void;
}) {
  const editing = editingId !== undefined;
  const initialVendor = initial?.vendor ?? "";
  const [vendorChoice, setVendorChoice] = useState(() =>
    initialVendor === ""
      ? PICK_VENDOR
      : isPresetVendor(initialVendor)
        ? initialVendor
        : CUSTOM_VENDOR,
  );
  const [customVendor, setCustomVendor] = useState(() =>
    initialVendor === "" || isPresetVendor(initialVendor) ? "" : initialVendor,
  );
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);

  const vendor =
    vendorChoice === CUSTOM_VENDOR
      ? customVendor.trim()
      : vendorChoice === PICK_VENDOR
        ? ""
        : vendorChoice;
  const vendorError =
    vendorChoice === CUSTOM_VENDOR || vendorChoice === PICK_VENDOR
      ? validateVendorSlug(vendor)
      : null;
  const nameError = displayName.trim().length === 0 ? "Display name is required." : null;
  const proposedId = credentialId ?? slugifyCredentialId(displayName || vendor);
  const idError = editing ? null : validateCredentialId(proposedId);
  const error = vendorError ?? nameError ?? idError;
  const canSave = error === null;
  const keepsStoredSecret = editing && value.trim().length === 0;

  const save = () => {
    setHasAttemptedSave(true);
    if (!canSave) return;
    const id = editing ? editingId : allocateCredentialId(proposedId, Object.keys(credentials));
    const credential =
      editing && initial
        ? nextCredentialWithSecret(initial, { displayName, vendor, value })
        : ({
            displayName: displayName.trim(),
            vendor: vendor.trim(),
            value: value.trim(),
          } as ModelCredential);
    onSave(id, credential);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${initial?.displayName || "key"}` : "Add API key"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? `Update the stored key on ${environmentLabel}.`
              : `Store a vendor API key on ${environmentLabel}. Connections reference it by name.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="credential-vendor">Vendor</Label>
              <Select
                value={vendorChoice}
                onValueChange={(next) => {
                  if (typeof next !== "string") return;
                  setVendorChoice(next);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  aria-label="Credential vendor"
                  disabled={editing}
                >
                  <SelectValue>
                    {vendorChoice === CUSTOM_VENDOR
                      ? `Custom${customVendor.trim() ? ` · ${customVendor.trim()}` : ""}`
                      : vendorChoice === PICK_VENDOR
                        ? "Pick a vendor"
                        : credentialVendorLabel(vendorChoice)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {[{ id: PICK_VENDOR, label: "Pick a vendor" }, ...CREDENTIAL_VENDOR_PRESETS].map(
                    (preset) => (
                      <SelectItem key={preset.id} value={preset.id}>
                        {preset.label}
                      </SelectItem>
                    ),
                  )}
                </SelectPopup>
              </Select>
              {vendorChoice === CUSTOM_VENDOR ? (
                <Input
                  id="credential-vendor-custom"
                  className="font-mono"
                  placeholder="vendor slug, e.g. glm"
                  value={customVendor}
                  onChange={(event) => setCustomVendor(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={editing}
                />
              ) : null}
              {hasAttemptedSave && vendorError !== null ? (
                <p role="alert" className="text-xs text-destructive">
                  {vendorError}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="credential-display-name">Display name</Label>
              <Input
                id="credential-display-name"
                placeholder="e.g. Anthropic work key"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                spellCheck={false}
                autoFocus={!editing}
              />
              {hasAttemptedSave && nameError !== null ? (
                <p role="alert" className="text-xs text-destructive">
                  {nameError}
                </p>
              ) : null}
            </div>
            {editing ? null : (
              <div className="grid gap-1.5">
                <Label htmlFor="credential-id">Key ID</Label>
                <Input
                  id="credential-id"
                  className="font-mono"
                  value={credentialId ?? slugifyCredentialId(displayName || vendor)}
                  onChange={(event) => setCredentialId(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
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
              <Label htmlFor="credential-value">API key</Label>
              <Input
                id="credential-value"
                type="password"
                autoComplete="new-password"
                placeholder={
                  keepsStoredSecret
                    ? "Stored secret, enter a new value to replace"
                    : "Paste the key from your vendor"
                }
                value={value}
                onChange={(event) => setValue(event.target.value)}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                {editing
                  ? "Leave blank to keep the stored secret. Keys are stored on the server and never returned to the app."
                  : "Keys are stored on the server and never returned to the app."}
              </p>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {editing ? "Save key" : "Add key"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
