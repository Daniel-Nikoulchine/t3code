"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { WizardPanel, WizardPopup, WizardHeader, WizardFooter } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  getExistingHarnessDrivers,
  resolveWizardNavigation,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

/**
 * Normalize a user-provided label into a slug suffix for the instance id.
 * The full id is formed by prefixing the driver slug — e.g. label "Work" on
 * driver "codex" becomes `codex_work`. Output is trimmed to 48 chars so the
 * final composed id stays under the 64-char slug cap enforced by
 * `ProviderInstanceId` in `@t3tools/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};

/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 * Returns a user-facing error string, or `null` if valid.
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const existingDrivers = useMemo(
    () =>
      getExistingHarnessDrivers({
        providers: settings.providers,
        providerInstances: settings.providerInstances,
      }),
    [settings.providers, settings.providerInstances],
  );
  const [wizardStep, setWizardStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(
    () =>
      DRIVER_OPTIONS.find((option) => !existingDrivers.has(option.value))?.value ??
      DEFAULT_DRIVER_KIND,
  );
  const [label, setLabel] = useState("");
  const [accentColor, setAccentColor] = useState<string>("");
  const [instanceIdOverride, setInstanceIdOverride] = useState<string | null>(null);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
  const instanceId = instanceIdOverride ?? deriveInstanceId(driver, label);
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const driverError = existingDrivers.has(driver)
    ? "This Harness already exists on this device. Edit or enable its existing entry instead."
    : null;
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;
  const wizardStepSummaries = [driverOption.label, previewLabel, null] as const;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[driver];
      } else {
        next[driver] = config;
      }
      return next;
    });
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
        instanceIdError,
        driverError,
      }),
    );
  };

  const handleSave = () => {
    setHasAttemptedSubmit(true);
    if (driverError !== null) {
      setWizardStep(0);
      return;
    }
    if (instanceIdError !== null) return;

    const config = configByDriver[driver] ?? {};
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
    };
    // `ProviderInstanceId.make` revalidates the slug; we've already checked
    // it via `validateInstanceId`, but going through the brand constructor
    // keeps the type boundary honest and guards against any future drift in
    // the slug rules.
    const brandedId = ProviderInstanceId.make(instanceId);
    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: nextInstance,
    };
    try {
      updateSettings({ providerInstances: nextMap });
      toastManager.add({
        type: "success",
        title: "Harness instance added",
        description: `${driverOption.label} instance '${instanceId}' was added.`,
      });
      onOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not add harness instance",
        description: error instanceof Error ? error.message : "Update failed.",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <WizardPopup>
        <WizardHeader
          title="Add Harness instance"
          description={
            <>
              Configure a Harness on {environmentLabel}. Each Harness can only be added once per
              device.
            </>
          }
        >
          <AddProviderInstanceWizardSteps
            currentStep={wizardStep}
            summaries={wizardStepSummaries}
            instanceIdError={instanceIdError}
            driverError={driverError}
            onNavigation={applyWizardNavigation}
          />
        </WizardHeader>

        <WizardPanel>
          <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
            <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
              Driver
            </div>
            <RadioGroup
              value={driver}
              onValueChange={(value) => setDriver(ProviderDriverKind.make(value))}
              aria-labelledby="add-instance-driver-label"
              className="grid grid-cols-1 sm:grid-cols-2"
            >
              {DRIVER_OPTIONS.map((option) => {
                const IconComponent = option.icon;
                return (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    disabled={existingDrivers.has(option.value)}
                    className="data-disabled:cursor-not-allowed data-disabled:opacity-50 relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                  >
                    <IconComponent className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {option.label}
                    </span>
                    <RadioPrimitive.Indicator
                      className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                      aria-hidden
                    >
                      <CheckIcon className="size-3.5 shrink-0" />
                    </RadioPrimitive.Indicator>
                    {existingDrivers.has(option.value) ? (
                      <Badge size="sm">Already added</Badge>
                    ) : option.badgeLabel ? (
                      <Badge variant="warning" size="sm">
                        {option.badgeLabel}
                      </Badge>
                    ) : null}
                  </RadioPrimitive.Root>
                );
              })}
            </RadioGroup>
            {driverError ? (
              <p role="status" className="text-sm text-muted-foreground">
                {driverError}
              </p>
            ) : null}
          </div>

          <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
            <span className="text-xs font-medium text-foreground">Label</span>
            <Input
              placeholder="e.g. Work"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <span className="text-[11px] text-muted-foreground">
              Shown in the harness list. Optional.
            </span>
          </label>

          <label className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
            <span className="text-xs font-medium text-foreground">Instance ID</span>
            <Input
              placeholder={`${driver}_work`}
              value={instanceId}
              onChange={(event) => {
                setInstanceIdOverride(event.target.value);
              }}
              aria-invalid={showInstanceIdError}
            />
            {showInstanceIdError ? (
              <span className="text-[11px] text-destructive">{instanceIdError}</span>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                Routing key used by threads and sessions. Letters, digits, '-', or '_'.
              </span>
            )}
          </label>

          <div className={cn("grid gap-2", wizardStep !== 1 && "hidden")}>
            <span className="text-xs font-medium text-foreground">Accent color</span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ProviderAccentColorPicker
                displayName={label || driverOption.label}
                value={accentColor || undefined}
                onCommit={setAccentColor}
                layout="inline"
              />
              <div className="flex flex-wrap gap-1.5">
                {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
                  const selected = accentColor.toLowerCase() === swatch;
                  return (
                    <button
                      key={swatch}
                      type="button"
                      className={cn(
                        "size-6 cursor-pointer rounded-full border transition",
                        selected
                          ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                          : "border-black/10 hover:scale-105 dark:border-white/20",
                      )}
                      style={{ backgroundColor: swatch }}
                      onClick={() => setAccentColor(swatch)}
                      aria-label={`Use ${swatch} accent`}
                    />
                  );
                })}
              </div>
              {accentColor ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost-muted"
                  onClick={() => setAccentColor("")}
                >
                  Clear
                </Button>
              ) : null}
            </div>
            <span className="text-[11px] text-muted-foreground">
              Optional marker shown in the picker.
            </span>
          </div>

          {driverSettingsFields.length > 0 ? (
            <div className={cn("grid gap-4", wizardStep !== 2 && "hidden")}>
              <ProviderSettingsForm
                definition={driverOption}
                value={configDraft}
                idPrefix={`add-provider-${driver}`}
                variant="dialog"
                onChange={setConfigDraft}
              />
            </div>
          ) : wizardStep === 2 ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                This driver has no required configuration. You can add the instance now.
              </p>
            </div>
          ) : null}
        </WizardPanel>

        <WizardFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (wizardStep === 0) {
                onOpenChange(false);
                return;
              }
              setWizardStep((step) => Math.max(0, step - 1));
            }}
          >
            {wizardStep === 0 ? "Cancel" : "Back"}
          </Button>
          {wizardStep < ADD_PROVIDER_WIZARD_STEPS.length - 1 ? (
            <Button disabled={driverError !== null} onClick={() => navigateToStep(wizardStep + 1)}>
              Next
            </Button>
          ) : (
            <Button disabled={driverError !== null} onClick={handleSave}>
              Add instance
            </Button>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
