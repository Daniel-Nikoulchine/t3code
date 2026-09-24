import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { memo, useMemo, useState } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  ComposerControl,
  ComposerControlChevron,
  type ComposerControlSize,
} from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import { isModelPickerHarnessOptionDisabled } from "./ModelPickerContent";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";

/**
 * Standalone harness (provider instance) picker for the composer.
 * Renders as its own trigger button left of the model picker: icon +
 * instance display name. Selecting a harness keeps the current model when
 * the target harness offers it, otherwise the caller falls back to that
 * harness's default model.
 */
export const HarnessPicker = memo(function HarnessPicker(props: {
  /** Currently selected harness instance. Drives trigger + active row. */
  activeInstanceId: ProviderInstanceId;
  /** All configured instances in display order (built-in + custom). */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  size?: ComposerControlSize;
  disabled?: boolean;
  isComposerOwned?: boolean;
  triggerClassName?: string;
  instanceIndicatorBackground?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onInstanceChange: (instanceId: ProviderInstanceId) => void;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  const size = props.size ?? "sm";

  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries]);

  const visibleEntries = useMemo(() => {
    const enabled = props.instanceEntries.filter(isProviderInstancePickerVisible);
    if (
      activeEntry !== null &&
      !enabled.some((entry) => entry.instanceId === activeEntry.instanceId)
    ) {
      return [activeEntry, ...enabled];
    }
    return enabled;
  }, [activeEntry, props.instanceEntries]);

  const lockedDisabledInstanceIds = useMemo(() => {
    if (props.lockedProvider === null) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of visibleEntries) {
      if (entry.driverKind !== props.lockedProvider) {
        disabled.add(entry.instanceId);
      } else if (
        props.lockedContinuationGroupKey &&
        entry.continuationGroupKey !== props.lockedContinuationGroupKey
      ) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  }, [props.lockedContinuationGroupKey, props.lockedProvider, visibleEntries]);

  const showInstanceBadge =
    activeEntry !== null && shouldShowInstanceBadge(activeEntry, props.instanceEntries);

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  const handleSelect = (instanceId: ProviderInstanceId) => {
    if (props.disabled) return;
    props.onInstanceChange(instanceId);
    setIsMenuOpen(false);
  };

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label={activeEntry ? `Harness: ${activeEntry.displayName}` : "Choose harness"}
            size={size}
            data-chat-harness-picker="true"
            className={cn("min-w-0 shrink whitespace-nowrap", props.triggerClassName)}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn("flex min-w-0 flex-1 items-center", size === "xs" ? "gap-1" : "gap-1.5")}
        >
          {activeEntry ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={activeEntry.displayName}
              accentColor={activeEntry.accentColor}
              showBadge={showInstanceBadge}
              className="size-4"
              iconClassName="size-4"
              indicatorBackground={props.instanceIndicatorBackground ?? "var(--contrast-input)"}
              badgeClassName={cn(
                "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]",
                size === "xs" && "shadow-none",
              )}
            />
          ) : null}
          <span
            className="min-w-0 flex-1 overflow-hidden truncate"
            data-chat-harness-picker-label="true"
          >
            {activeEntry?.displayName ?? "Choose harness"}
          </span>
        </span>
        <span aria-hidden="true" className="flex items-center">
          <ComposerControlChevron size={size} />
        </span>
      </PopoverTrigger>
      <PopoverPopup
        {...(props.isComposerOwned ? composerFloatingLayerProps : {})}
        align="start"
        width="sm"
        padding="none"
      >
        <div
          className="flex max-h-86.5 w-64 flex-col overflow-y-auto overscroll-contain p-1"
          data-harness-picker-content="true"
          role="listbox"
          aria-label="Harness"
        >
          {visibleEntries.map((entry) => {
            const isActive = entry.instanceId === props.activeInstanceId;
            const isDisabled = isModelPickerHarnessOptionDisabled({
              entry,
              ...(lockedDisabledInstanceIds ? { lockedDisabledInstanceIds } : {}),
              // Keep the current harness reachable even when its probe is
              // not ready, mirroring the model picker sidebar.
              ...(isActive && !isProviderInstancePickerReady(entry)
                ? { selectableUnavailableInstanceIds: new Set([entry.instanceId]) }
                : {}),
            });
            const entryShowBadge = shouldShowInstanceBadge(entry, props.instanceEntries);
            return (
              <button
                key={entry.instanceId}
                type="button"
                role="option"
                aria-selected={isActive}
                disabled={isDisabled}
                onClick={() => !isDisabled && handleSelect(entry.instanceId)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none",
                  isDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  accentColor={entry.accentColor}
                  showBadge={entryShowBadge}
                  className="size-6"
                  iconClassName="size-5"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {entry.displayName}
                  </span>
                  {!isProviderInstancePickerReady(entry) ? (
                    <span className="block truncate text-xs text-muted-foreground/70">
                      Not ready
                    </span>
                  ) : null}
                </span>
                {isActive ? <CheckIcon className="size-4 shrink-0" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
