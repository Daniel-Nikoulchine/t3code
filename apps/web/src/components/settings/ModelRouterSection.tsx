import { useAtomValue } from "@effect/atom-react";
import { deriveModelCatalog } from "@t3tools/client-runtime/model-catalog";
import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  EnvironmentId,
  ModelCredential,
  ModelProxyConfig,
  ModelRouterRoute,
} from "@t3tools/contracts";
import { T3_ROUTER_CONNECTION_ID } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
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
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
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
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  addModelRouterRoute,
  describeRouteTarget,
  removeModelRouterRoute,
  toModelRouterRoute,
  updateModelRouterRoute,
  validateRouteModelSlug,
  validateRouteTarget,
  type ModelRouterRouteDraft,
} from "./providerRouting.logic";
import {
  buildInstanceConnections,
  CREDENTIAL_VENDOR_PRESETS,
  credentialVendorLabel,
  isPresetVendor,
} from "./providerCredentials.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";

const NO_CREDENTIAL = "";
const PICK_VENDOR = "pick";
const CUSTOM_VENDOR = "custom";

/**
 * Model routing ("Routing" section of the Providers tab). One route maps a
 * logical model id slug — what a harness puts in the `model` field — to an
 * upstream target: a named connection or a vendor API billed to a stored
 * key. The map is a whole-map patch like the connections and credentials
 * maps; there is no automatic fallback, so removing a route simply stops
 * routing that model. Slug suggestions come from the same derived model
 * catalog the Models section renders.
 */
export function ModelRouterSection({
  environmentId,
  environmentLabel,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  // Widened so slug/id lookups with plain strings stay type-clean; the
  // branded records are assignably identical.
  const connections: Record<string, ModelProxyConfig> = settings.modelBackendConnections;
  const credentials: Record<string, ModelCredential> = settings.modelCredentials;
  const routes: Record<string, ModelRouterRoute> = settings.modelRouterRoutes;
  // Same derived catalog the Models section renders; its slugs feed the
  // route dialog's model-ID suggestions.
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const modelSuggestions = useMemo(
    () =>
      deriveModelCatalog({
        providers: serverProviders,
        connections,
        instanceConnections: buildInstanceConnections(settings.providerInstances),
      }).map((model) => model.modelId),
    [serverProviders, connections, settings.providerInstances],
  );
  const [adding, setAdding] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);

  return (
    <>
      <SettingsSection
        {...searchableSetting("model-router")}
        headerAction={
          readOnly ? null : (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add route
            </Button>
          )
        }
      >
        <p className="px-3 pb-1 text-xs text-muted-foreground sm:px-4">
          Send a model's requests to a connection or vendor API by its model ID. There is no
          automatic fallback — a model without a route is not routed.
        </p>
        {Object.entries(routes).length === 0 ? (
          <div className="px-3 py-3 sm:px-4">
            <p className="text-sm font-medium text-foreground">No routes configured.</p>
            <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">
              {readOnly
                ? `No routing rules on ${environmentLabel}.`
                : "Add a route to send a model's requests to a connection or vendor API."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/50 overflow-hidden">
            {Object.entries(routes).map(([slug, route]) => (
              <RouteRow
                key={slug}
                environmentLabel={environmentLabel}
                slug={slug}
                route={route}
                connections={connections}
                credentials={credentials}
                readOnly={readOnly}
                onEdit={() => setEditingSlug(slug)}
                onRemove={() =>
                  updateSettings({ modelRouterRoutes: removeModelRouterRoute(routes, slug) })
                }
              />
            ))}
          </div>
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <RouteDialog
          open
          onOpenChange={setAdding}
          environmentLabel={environmentLabel}
          routes={routes}
          connections={connections}
          credentials={credentials}
          modelSuggestions={modelSuggestions}
          onSave={(nextRoutes) => updateSettings({ modelRouterRoutes: nextRoutes })}
        />
      ) : null}
      {editingSlug !== null && routes[editingSlug] && !readOnly ? (
        <RouteDialog
          open
          onOpenChange={() => setEditingSlug(null)}
          environmentLabel={environmentLabel}
          routes={routes}
          connections={connections}
          credentials={credentials}
          modelSuggestions={modelSuggestions}
          editingSlug={editingSlug}
          initial={routes[editingSlug]}
          onSave={(nextRoutes) => updateSettings({ modelRouterRoutes: nextRoutes })}
        />
      ) : null}
    </>
  );
}

/**
 * One route row: the model slug as the identity, the target as a plain
 * summary line ("→ Connection: GLM" / "→ Anthropic key · …last4"), and the
 * upstream slug when the route does not pass the model ID through.
 */
function RouteRow({
  environmentLabel,
  slug,
  route,
  connections,
  credentials,
  readOnly,
  onEdit,
  onRemove,
}: {
  readonly environmentLabel: string;
  readonly slug: string;
  readonly route: ModelRouterRoute;
  readonly connections: Readonly<Record<string, ModelProxyConfig>>;
  readonly credentials: Readonly<Record<string, ModelCredential>>;
  readonly readOnly: boolean;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  return (
    <div className="flex min-h-18 items-center gap-3 px-3 py-3 sm:px-4">
      <span
        className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] leading-none font-semibold text-foreground/80"
        aria-hidden
      >
        {providerInstanceInitials(slug)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{slug}</span>
        <span className="mt-0.5 block truncate text-[13px] leading-[1.45] text-muted-foreground/80">
          {`→ ${describeRouteTarget(route.target, connections, credentials)}`}
          {route.upstreamModel !== undefined ? ` · upstream: ${route.upstreamModel}` : ""}
        </span>
      </span>
      {readOnly ? null : (
        <span className="flex shrink-0 items-center gap-2">
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
            <AlertDialogTitle>Remove route for {slug}?</AlertDialogTitle>
            <AlertDialogDescription>
              The route is deleted from {environmentLabel}. Requests for this model are no longer
              routed.
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
              Remove route
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/**
 * Add/edit form for one route. The model slug is free text with suggestions
 * from the derived model catalog (browser datalist — no picker to mount).
 * The target is a radio pick: a named connection, or a vendor API billed to
 * a stored key (base URL required only for vendors without a preset root).
 * The upstream slug and preset base-URL overrides sit under Advanced; a
 * blank upstream slug passes the model ID through unchanged.
 */
function RouteDialog({
  open,
  onOpenChange,
  environmentLabel,
  routes,
  connections,
  credentials,
  modelSuggestions,
  editingSlug,
  initial,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentLabel: string;
  readonly routes: Readonly<Record<string, ModelRouterRoute>>;
  readonly connections: Readonly<Record<string, ModelProxyConfig>>;
  readonly credentials: Readonly<Record<string, ModelCredential>>;
  /** Model slugs from the derived catalog, offered as datalist suggestions. */
  readonly modelSuggestions: ReadonlyArray<string>;
  readonly editingSlug?: string | undefined;
  readonly initial?: ModelRouterRoute | undefined;
  readonly onSave: (nextRoutes: Record<string, ModelRouterRoute>) => void;
}) {
  const editing = editingSlug !== undefined;
  const initialTarget = initial?.target;
  const [modelSlug, setModelSlug] = useState(editing ? editingSlug : "");
  const [targetKind, setTargetKind] = useState<"connection" | "vendor">(
    initialTarget?.kind === "vendor" ? "vendor" : "connection",
  );
  const [connectionId, setConnectionId] = useState(() =>
    initialTarget?.kind === "connection" ? String(initialTarget.connectionId) : "",
  );
  const initialVendor = initialTarget?.kind === "vendor" ? String(initialTarget.vendor) : "";
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
  const [credentialId, setCredentialId] = useState(() =>
    initialTarget?.kind === "vendor" ? String(initialTarget.credentialId) : NO_CREDENTIAL,
  );
  const [baseUrl, setBaseUrl] = useState(() =>
    initialTarget?.kind === "vendor" ? (initialTarget.baseUrl ?? "") : "",
  );
  const [upstreamModel, setUpstreamModel] = useState(initial?.upstreamModel ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(
    () =>
      editing &&
      (initial?.upstreamModel !== undefined ||
        (initialTarget?.kind === "vendor" && initialTarget.baseUrl !== undefined)),
  );
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);

  const vendor =
    vendorChoice === CUSTOM_VENDOR
      ? customVendor.trim()
      : vendorChoice === PICK_VENDOR
        ? ""
        : vendorChoice;
  const draft: ModelRouterRouteDraft = {
    modelSlug,
    targetKind,
    connectionId,
    vendor,
    credentialId: credentialId === NO_CREDENTIAL ? "" : credentialId,
    baseUrl,
    upstreamModel,
  };
  const route = toModelRouterRoute(draft);
  const slugError = validateRouteModelSlug(modelSlug, routes, editingSlug);
  const targetError = validateRouteTarget(draft, connections, credentials);
  const error = slugError ?? targetError;
  const canSave = error === null && route !== undefined;

  const save = () => {
    setHasAttemptedSave(true);
    if (!canSave || route === undefined) return;
    const slug = modelSlug.trim();
    onSave(
      editing
        ? updateModelRouterRoute(routes, editingSlug, slug, route)
        : addModelRouterRoute(routes, slug, route),
    );
    onOpenChange(false);
  };

  const vendorOptions = [{ id: PICK_VENDOR, label: "Pick a vendor" }, ...CREDENTIAL_VENDOR_PRESETS];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit route for ${editingSlug}` : "Add route"}</DialogTitle>
          <DialogDescription>
            {editing
              ? `Update the routing rule on ${environmentLabel}.`
              : `Route one model on ${environmentLabel} to a connection or vendor API.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="route-model-slug">Model ID</Label>
              <Input
                id="route-model-slug"
                className="font-mono"
                placeholder="e.g. gpt-5.2"
                value={modelSlug}
                onChange={(event) => setModelSlug(event.target.value)}
                list="model-router-route-slugs"
                spellCheck={false}
                autoComplete="off"
                autoFocus
              />
              <datalist id="model-router-route-slugs">
                {modelSuggestions.map((slug) => (
                  <option key={slug} value={slug} />
                ))}
              </datalist>
              {hasAttemptedSave && slugError !== null ? (
                <p role="alert" className="text-xs text-destructive">
                  {slugError}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  What the harness puts in the model field; suggestions come from discovered models.
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label>Target</Label>
              <RadioGroup
                value={targetKind}
                onValueChange={(next) => {
                  if (next === "connection" || next === "vendor") setTargetKind(next);
                }}
                className="flex flex-row gap-6"
              >
                <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <Radio value="connection" aria-label="Route to a connection" />
                  Connection
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <Radio value="vendor" aria-label="Route to a vendor API" />
                  Vendor
                </label>
              </RadioGroup>
            </div>
            {targetKind === "connection" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="route-connection">Connection</Label>
                <Select
                  value={connectionId}
                  onValueChange={(next) => {
                    if (typeof next !== "string") return;
                    setConnectionId(next);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full"
                    aria-label="Connection for this route"
                  >
                    <SelectValue>
                      {connectionId === ""
                        ? "Pick a connection"
                        : connections[connectionId]?.displayName?.trim() || connectionId}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {/* The built-in router is not a settings entry — routing to
                        itself would loop, so it is never offered here. */}
                    {Object.entries(connections)
                      .filter(([id]) => id !== T3_ROUTER_CONNECTION_ID)
                      .map(([id, connection]) => (
                        <SelectItem key={id} value={id}>
                          {connection.displayName?.trim() || id}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
                {hasAttemptedSave && targetError !== null ? (
                  <p role="alert" className="text-xs text-destructive">
                    {targetError}
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="route-vendor">Vendor</Label>
                  <Select
                    value={vendorChoice}
                    onValueChange={(next) => {
                      if (typeof next !== "string") return;
                      setVendorChoice(next);
                    }}
                  >
                    <SelectTrigger size="sm" className="w-full" aria-label="Route vendor">
                      <SelectValue>
                        {vendorChoice === CUSTOM_VENDOR
                          ? `Custom${customVendor.trim() ? ` · ${customVendor.trim()}` : ""}`
                          : vendorChoice === PICK_VENDOR
                            ? "Pick a vendor"
                            : credentialVendorLabel(vendorChoice)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      {vendorOptions.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  {vendorChoice === CUSTOM_VENDOR ? (
                    <Input
                      id="route-vendor-custom"
                      className="font-mono"
                      placeholder="vendor slug, e.g. glm"
                      value={customVendor}
                      onChange={(event) => setCustomVendor(event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  ) : null}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="route-credential">Stored API key</Label>
                  <Select
                    value={credentialId === NO_CREDENTIAL ? NO_CREDENTIAL : credentialId}
                    onValueChange={(next) => {
                      if (typeof next !== "string") return;
                      setCredentialId(next);
                      const credential = next === NO_CREDENTIAL ? undefined : credentials[next];
                      // Picking a key suggests its vendor — the key is what
                      // authenticates against the vendor API.
                      if (credential !== undefined && isPresetVendor(credential.vendor)) {
                        setVendorChoice(credential.vendor);
                        setCustomVendor("");
                      }
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-full"
                      aria-label="Stored API key for this route"
                    >
                      <SelectValue>
                        {credentialId === NO_CREDENTIAL
                          ? "Pick a stored API key"
                          : credentials[credentialId]?.displayName?.trim() || credentialId}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      {Object.entries(credentials).map(([id, credential]) => (
                        <SelectItem key={id} value={id}>
                          {`${credential.displayName.trim()} · ${credentialVendorLabel(credential.vendor)}`}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                {!isPresetVendor(vendor) ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="route-base-url">Base URL</Label>
                    <Input
                      id="route-base-url"
                      className="font-mono"
                      placeholder="https://api.example.com/v1"
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      Custom vendors have no preset API root.
                    </p>
                  </div>
                ) : null}
              </>
            )}
            {hasAttemptedSave && targetError !== null && targetKind === "vendor" ? (
              <p role="alert" className="text-xs text-destructive">
                {targetError}
              </p>
            ) : null}
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger
                className={cn(
                  "flex w-full items-center gap-1 text-left text-xs font-medium",
                  advancedOpen ? "text-foreground" : "text-muted-foreground",
                )}
              >
                Advanced
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="grid gap-4 pt-3">
                  {targetKind === "vendor" && vendor.length > 0 && isPresetVendor(vendor) ? (
                    <div className="grid gap-1.5">
                      <Label htmlFor="route-base-url-override">Base URL override</Label>
                      <Input
                        id="route-base-url-override"
                        className="font-mono"
                        placeholder="Default API root"
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </div>
                  ) : null}
                  <div className="grid gap-1.5">
                    <Label htmlFor="route-upstream-model">Upstream model</Label>
                    <Input
                      id="route-upstream-model"
                      className="font-mono"
                      placeholder="Model ID sent upstream"
                      value={upstreamModel}
                      onChange={(event) => setUpstreamModel(event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave blank to pass the model ID through unchanged.
                    </p>
                  </div>
                </div>
              </CollapsiblePanel>
            </Collapsible>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {editing ? "Save route" : "Add route"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
