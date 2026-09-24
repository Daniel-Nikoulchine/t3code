import { Toolbar } from "@base-ui/react/toolbar";
import type { ProviderDriverKind } from "@t3tools/contracts";
import { memo } from "react";
import { SparklesIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isProviderInstancePickerReady,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";

export type ModelPickerProviderChoice = {
  readonly key: string;
  /**
   * Row label: the instance display name for instance rows ("Cline"),
   * the upstream name for router-upstream rows ("opencode-go").
   */
  readonly label: string;
  readonly driverKind: ProviderDriverKind;
  readonly accentColor?: string | undefined;
  /** Instance display name for the icon glyph / badge fallbacks. */
  readonly iconDisplayName: string;
  readonly modelCount: number;
  readonly disabled: boolean;
  readonly tooltip: string;
  readonly showInstanceBadge: boolean;
};

/**
 * Build the hover tooltip for a not-ready provider row. Mirrors the old
 * kind-based copy but uses the entry's configured `displayName` so custom
 * instances get their user-authored name (e.g. "Codex Personal — Unavailable.").
 */
function describeUnavailableInstance(entry: ProviderInstanceEntry): string {
  const label = entry.displayName;
  if (!entry.enabled || entry.status === "disabled") {
    return `${label} — Disabled in settings.`;
  }
  if (entry.status === "ready" && entry.isAvailable) {
    return label;
  }
  const kind =
    entry.status === "error" ? "Unavailable" : entry.status === "warning" ? "Limited" : "Not ready";
  const msg = entry.snapshot.message?.trim();
  return msg ? `${label} — ${kind}. ${msg}` : `${label} — ${kind}.`;
}

/**
 * Second-line label for a provider row. Disabled rows show their status;
 * ready ones show how many models they offer.
 */
export function modelPickerSidebarRowSubtitle(
  choice: Pick<ModelPickerProviderChoice, "disabled" | "modelCount">,
): string {
  if (choice.disabled) {
    return "Not ready";
  }
  return choice.modelCount === 1 ? "1 model" : `${choice.modelCount} models`;
}

/**
 * Normalized sidebar key for one model option served by an instance.
 *
 * Models routed through T3's own `t3-backend` harness bucket (slugs like
 * `t3-backend/opencode-go/…`, including encoded custom-provider ids) are
 * served by their upstream, not the harness: they bucket under the upstream
 * name (`opencode-go`) and the `t3-backend` bucket itself never surfaces as
 * a row. Every other model — native or harness-gateway (Cline, Kilo) —
 * buckets under its owning instance id, so one provider is exactly one row.
 */
export function modelPickerOptionBucketKey(
  option: Pick<ModelEsque, "slug" | "name" | "subProvider">,
  instanceId: string,
): string {
  const upstream = option.subProvider?.trim().toLowerCase();
  // The harness bucket is never a provider row — stale snapshots may still
  // carry it as subProvider (e.g. a twice-prefixed slug), so fall back to
  // the owning instance instead of opening a `t3-backend` row.
  if (upstream && upstream !== "t3-backend" && option.slug.includes("t3-backend")) {
    return upstream;
  }
  return instanceId;
}

/**
 * Sidebar rows for the given instances, in display order: one row per
 * instance plus one row per router upstream served through it
 * (`t3-backend/…` models bucket under their upstream, e.g. "opencode-go").
 * Callers pre-filter `instanceEntries` for thread locks. When
 * `activeInstanceId` is set (composer), instance rows are limited to the
 * active harness — harness selection lives in the standalone HarnessPicker
 * — while router-upstream rows stay global so routed models remain
 * reachable no matter which harness runs the turn. Instances that are
 * neither picker-ready nor explicitly selectable (active unavailable
 * pairing, provider setup) render disabled with their status tooltip.
 */
export function buildModelPickerProviderChoices(input: {
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<string, ReadonlyArray<ModelEsque>>;
  selectableUnavailableInstanceIds?: ReadonlySet<string> | undefined;
  activeInstanceId?: string | undefined;
}): ReadonlyArray<ModelPickerProviderChoice> {
  const allEntries = input.instanceEntries;
  const order: string[] = [];
  const metaByKey = new Map<
    string,
    {
      label: string;
      entry: ProviderInstanceEntry;
      anySelectable: boolean;
      modelCount: number;
    }
  >();
  const pushModel = (
    entry: ProviderInstanceEntry,
    bucketKey: string,
    label: string,
    selectable: boolean,
  ): void => {
    let meta = metaByKey.get(bucketKey);
    if (!meta) {
      meta = { label, entry, anySelectable: false, modelCount: 0 };
      metaByKey.set(bucketKey, meta);
      order.push(bucketKey);
    }
    meta.anySelectable = meta.anySelectable || selectable;
    meta.modelCount += 1;
  };

  for (const entry of allEntries) {
    const selectable =
      isProviderInstancePickerReady(entry) ||
      (input.selectableUnavailableInstanceIds?.has(entry.instanceId) ?? false);
    const isActiveEntry =
      input.activeInstanceId === undefined || entry.instanceId === input.activeInstanceId;
    const options = input.modelOptionsByInstance.get(entry.instanceId) ?? [];
    const instanceKey = entry.instanceId as string;
    if (isActiveEntry) {
      // The instance row scopes to everything the instance serves, native
      // and routed — its count covers all options. Setup-only/disabled rows
      // keep their zero-count row so the status tooltip stays reachable.
      metaByKey.set(instanceKey, {
        label: entry.displayName,
        entry,
        anySelectable: selectable,
        modelCount: options.length,
      });
      order.push(instanceKey);
    } else if (options.length === 0) {
      continue;
    }
    for (const option of options) {
      const bucketKey = modelPickerOptionBucketKey(option, instanceKey);
      if (bucketKey === instanceKey) {
        continue;
      }
      // Router-upstream rows pool across harnesses, but only ready (or
      // active-selectable) shares contribute — an unready harness's routed
      // models are not listable, so they must not inflate the row.
      const contributes = isProviderInstancePickerReady(entry) || (isActiveEntry && selectable);
      if (!contributes) {
        continue;
      }
      pushModel(entry, bucketKey, option.subProvider?.trim() ?? entry.displayName, selectable);
    }
  }

  return order.flatMap((bucketKey) => {
    const meta = metaByKey.get(bucketKey);
    if (!meta) {
      return [];
    }
    const disabled = !meta.anySelectable;
    return [
      {
        key: bucketKey,
        label: meta.label,
        driverKind: meta.entry.driverKind,
        ...(meta.entry.accentColor ? { accentColor: meta.entry.accentColor } : {}),
        iconDisplayName: meta.entry.displayName,
        modelCount: meta.modelCount,
        disabled,
        tooltip: disabled ? describeUnavailableInstance(meta.entry) : meta.label,
        showInstanceBadge: shouldShowInstanceBadge(meta.entry, allEntries),
      } satisfies ModelPickerProviderChoice,
    ];
  });
}

const ROW_BASE_CLASS =
  "relative isolate flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] focus-visible:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] focus-visible:outline-none";

/** Opens toward the rail so the list stays readable (not over the model names). */
const PICKER_TOOLTIP_SIDE = "left" as const;
const PICKER_TOOLTIP_SIDE_OFFSET = 8;
const PICKER_TOOLTIP_CLASS = "max-w-64 text-balance font-normal leading-snug";

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  /** `"favorites"` or an instance id from `choices`. */
  selectedKey: string;
  onSelectKey: (key: string) => void;
  onFocusSearch: () => void;
  /**
   * Provider-filter rows (one per instance plus one per router upstream),
   * already scoped to the thread lock (and, in the composer, to the active
   * harness) when one applies.
   */
  choices: ReadonlyArray<ModelPickerProviderChoice>;
  /** Render the favorites row. Hidden when favorites are not applicable. */
  showFavorites?: boolean;
  /** Instance ids whose "new" sparkle should flag the whole provider row. */
  newBadgeInstanceIds?: ReadonlySet<string>;
}) {
  const handleSelect = (key: string) => {
    props.onSelectKey(key);
  };
  const showFavorites = props.showFavorites ?? true;

  return (
    <Toolbar.Root
      className="w-56 shrink-0 overflow-hidden bg-muted/30"
      data-model-picker-sidebar="true"
      aria-label="Providers"
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
          return;
        }
      }}
    >
      <div className="h-full overflow-y-auto overscroll-contain p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="relative flex min-h-full flex-col gap-0.5">
          {showFavorites ? (
            <div className="relative w-full" data-model-picker-provider="favorites">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toolbar.Button
                      className={cn(
                        ROW_BASE_CLASS,
                        props.selectedKey === "favorites" && "bg-foreground/[0.08]",
                      )}
                      onClick={() => handleSelect("favorites")}
                      type="button"
                      aria-label="Favorites"
                      aria-pressed={props.selectedKey === "favorites"}
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center">
                        <StarIcon className="size-5 fill-current" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          Favorites
                        </span>
                      </span>
                    </Toolbar.Button>
                  }
                />
                <TooltipPopup
                  side={PICKER_TOOLTIP_SIDE}
                  sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                  align="center"
                  className={PICKER_TOOLTIP_CLASS}
                >
                  Favorites
                </TooltipPopup>
              </Tooltip>
            </div>
          ) : null}

          {props.choices.map((choice) => {
            const isDisabled = choice.disabled;
            const isSelected = props.selectedKey === choice.key;
            const showNewBadge = props.newBadgeInstanceIds?.has(choice.key) ?? false;
            const subtitle = modelPickerSidebarRowSubtitle(choice);

            const tooltip = showNewBadge ? `${choice.label} — New` : choice.tooltip;

            const button = (
              <Toolbar.Button
                className={cn(
                  ROW_BASE_CLASS,
                  isSelected && "bg-foreground/[0.08]",
                  isDisabled &&
                    "opacity-50 cursor-not-allowed hover:bg-transparent focus-visible:bg-transparent",
                )}
                data-provider-accent-color={choice.accentColor}
                onClick={() => !isDisabled && handleSelect(choice.key)}
                disabled={isDisabled}
                focusableWhenDisabled={!isDisabled}
                aria-pressed={isSelected}
                type="button"
                aria-label={
                  isDisabled ? tooltip : showNewBadge ? `${choice.label}, new` : choice.label
                }
              >
                <ProviderInstanceIcon
                  driverKind={choice.driverKind}
                  displayName={choice.iconDisplayName}
                  accentColor={choice.accentColor}
                  showBadge={choice.showInstanceBadge}
                  className="size-6 shrink-0"
                  iconClassName="size-5"
                  indicatorBackground={
                    isSelected
                      ? "var(--background)"
                      : "color-mix(in oklab, var(--muted) 30%, transparent)"
                  }
                  {...(choice.accentColor
                    ? { badgeClassName: "h-3 min-w-3 px-0.5 text-[7px]" }
                    : {})}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm font-medium text-foreground">
                      {choice.label}
                    </span>
                    {showNewBadge ? (
                      <span className="shrink-0 text-update-foreground" aria-hidden>
                        <SparklesIcon className="size-3" />
                      </span>
                    ) : null}
                  </span>
                  {subtitle ? (
                    <span className="block truncate text-xs font-normal leading-snug text-muted-foreground/70">
                      {subtitle}
                    </span>
                  ) : null}
                </span>
              </Toolbar.Button>
            );

            const trigger = isDisabled ? (
              <span className="relative block w-full">{button}</span>
            ) : (
              button
            );

            return (
              <div
                key={choice.key}
                className="relative w-full"
                data-model-picker-provider={choice.key}
              >
                <Tooltip>
                  <TooltipTrigger render={trigger} />
                  <TooltipPopup
                    side={PICKER_TOOLTIP_SIDE}
                    sideOffset={PICKER_TOOLTIP_SIDE_OFFSET}
                    align="center"
                    className={PICKER_TOOLTIP_CLASS}
                  >
                    {tooltip}
                  </TooltipPopup>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </div>
    </Toolbar.Root>
  );
});
