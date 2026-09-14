import type {
  FallbackCombo,
  FallbackStrategy,
  ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  addComboTarget,
  comboModeForThread,
  MAX_FALLBACK_COMBO_TARGETS,
  removeComboTarget,
  setComboStrategy,
} from "@t3tools/client-runtime/state/fallback-combo";
import { memo, useMemo, useState } from "react";
import { ArrowRightLeftIcon, PlusIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";
import {
  ComposerControl,
  ComposerControlChevron,
  type ComposerControlSize,
} from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";

const STRATEGY_OPTIONS: ReadonlyArray<{
  readonly value: FallbackStrategy;
  readonly label: string;
}> = [
  { value: "priority", label: "Priority" },
  { value: "headroom", label: "Headroom" },
  { value: "lkgp", label: "Last known good" },
];

/**
 * Resolve a human-readable label for a combo target from the same sources
 * as the model picker: the instance entry's display name plus the model
 * option's short name, falling back to raw slugs when the catalog does not
 * (yet) list them.
 */
export function resolveComboTargetLabel(
  target: ModelSelection,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): { readonly instance: string; readonly model: string } {
  const entry = instanceEntries.find((candidate) => candidate.instanceId === target.instanceId);
  const option = modelOptionsByInstance
    .get(target.instanceId)
    ?.find((candidate) => candidate.slug === target.model);
  return {
    instance: entry?.displayName ?? String(target.instanceId),
    model: option ? getDisplayModelName(option, { preferShortName: true }) : target.model,
  };
}

/**
 * Minimal single-vs-combo switch next to the model picker. Combo targets
 * reuse the picker's data (no second picker): the current composer
 * selection is appended as a fallback target. Persisting goes through the
 * existing `thread.meta.update` path in the parent (`combo: null` clears
 * back to the manual `ModelSelection`). No drag & drop.
 */
export const ThreadComboEditor = memo(function ThreadComboEditor(props: {
  combo: FallbackCombo | null | undefined;
  currentSelection: ModelSelection;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  size?: ComposerControlSize;
  disabled?: boolean;
  onChange: (combo: FallbackCombo | null) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const size = props.size ?? "sm";
  const mode = comboModeForThread(props.combo);
  const targets = props.combo?.targets ?? [];
  const strategy = props.combo?.strategy ?? "priority";

  const currentAlreadyListed = useMemo(
    () =>
      targets.some(
        (target) =>
          target.instanceId === props.currentSelection.instanceId &&
          target.model === props.currentSelection.model,
      ),
    [targets, props.currentSelection],
  );
  const canAddCurrent = !currentAlreadyListed && targets.length < MAX_FALLBACK_COMBO_TARGETS;

  const triggerLabel = mode === "combo" ? `Combo · ${targets.length}` : "Single";

  return (
    <Popover open={isOpen} onOpenChange={props.disabled ? undefined : setIsOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label={mode === "combo" ? "Edit fallback combo" : "Use a single model"}
            size={size}
            data-chat-combo-editor="true"
            className="min-w-0 shrink whitespace-nowrap"
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn("flex min-w-0 flex-1 items-center", size === "xs" ? "gap-1" : "gap-1.5")}
        >
          <ArrowRightLeftIcon className={size === "xs" ? "size-3" : "size-4"} aria-hidden />
          <span className="min-w-0 flex-1 overflow-hidden truncate">{triggerLabel}</span>
        </span>
        <span aria-hidden="true" className="flex items-center">
          <ComposerControlChevron size={size} />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        {...composerFloatingLayerProps}
        align="start"
        className="w-72 max-w-none text-left whitespace-normal"
        viewportClassName="p-0"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="xs"
              variant={mode === "single" ? "secondary" : "ghost"}
              className="flex-1"
              onClick={() => props.onChange(null)}
            >
              Single
            </Button>
            <Button
              type="button"
              size="xs"
              variant={mode === "combo" ? "secondary" : "ghost"}
              className="flex-1"
              onClick={() => {
                const next = addComboTarget(props.combo, props.currentSelection);
                if (next) props.onChange(next);
              }}
            >
              Combo
            </Button>
          </div>

          {mode === "combo" ? (
            <>
              <div className="flex flex-col gap-1">
                {targets.map((target, index) => {
                  const label = resolveComboTargetLabel(
                    target,
                    props.instanceEntries,
                    props.modelOptionsByInstance,
                  );
                  return (
                    <div
                      key={`${String(target.instanceId)}:${target.model}`}
                      className="flex min-w-0 items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5"
                    >
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs">
                        <span className="font-medium">{label.model}</span>
                        <span className="text-muted-foreground"> · {label.instance}</span>
                      </span>
                      <Button
                        type="button"
                        size="icon-micro"
                        variant="ghost-muted"
                        className="[--control-icon-color:currentColor] hover:text-destructive"
                        onClick={() => {
                          const next = removeComboTarget(props.combo, index);
                          if (next !== undefined) props.onChange(next);
                        }}
                        aria-label={`Remove ${label.model} from combo`}
                      >
                        <XIcon className="size-3" />
                      </Button>
                    </div>
                  );
                })}
              </div>

              <Button
                type="button"
                size="xs"
                variant="outline"
                className="w-full"
                disabled={!canAddCurrent}
                onClick={() => {
                  const next = addComboTarget(props.combo, props.currentSelection);
                  if (next) props.onChange(next);
                }}
              >
                <PlusIcon className="size-3" />
                Add current model
              </Button>

              <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                Strategy
                <Select
                  value={strategy}
                  onValueChange={(value: FallbackStrategy | null) => {
                    if (value === null) return;
                    const next = setComboStrategy(props.combo, value);
                    if (next) props.onChange(next);
                  }}
                >
                  <SelectTrigger size="sm" className="w-36" aria-label="Fallback strategy">
                    <SelectValue>
                      {STRATEGY_OPTIONS.find((option) => option.value === strategy)?.label ??
                        strategy}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {STRATEGY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} hideIndicator value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </label>

              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                className="w-full"
                onClick={() => {
                  props.onChange(null);
                  setIsOpen(false);
                }}
              >
                Clear combo
              </Button>
            </>
          ) : (
            <p className="text-xs leading-snug text-muted-foreground">
              One model per turn. Switch to Combo to fall back across up to{" "}
              {MAX_FALLBACK_COMBO_TARGETS} models when a turn hits a rate limit or provider error.
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
