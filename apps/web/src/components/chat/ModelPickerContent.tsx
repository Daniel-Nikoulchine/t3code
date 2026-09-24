import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import type { LogicalModel, LogicalModelSource } from "@t3tools/client-runtime/model-catalog";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { CheckIcon, ChevronRightIcon, SearchIcon, StarIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import {
  ModelPickerSidebar,
  buildModelPickerProviderChoices,
  modelPickerOptionBucketKey,
} from "./ModelPickerSidebar";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  LOGICAL_LEGACY_SECTION_KEY,
  modelPickerLegacySectionKey,
  modelPickerLogicalModelKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerLogicalModelKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import { Badge } from "../ui/badge";
import { ModelEsque, PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  /** Sidebar provider-filter bucket: the owning instance id or a router-upstream key. */
  providerKey: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
  /** Set when the owning instance routes through an external model backend. */
  viaProxy?: boolean | undefined;
  /** Set when that proxy degrades model capabilities. */
  capabilitiesDegraded?: boolean | undefined;
};

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

export function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    (input.entry.driverKind === "opencode" || input.entry.driverKind === "antigravity") &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

export function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      !options.some((option) => !option.isUnavailable))
  );
}

/**
 * Whether a harness option is disabled in the explicit harness selector.
 * Mirrors `ModelPickerSidebar` so the dropdown and the icon rail never
 * disagree: not-ready instances stay disabled unless their selected
 * unavailable model is reachable, and locked threads disable other drivers.
 */
export function isModelPickerHarnessOptionDisabled(input: {
  readonly entry: ProviderInstanceEntry;
  readonly lockedDisabledInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  readonly selectableUnavailableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
}): boolean {
  const isUnavailable = !isProviderInstancePickerReady(input.entry);
  const isContextDisabled = input.lockedDisabledInstanceIds?.has(input.entry.instanceId) ?? false;
  const unavailableSelectionIsReachable =
    input.selectableUnavailableInstanceIds?.has(input.entry.instanceId) ?? false;
  return (isUnavailable && !unavailableSelectionIsReachable) || isContextDisabled;
}

/**
 * Keyboard walk over the sidebar: favorites first, then every non-disabled
 * provider-choice key in render order.
 */
export function adjacentModelPickerProvider(input: {
  providerKeys: ReadonlyArray<string>;
  selectedKey: string;
  direction: 1 | -1;
}) {
  const providers: Array<string> = ["favorites", ...input.providerKeys];
  const index = providers.indexOf(input.selectedKey);
  return providers[
    index < 0
      ? input.direction === 1
        ? 0
        : providers.length - 1
      : (index + input.direction + providers.length) % providers.length
  ]!;
}

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();

/** One model-first picker row for a pooled logical model. */
export interface LogicalModelPickerItem {
  /** Logical model slug (`LogicalModel.modelId`). */
  modelId: string;
  displayName: string;
  /** Concrete pairings that can serve the model here, in catalog order. */
  sources: ReadonlyArray<LogicalModelSource>;
  /** Every pairing is flagged legacy in the per-instance options. */
  isLegacy: boolean;
  /** The composer's current selection maps onto one of this model's sources. */
  isActive: boolean;
  /**
   * Set only on the synthetic fallback item that keeps an active selection
   * the catalog cannot see (unavailable row, stale catalog) selectable.
   */
  isActiveUnavailable?: boolean;
}

/**
 * Projects the pooled catalog onto the model-first picker's rows. Sources on
 * instances that are not picker-ready are dropped, as are sources outside the
 * sidebar's selected provider bucket (an instance id, a router-upstream key,
 * or all ready sources when the favorites tab is active), except the current
 * selection's own pairing, which always stays reachable — when nothing maps
 * to it, a synthetic single-source item is appended so the combobox value
 * keeps a visible row.
 */
export function buildLogicalModelPickerItems(input: {
  logicalModels: ReadonlyArray<LogicalModel>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  activeInstanceId: ProviderInstanceId;
  activeModel: string;
  /** Sidebar scope: a provider-choice key, or `"favorites"` for the unscoped favorites tab. */
  scopeProviderKey: string;
  /**
   * When set, every source must belong to the active harness instance —
   * the composer lists only the active harness's models, never another
   * harness's (nor its router upstreams). The current selection's own
   * pairing is exempt via the active-source fallback below.
   */
  scopeToActiveInstance?: boolean;
  lockedProvider?: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
}): ReadonlyArray<LogicalModelPickerItem> {
  const entryByInstanceId = new Map(
    input.instanceEntries.map((entry) => [entry.instanceId, entry] as const),
  );
  const optionFor = (instanceId: ProviderInstanceId, model: string): ModelEsque | undefined =>
    input.modelOptionsByInstance.get(instanceId)?.find((option) => option.slug === model);
  const isVisibleSource = (instanceId: ProviderInstanceId, model: string): boolean => {
    // The sidebar pins the browse scope the same way the old per-instance
    // rail did: one provider bucket (instance or router upstream) at a time,
    // or every ready source on favorites. The synthetic fallback for the
    // active selection does not consult this filter.
    //
    // An instance scope covers everything the instance serves, native and
    // routed. In the composer (`scopeToActiveInstance`), instance and
    // favorites scopes stay on the active harness — only its models are
    // listed. Router-upstream scopes pool across every ready harness
    // instead, so routed models stay reachable no matter which harness runs
    // the turn.
    if (input.scopeProviderKey !== "favorites") {
      const isInstanceScope = entryByInstanceId.has(input.scopeProviderKey as ProviderInstanceId);
      if (isInstanceScope) {
        if ((instanceId as string) !== input.scopeProviderKey) {
          return false;
        }
      } else {
        const option = optionFor(instanceId, model);
        const bucketKey = modelPickerOptionBucketKey(
          option ?? { slug: model, name: model },
          instanceId as string,
        );
        if (bucketKey !== input.scopeProviderKey) {
          return false;
        }
      }
      if (
        isInstanceScope &&
        input.scopeToActiveInstance === true &&
        instanceId !== input.activeInstanceId
      ) {
        return false;
      }
    } else if (input.scopeToActiveInstance === true && instanceId !== input.activeInstanceId) {
      return false;
    }
    const entry = entryByInstanceId.get(instanceId);
    if (!entry || !isProviderInstancePickerReady(entry)) {
      return false;
    }
    if (input.lockedProvider != null) {
      if (entry.driverKind !== input.lockedProvider) return false;
      if (
        input.lockedContinuationGroupKey &&
        entry.continuationGroupKey !== input.lockedContinuationGroupKey
      ) {
        return false;
      }
    }
    return true;
  };

  const items: LogicalModelPickerItem[] = [];
  let hasActiveItem = false;
  for (const logical of input.logicalModels) {
    const activeSources = logical.sources.filter(
      (source) =>
        source.instanceId === input.activeInstanceId && source.model === input.activeModel,
    );
    const sources = logical.sources.filter((source) =>
      isVisibleSource(source.instanceId as ProviderInstanceId, source.model),
    );
    if (sources.length === 0 && activeSources.length === 0) {
      continue;
    }
    // The current selection stays reachable even when its instance is not
    // picker-ready — the highlight must not disappear while the picker is open.
    const visibleSources = activeSources.some((source) => !sources.includes(source))
      ? [...sources, ...activeSources.filter((source) => !sources.includes(source))]
      : sources;
    if (activeSources.length > 0) {
      hasActiveItem = true;
    }
    items.push({
      modelId: logical.modelId,
      displayName: logical.displayName,
      sources: visibleSources,
      isLegacy:
        visibleSources.length > 0 &&
        visibleSources.every(
          (source) =>
            optionFor(source.instanceId as ProviderInstanceId, source.model)?.isLegacy === true,
        ),
      isActive: activeSources.length > 0,
    });
  }

  if (input.activeModel && !hasActiveItem) {
    const option = optionFor(input.activeInstanceId, input.activeModel);
    items.push({
      modelId: input.activeModel,
      displayName: option?.name ?? input.activeModel,
      sources: [
        {
          instanceId: input.activeInstanceId,
          model: input.activeModel,
          via: "native",
          authMode: "unknown",
          ...(option?.subProvider ? { subProvider: option.subProvider } : {}),
        },
      ],
      isLegacy: option?.isLegacy === true,
      isActive: true,
      ...(option?.isUnavailable === true ? { isActiveUnavailable: true } : {}),
    });
  }

  return items;
}

/** One model-first picker row: a logical model, one of its source pairings, or the legacy section header. */
type ModelFirstRow =
  | { readonly kind: "logical"; readonly key: string; readonly item: LogicalModelPickerItem }
  | {
      readonly kind: "source";
      readonly key: string;
      readonly item: LogicalModelPickerItem;
      readonly source: LogicalModelSource;
    }
  | { readonly kind: "legacy-header"; readonly key: string; readonly count: number };

/** One client-settings favorites entry: an instance id plus a model slug. */
export interface ModelFavoriteEntry {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

/**
 * Toggle a logical model row's favorite star. A logical model fans out to
 * every instance pairing that can serve it, so one tap favorites all of
 * them at once (or clears all of them when the whole set is already
 * favorited) — a half-favorited multi-source row can never strand its star
 * in an ambiguous state.
 */
export function toggleLogicalModelFavorite(
  favorites: ReadonlyArray<ModelFavoriteEntry>,
  item: Pick<LogicalModelPickerItem, "sources">,
): Array<ModelFavoriteEntry> {
  const keys = item.sources.map((source) => ({
    provider: source.instanceId as ProviderInstanceId,
    model: source.model,
  }));
  const matches = (favorite: ModelFavoriteEntry, key: (typeof keys)[number]): boolean =>
    favorite.provider === key.provider && favorite.model === key.model;
  if (
    keys.length > 0 &&
    keys.every((key) => favorites.some((favorite) => matches(favorite, key)))
  ) {
    return favorites.filter((favorite) => !keys.some((key) => matches(favorite, key)));
  }
  const existing = new Set(
    favorites.map((favorite) => providerModelKey(favorite.provider, favorite.model)),
  );
  return [
    ...favorites,
    ...keys.filter((key) => !existing.has(providerModelKey(key.provider, key.model))),
  ];
}

/**
 * A logical model row commits directly when exactly one instance can serve
 * the model; otherwise it expands in place to the instance sub-pick rows.
 */
function LogicalModelRow(props: {
  index: number;
  item: LogicalModelPickerItem;
  expanded: boolean;
  /** Resolved single serving instance; undefined for multi-source rows. */
  singleSourceEntry: ProviderInstanceEntry | undefined;
  jumpLabel?: string | null;
  isFavorite: boolean;
  onToggleFavorite: () => void;
}) {
  const multiSource = props.item.sources.length > 1;
  const ProviderIcon = props.singleSourceEntry
    ? (PROVIDER_ICON_BY_PROVIDER[props.singleSourceEntry.driverKind] ?? null)
    : null;
  const singleSource = multiSource ? undefined : props.item.sources[0];
  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={modelPickerLogicalModelKey(props.item.modelId)}
      contentClassName="flex w-full items-center gap-3"
      className={cn(
        "group w-full !min-w-0 max-w-full cursor-pointer rounded-md px-2 py-2 transition-[background-color,box-shadow,color]",
        "hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] data-highlighted:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))] data-selected:bg-foreground/[0.08] data-selected:text-foreground data-selected:ring-0 [&[data-highlighted][data-selected]]:bg-[color-mix(in_srgb,var(--popover)_90%,var(--contrast-foreground))]",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 truncate text-xs font-medium leading-snug">
            {props.item.displayName}
          </div>
          {multiSource ? (
            <Badge variant="outline" size="sm">
              {props.item.sources.length} providers
            </Badge>
          ) : null}
          {props.item.isActiveUnavailable ? (
            <Badge variant="outline" size="sm">
              Unavailable
            </Badge>
          ) : null}
        </div>
        {singleSource && props.singleSourceEntry ? (
          <div className="mt-1 flex items-center gap-1.5">
            {ProviderIcon ? <ProviderIcon className="size-3 shrink-0" /> : null}
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {singleSource.subProvider ?? props.singleSourceEntry.displayName}
            </span>
            {singleSource.authMode === "subscription" ? (
              <Badge variant="outline" size="sm">
                Subscription
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {props.jumpLabel ? (
          <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-[10px]">{props.jumpLabel}</Kbd>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className={cn(
                  "-mr-1 shrink-0 text-muted-foreground/70 opacity-64 transition-[color,opacity] hover:text-foreground hover:opacity-100 group-hover:opacity-100",
                  props.isFavorite && "text-foreground opacity-100",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onToggleFavorite();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
                aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              >
                <StarIcon
                  className={cn(
                    "size-3.5 sm:size-3",
                    props.isFavorite && "fill-current text-yellow-500",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
          </TooltipPopup>
        </Tooltip>
        {props.item.isActive ? (
          <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
        {multiSource ? (
          <ChevronRightIcon
            className={cn("size-4 transition-transform", props.expanded && "rotate-90")}
          />
        ) : null}
      </div>
    </ComboboxItem>
  );
}

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Multiple instances of the same kind
   * remain selectable (e.g. locked to `codex` still lets the user switch
   * between the default Codex and a custom Codex Personal).
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /**
   * All configured provider instances in display order. Used to render
   * the sidebar (one button per instance) and to resolve display names
   * for the locked-mode header.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Model options per instance. Keyed by `ProviderInstanceId` so the
   * default Codex instance and any custom Codex instances each have their
   * own list (custom instances typically start with the same built-in
   * model set but are free to diverge via customModels).
   */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  /**
   * Pooled logical models from `deriveAppModelCatalog`. When set, the picker
   * renders model-first: one row per logical model, expanding to the
   * concrete instance pairings that can serve it. When omitted, the picker
   * keeps the per-instance instance-scoped list (settings surfaces).
   */
  logicalModels?: ReadonlyArray<LogicalModel>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favorites = useClientSettings((s) => s.favorites ?? []);
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug =
    activeModel?.slug ?? (props.model === ANTIGRAVITY_DEFAULT_MODEL ? "" : props.model);
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const activeInstanceHasSelectableUnavailableModel =
    activeEntry !== undefined &&
    (modelOptionsByInstance.get(props.activeInstanceId) ?? []).some((option) =>
      shouldIncludeModelPickerOption({
        entry: activeEntry,
        option,
        activeInstanceId: props.activeInstanceId,
        activeModel: activeModelSlug,
      }),
    ) &&
    !isProviderInstancePickerReady(activeEntry);
  const activeInstanceNeedsSetup =
    props.onOpenProviderSetup !== undefined &&
    activeEntry !== undefined &&
    shouldOfferModelPickerSetup(
      activeEntry,
      modelOptionsByInstance.get(props.activeInstanceId) ?? [],
    );
  const activeProviderKey = props.activeInstanceId as string;
  const [selectedProviderKey, setSelectedProviderKey] = useState<string>(() => {
    if (
      props.logicalModels !== undefined ||
      props.lockedProvider !== null ||
      activeInstanceHasSelectableUnavailableModel ||
      activeInstanceNeedsSetup
    ) {
      // Model-first scopes to the active harness by default: the composer
      // lists only the active harness's models, never another harness's.
      // Otherwise keep the active provider visible when it is locked or
      // needs setup.
      return activeProviderKey;
    }
    return favorites.length > 0 ? "favorites" : activeProviderKey;
  });
  const [expandedLegacyScopeKeys, setExpandedLegacyScopeKeys] = useState(
    () =>
      new Set<string>(
        modelOptionsByInstance
          .get(props.activeInstanceId)
          ?.some((model) => model.slug === activeModelSlug && model.isLegacy)
          ? [activeProviderKey]
          : [],
      ),
  );
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const updateSettings = useUpdateClientSettings();

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectProviderKey = useCallback(
    (key: string) => {
      setSelectedProviderKey(key);
      window.requestAnimationFrame(() => {
        focusSearchInput();
      });
    },
    [focusSearchInput],
  );

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  // Create a Set for efficient lookup. Favorites are keyed by
  // `${instanceId}:${slug}`; the storage schema widened from ProviderDriverKind
  // to ProviderInstanceId so pre-migration favorites keyed by driver slugs
  // (e.g. `"codex:gpt-5"`) still resolve — the default instance id equals
  // the driver slug.
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  }, [favorites]);

  /**
   * Lookup table keyed by `instanceId`. Used for display name + driver
   * kind enrichment and for `ready`/enabled filtering before flattening
   * models into the search list.
   */
  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );
  const matchesLockedProvider = useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (props.lockedProvider === null) return true;
      if (entry.driverKind !== props.lockedProvider) return false;
      if (!props.lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === props.lockedContinuationGroupKey;
    },
    [props.lockedContinuationGroupKey, props.lockedProvider],
  );

  const selectableUnavailableInstanceIds = useMemo(() => {
    const instanceIds = new Set<ProviderInstanceId>();
    if (activeInstanceHasSelectableUnavailableModel) {
      instanceIds.add(props.activeInstanceId);
    }
    if (props.onOpenProviderSetup) {
      for (const entry of instanceEntries) {
        if (
          shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? [])
        ) {
          instanceIds.add(entry.instanceId);
        }
      }
    }
    return instanceIds.size > 0 ? instanceIds : undefined;
  }, [
    activeInstanceHasSelectableUnavailableModel,
    instanceEntries,
    modelOptionsByInstance,
    props.activeInstanceId,
    props.onOpenProviderSetup,
  ]);

  // Flatten models into a searchable array. One pass over the
  // instance-keyed map; each model carries its instance id + driver kind
  // so the list row can render the right icon and display name without
  // another lookup.
  const isModelFirst = props.logicalModels !== undefined;
  const flatModels = useMemo(() => {
    const out: ModelPickerItem[] = [];
    if (isModelFirst) {
      return out;
    }
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        // Instance disappeared between renders (configuration change). Skip
        // its models — stale options shouldn't appear in the picker.
        continue;
      }
      for (const model of models) {
        if (
          !shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: props.activeInstanceId,
            activeModel: activeModelSlug,
          })
        ) {
          continue;
        }
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          ...(model.viaProxy ? { viaProxy: true as const } : {}),
          ...(model.capabilitiesDegraded ? { capabilitiesDegraded: true as const } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          providerKey: modelPickerOptionBucketKey(model, instanceId as string),
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  }, [
    isModelFirst,
    modelOptionsByInstance,
    entryByInstanceId,
    props.activeInstanceId,
    activeModelSlug,
  ]);

  const isSearching = searchQuery.trim().length > 0;

  // ── Model-first list: logical models pooled across instances ───────
  // Search is global within the active harness: the browse scope drops to
  // the unscoped pool while a query is active, and `scopeToActiveInstance`
  // keeps every scope (including search and favorites) on the active
  // harness — harness selection lives in the standalone HarnessPicker, so
  // the model picker never shows another harness's models or upstreams.
  const logicalItems = useMemo(() => {
    if (!isModelFirst) {
      return [];
    }
    return buildLogicalModelPickerItems({
      logicalModels: props.logicalModels ?? [],
      modelOptionsByInstance,
      instanceEntries,
      activeInstanceId: props.activeInstanceId,
      activeModel: activeModelSlug,
      scopeProviderKey: isSearching ? "favorites" : selectedProviderKey,
      scopeToActiveInstance: true,
      ...(props.lockedProvider !== null ? { lockedProvider: props.lockedProvider } : {}),
      ...(props.lockedContinuationGroupKey
        ? { lockedContinuationGroupKey: props.lockedContinuationGroupKey }
        : {}),
    });
  }, [
    activeModelSlug,
    instanceEntries,
    isModelFirst,
    isSearching,
    modelOptionsByInstance,
    props.activeInstanceId,
    props.logicalModels,
    props.lockedContinuationGroupKey,
    props.lockedProvider,
    selectedProviderKey,
  ]);
  // Expansion defaults open for the active multi-source model so its concrete
  // pairings are visible; a user's toggle inverts that until the picker closes.
  const [logicalExpansionOverrides, setLogicalExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [logicalLegacyExpanded, setLogicalLegacyExpanded] = useState(false);
  const isLogicalModelExpanded = useCallback(
    (item: LogicalModelPickerItem) => {
      const defaultExpanded = item.isActive && item.sources.length > 1;
      const hasOverride = logicalExpansionOverrides.has(item.modelId);
      return defaultExpanded ? !hasOverride : hasOverride;
    },
    [logicalExpansionOverrides],
  );
  const toggleLogicalModelExpanded = useCallback((modelId: string) => {
    setLogicalExpansionOverrides((current) => {
      const next = new Set(current);
      if (!next.delete(modelId)) {
        next.add(modelId);
      }
      return next;
    });
  }, []);
  const isFavoriteLogicalItem = useCallback(
    (item: LogicalModelPickerItem) =>
      item.sources.some((source) =>
        favoritesSet.has(providerModelKey(source.instanceId as ProviderInstanceId, source.model)),
      ),
    [favoritesSet],
  );
  const searchedLogicalItems = useMemo(() => {
    if (!isSearching) {
      return null;
    }
    const rankedMatches = logicalItems
      .map((item) => {
        const searchable = {
          name: item.displayName,
          driverKind: item.sources
            .map(
              (source) =>
                entryByInstanceId.get(source.instanceId as ProviderInstanceId)?.driverKind ?? "",
            )
            .join(" "),
          providerDisplayName: item.sources
            .map(
              (source) =>
                entryByInstanceId.get(source.instanceId as ProviderInstanceId)?.displayName ?? "",
            )
            .join(" "),
          isFavorite: isFavoriteLogicalItem(item),
        };
        return {
          item,
          score: scoreModelPickerSearch(searchable, searchQuery),
          isFavorite: searchable.isFavorite,
          tieBreaker: buildModelPickerSearchText(searchable),
        };
      })
      .filter(
        (
          ranked,
        ): ranked is {
          item: LogicalModelPickerItem;
          score: number;
          isFavorite: boolean;
          tieBreaker: string;
        } => ranked.score !== null,
      );
    return rankedMatches
      .toSorted((a, b) => {
        const scoreDelta = a.score - b.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        if (a.isFavorite !== b.isFavorite) {
          return a.isFavorite ? -1 : 1;
        }
        return a.tieBreaker.localeCompare(b.tieBreaker);
      })
      .map((ranked) => ranked.item);
  }, [entryByInstanceId, isFavoriteLogicalItem, isSearching, logicalItems, searchQuery]);
  const visibleLogicalItems = useMemo(() => {
    if (searchedLogicalItems !== null) {
      return searchedLogicalItems;
    }
    const base =
      selectedProviderKey === "favorites"
        ? logicalItems.filter((item) => isFavoriteLogicalItem(item))
        : logicalItems;
    return base
      .filter((item) => !item.isLegacy)
      .toSorted((a, b) => {
        const favoriteDelta = Number(isFavoriteLogicalItem(b)) - Number(isFavoriteLogicalItem(a));
        if (favoriteDelta !== 0) {
          return favoriteDelta;
        }
        return a.displayName.localeCompare(b.displayName);
      });
  }, [isFavoriteLogicalItem, logicalItems, searchedLogicalItems, selectedProviderKey]);
  const logicalLegacySection = useMemo(() => {
    if (isSearching) {
      return null;
    }
    const base =
      selectedProviderKey === "favorites"
        ? logicalItems.filter((item) => isFavoriteLogicalItem(item))
        : logicalItems;
    const legacyItems = base.filter((item) => item.isLegacy);
    if (legacyItems.length === 0) {
      return null;
    }
    return { key: LOGICAL_LEGACY_SECTION_KEY, items: legacyItems };
  }, [isFavoriteLogicalItem, isSearching, logicalItems, selectedProviderKey]);
  const modelFirstRows = useMemo((): ReadonlyArray<ModelFirstRow> => {
    const rows: ModelFirstRow[] = [];
    const pushItem = (item: LogicalModelPickerItem) => {
      rows.push({ kind: "logical", key: modelPickerLogicalModelKey(item.modelId), item });
      if (isLogicalModelExpanded(item)) {
        for (const source of item.sources) {
          rows.push({
            kind: "source",
            key: modelPickerModelKey(source.instanceId as ProviderInstanceId, source.model),
            item,
            source,
          });
        }
      }
    };
    for (const item of visibleLogicalItems) {
      pushItem(item);
    }
    if (logicalLegacySection) {
      // The header is a row so keys stay in render order even when expanded
      // models interleave their source rows.
      rows.push({
        kind: "legacy-header",
        key: logicalLegacySection.key,
        count: logicalLegacySection.items.length,
      });
      if (logicalLegacyExpanded) {
        for (const item of logicalLegacySection.items) {
          pushItem(item);
        }
      }
    }
    return rows;
  }, [isLogicalModelExpanded, logicalLegacyExpanded, logicalLegacySection, visibleLogicalItems]);
  const modelFirstRowByKey = useMemo(
    () => new Map(modelFirstRows.map((row) => [row.key, row] as const)),
    [modelFirstRows],
  );
  const logicalItemById = useMemo(
    () => new Map(logicalItems.map((item) => [item.modelId, item] as const)),
    [logicalItems],
  );
  // Highlight follows the current selection: the logical row when its
  // sub-pick is collapsed, the concrete pairing row when expanded.
  const modelFirstActiveKey = useMemo(() => {
    if (activeModelKey === null) {
      return null;
    }
    const activeItem = logicalItems.find((item) => item.isActive);
    if (!activeItem) {
      return activeModelKey;
    }
    return isLogicalModelExpanded(activeItem)
      ? activeModelKey
      : modelPickerLogicalModelKey(activeItem.modelId);
  }, [activeModelKey, isLogicalModelExpanded, logicalItems]);

  const isLocked = props.lockedProvider !== null;
  // Locked mode only surfaces provider buckets that still have a lock-visible
  // model — no disabled rows for other drivers. Unlocked keeps not-ready
  // buckets so their status tooltip stays reachable.
  const sidebarInstanceEntries = useMemo(() => {
    const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);
    if (!isLocked) {
      return enabledEntries;
    }
    return enabledEntries.filter((entry) => matchesLockedProvider(entry));
  }, [instanceEntries, isLocked, matchesLockedProvider]);
  const providerChoices = useMemo(() => {
    const choices = buildModelPickerProviderChoices({
      instanceEntries: sidebarInstanceEntries,
      modelOptionsByInstance,
      ...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {}),
      // Composer: instance rows narrow to the active harness (harness
      // selection lives in the standalone HarnessPicker) while
      // router-upstream rows stay global.
      ...(isModelFirst ? { activeInstanceId: props.activeInstanceId as string } : {}),
    });
    if (!isLocked) {
      return choices;
    }
    return choices.filter((choice) => choice.modelCount > 0 && !choice.disabled);
  }, [
    isLocked,
    isModelFirst,
    modelOptionsByInstance,
    props.activeInstanceId,
    selectableUnavailableInstanceIds,
    sidebarInstanceEntries,
  ]);
  // Provider list stays visible while browsing; search collapses it so the
  // model list gets the full width for results.
  const showFavorites = true;
  const showSidebar = !isSearching && (showFavorites || providerChoices.length > 0);
  const instanceOrder = useMemo(
    () => instanceEntries.map((entry) => entry.instanceId),
    [instanceEntries],
  );

  // Filter models based on search query and selected provider bucket.
  // Search is global (lock-scoped only); the provider filter applies while browsing.
  const filteredModels = useMemo(() => {
    let result = flatModels;

    // Apply tokenized fuzzy search across the combined provider/model search fields.
    if (searchQuery.trim()) {
      const rankedMatches = result
        .map((model) => ({
          model,
          score: scoreModelPickerSearch(
            {
              name: model.name,
              ...(model.shortName ? { shortName: model.shortName } : {}),
              ...(model.subProvider ? { subProvider: model.subProvider } : {}),
              driverKind: model.driverKind,
              providerDisplayName: model.instanceDisplayName,
              isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
            },
            searchQuery,
          ),
          isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
          tieBreaker: buildModelPickerSearchText({
            name: model.name,
            ...(model.shortName ? { shortName: model.shortName } : {}),
            ...(model.subProvider ? { subProvider: model.subProvider } : {}),
            driverKind: model.driverKind,
            providerDisplayName: model.instanceDisplayName,
          }),
        }))
        .filter(
          (
            rankedModel,
          ): rankedModel is {
            model: ModelPickerItem;
            score: number;
            isFavorite: boolean;
            tieBreaker: string;
          } => rankedModel.score !== null,
        );

      // When searching, only the thread lock narrows the pool — the sidebar
      // provider filter is browse-mode so account-scoped searches still find
      // a model before the user picks a bucket.
      if (props.lockedProvider !== null) {
        const lockedProviderMatches: Array<(typeof rankedMatches)[number]> = [];
        for (const rankedModel of rankedMatches) {
          if (matchesLockedProvider(rankedModel.model)) {
            lockedProviderMatches.push(rankedModel);
          }
        }
        return lockedProviderMatches
          .toSorted((a, b) => {
            const scoreDelta = a.score - b.score;
            if (scoreDelta !== 0) {
              return scoreDelta;
            }
            if (a.isFavorite !== b.isFavorite) {
              return a.isFavorite ? -1 : 1;
            }
            return a.tieBreaker.localeCompare(b.tieBreaker);
          })
          .map((rankedModel) => rankedModel.model);
      }

      return rankedMatches
        .toSorted((a, b) => {
          const scoreDelta = a.score - b.score;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }
          if (a.isFavorite !== b.isFavorite) {
            return a.isFavorite ? -1 : 1;
          }
          return a.tieBreaker.localeCompare(b.tieBreaker);
        })
        .map((rankedModel) => rankedModel.model);
    }

    if (props.lockedProvider !== null) {
      result = result.filter((m) => matchesLockedProvider(m));
    }
    if (selectedProviderKey === "favorites") {
      result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
    } else {
      // An instance scope covers everything the instance serves (native and
      // routed); an upstream scope only its bucket.
      result = result.filter(
        (m) =>
          m.providerKey === selectedProviderKey || (m.instanceId as string) === selectedProviderKey,
      );
    }

    return sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: selectedProviderKey !== "favorites",
      instanceOrder: instanceOrder,
    });
  }, [
    favoritesSet,
    flatModels,
    instanceOrder,
    matchesLockedProvider,
    props.lockedProvider,
    searchQuery,
    selectedProviderKey,
  ]);

  const legacySection = useMemo(() => {
    if (isSearching || selectedProviderKey === "favorites") {
      return null;
    }
    const currentModels = filteredModels.filter((model) => !model.isLegacy);
    const legacyModels = filteredModels.filter((model) => model.isLegacy);
    if (legacyModels.length === 0) {
      return null;
    }
    return {
      key: modelPickerLegacySectionKey(selectedProviderKey),
      currentModels,
      legacyModels,
      isExpanded: expandedLegacyScopeKeys.has(selectedProviderKey),
    };
  }, [expandedLegacyScopeKeys, filteredModels, isSearching, selectedProviderKey]);

  const visibleModels = useMemo(() => {
    if (!legacySection) {
      return filteredModels;
    }
    return [
      ...legacySection.currentModels,
      ...(legacySection.isExpanded ? legacySection.legacyModels : []),
    ];
  }, [filteredModels, legacySection]);

  const selectedProviderEntries =
    selectedProviderKey === "favorites"
      ? undefined
      : instanceEntries.filter(
          (entry) =>
            (entry.instanceId as string) === selectedProviderKey ||
            (modelOptionsByInstance.get(entry.instanceId) ?? []).some(
              (option) =>
                modelPickerOptionBucketKey(option, entry.instanceId as string) ===
                selectedProviderKey,
            ),
        );
  const providerSetupEntries =
    !isSearching && props.onOpenProviderSetup
      ? instanceEntries.filter(
          (entry) =>
            matchesLockedProvider(entry) &&
            // Model-first stays on the active harness: setup prompts for
            // inactive harnesses belong to the HarnessPicker/settings.
            (!isModelFirst || entry.instanceId === props.activeInstanceId) &&
            shouldOfferModelPickerSetup(
              entry,
              modelOptionsByInstance.get(entry.instanceId) ?? [],
            ) &&
            (isModelFirst
              ? modelFirstRows.length === 0
              : selectedProviderEntries
                ? selectedProviderEntries.some(
                    (selected) => selected.instanceId === entry.instanceId,
                  )
                : filteredModels.length === 0),
        )
      : [];

  const toggleLegacySection = useCallback((scopeKey: string) => {
    setExpandedLegacyScopeKeys((expanded) => {
      const next = new Set(expanded);
      if (next.has(scopeKey)) {
        next.delete(scopeKey);
      } else {
        next.add(scopeKey);
      }
      return next;
    });
  }, []);

  const handleModelSelect = useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId) => {
      if (getModelDisabledReason?.(instanceId, modelSlug)) {
        return;
      }
      const options = modelOptionsByInstance.get(instanceId);
      if (!options) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
      if (resolvedModel) {
        onInstanceModelChange(instanceId, resolvedModel);
      }
    },
    [entryByInstanceId, getModelDisabledReason, modelOptionsByInstance, onInstanceModelChange],
  );

  // A single-source logical model commits its one pairing directly; a
  // multi-source one expands to the instance sub-pick instead.
  const handleLogicalModelSelect = useCallback(
    (item: LogicalModelPickerItem) => {
      if (item.sources.length > 1) {
        toggleLogicalModelExpanded(item.modelId);
        return;
      }
      const source = item.sources[0];
      if (!source) {
        return;
      }
      const instanceId = source.instanceId as ProviderInstanceId;
      if (getModelDisabledReason?.(instanceId, source.model)) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      const options = modelOptionsByInstance.get(instanceId);
      if (!entry || !options) {
        return;
      }
      // Same normalization as the per-instance rows: driver-kind scoped slug
      // resolution against the instance's own option list.
      const resolvedModel = resolveSelectableModel(entry.driverKind, source.model, options);
      if (resolvedModel) {
        onInstanceModelChange(instanceId, resolvedModel);
      }
    },
    [
      entryByInstanceId,
      getModelDisabledReason,
      modelOptionsByInstance,
      onInstanceModelChange,
      toggleLogicalModelExpanded,
    ],
  );

  const toggleFavorite = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const newFavorites = [...favorites];
      const index = newFavorites.findIndex((f) => f.provider === instanceId && f.model === model);
      if (index >= 0) {
        newFavorites.splice(index, 1);
      } else {
        newFavorites.push({ provider: instanceId, model });
      }
      updateSettings({ favorites: newFavorites });
    },
    [favorites, updateSettings],
  );

  const toggleFavoriteLogical = useCallback(
    (item: LogicalModelPickerItem) => {
      updateSettings({ favorites: toggleLogicalModelFavorite(favorites, item) });
    },
    [favorites, updateSettings],
  );

  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    let selectableModelIndex = 0;
    if (isModelFirst) {
      // Jump targets are the logical rows: single-source ones commit,
      // multi-source ones expand to their sub-pick.
      for (const row of modelFirstRows) {
        if (row.kind !== "logical") {
          continue;
        }
        const singleSource = row.item.sources.length === 1 ? row.item.sources[0] : undefined;
        if (
          singleSource &&
          getModelDisabledReason?.(
            singleSource.instanceId as ProviderInstanceId,
            singleSource.model,
          )
        ) {
          continue;
        }
        const jumpCommand = modelPickerJumpCommandForIndex(selectableModelIndex);
        if (!jumpCommand) {
          return mapping;
        }
        mapping.set(row.key, jumpCommand);
        selectableModelIndex += 1;
      }
      return mapping;
    }
    for (const model of visibleModels) {
      if (getModelDisabledReason?.(model.instanceId, model.slug)) {
        continue;
      }
      const jumpCommand = modelPickerJumpCommandForIndex(selectableModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(modelPickerModelKey(model.instanceId, model.slug), jumpCommand);
      selectableModelIndex += 1;
    }
    return mapping;
  }, [getModelDisabledReason, isModelFirst, modelFirstRows, visibleModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const allItemKeys = useMemo((): string[] => {
    if (isModelFirst) {
      return [
        ...logicalItems.flatMap((item) => [
          modelPickerLogicalModelKey(item.modelId),
          ...item.sources.map((source) =>
            modelPickerModelKey(source.instanceId as ProviderInstanceId, source.model),
          ),
        ]),
        ...(logicalLegacySection ? [logicalLegacySection.key] : []),
      ];
    }
    return [
      ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
      ...new Set(
        flatModels
          .filter((model) => model.isLegacy)
          .map((model) => modelPickerLegacySectionKey(model.providerKey)),
      ),
    ];
  }, [flatModels, isModelFirst, logicalItems, logicalLegacySection]);
  const filteredItemKeys = useMemo((): string[] => {
    if (isModelFirst) {
      return modelFirstRows.map((row) => row.key);
    }
    const modelKeys = visibleModels.map((model) =>
      modelPickerModelKey(model.instanceId, model.slug),
    );
    if (!legacySection) {
      return modelKeys;
    }
    modelKeys.splice(legacySection.currentModels.length, 0, legacySection.key);
    return modelKeys;
  }, [isModelFirst, legacySection, modelFirstRows, visibleModels]);
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(
        visibleModels.map(
          (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
        ),
      ),
    [visibleModels],
  );
  const updateModelListScrollFades = useCallback(() => {
    const scrollElement = modelListRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);
  const modelListExtraData = useMemo(
    () => ({ favoritesSet, modelJumpLabelByKey, logicalExpansionOverrides, logicalLegacyExpanded }),
    [favoritesSet, logicalExpansionOverrides, logicalLegacyExpanded, modelJumpLabelByKey],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
        event.preventDefault();
        event.stopPropagation();
        const next = adjacentModelPickerProvider({
          providerKeys: providerChoices
            .filter((choice) => !choice.disabled)
            .map((choice) => choice.key),
          selectedKey: selectedProviderKey,
          direction: command === "modelPicker.nextProvider" ? 1 : -1,
        });
        setSearchQuery("");
        handleSelectProviderKey(next);
        return;
      }
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      if (isModelFirst) {
        const logicalModelId = parseModelPickerLogicalModelKey(targetModelKey);
        const item = logicalModelId !== null ? logicalItemById.get(logicalModelId) : undefined;
        if (item) {
          handleLogicalModelSelect(item);
        }
        return;
      }
      const model = parseModelPickerModelKey(targetModelKey);
      if (!model) {
        return;
      }
      handleModelSelect(model.slug, model.instanceId);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [
    handleLogicalModelSelect,
    handleModelSelect,
    handleSelectProviderKey,
    isModelFirst,
    keybindings,
    logicalItemById,
    modelJumpModelKeys,
    modelJumpShortcutContext,
    providerChoices,
    selectedProviderKey,
  ]);

  useLayoutEffect(() => {
    setShowTopScrollFade(false);
    setShowBottomScrollFade(filteredItemKeys.length > 5);
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      updateModelListScrollFades();
      nestedFrame = window.requestAnimationFrame(updateModelListScrollFades);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [filteredItemKeys, updateModelListScrollFades]);

  return (
    <TooltipProvider delay={0}>
      <div
        className="relative flex h-screen max-h-86.5 w-screen max-w-140 flex-row overflow-hidden"
        data-model-picker-content="true"
      >
        {/* Sidebar */}
        {showSidebar && (
          <ModelPickerSidebar
            selectedKey={selectedProviderKey}
            onSelectKey={handleSelectProviderKey}
            onFocusSearch={focusSearchInput}
            choices={providerChoices}
            showFavorites={showFavorites}
          />
        )}

        {/* Main content area */}
        <Combobox
          inline
          items={allItemKeys}
          filteredItems={filteredItemKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          value={isModelFirst ? modelFirstActiveKey : activeModelKey}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(modelKey) => {
            if (typeof modelKey !== "string") {
              return;
            }
            if (isModelFirst) {
              if (modelKey === LOGICAL_LEGACY_SECTION_KEY) {
                setLogicalLegacyExpanded((expanded) => !expanded);
                return;
              }
              const logicalModelId = parseModelPickerLogicalModelKey(modelKey);
              if (logicalModelId !== null) {
                const item = logicalItemById.get(logicalModelId);
                if (item) {
                  handleLogicalModelSelect(item);
                }
                return;
              }
            }
            const legacyScopeKey = parseModelPickerLegacySectionKey(modelKey);
            if (legacyScopeKey) {
              toggleLegacySection(legacyScopeKey);
              return;
            }
            const model = parseModelPickerModelKey(modelKey);
            if (model) {
              handleModelSelect(model.slug, model.instanceId);
            }
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              showSidebar && "border-l border-border/70",
            )}
          >
            {/* Search bar */}
            <div className="px-2 pt-2">
              <div className="border-b border-border/70 pb-2.5 transition-colors focus-within:border-ring">
                <ComboboxInput
                  ref={searchInputRef}
                  className="[&_input]:h-6.5 [&_input]:font-sans [&_input]:leading-6.5"
                  inputClassName="rounded-none bg-transparent text-sm"
                  placeholder="Search models..."
                  showTrigger={false}
                  startAddon={
                    <SearchIcon className="-translate-x-0.5 size-4 shrink-0 text-muted-foreground opacity-70" />
                  }
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      showSidebar &&
                      !e.altKey &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      ((e.key === "ArrowLeft" && !e.shiftKey && searchQuery.length === 0) ||
                        (e.key === "Tab" && e.shiftKey))
                    ) {
                      const sidebar = e.currentTarget
                        .closest("[data-model-picker-content]")
                        ?.querySelector("[data-model-picker-sidebar]");
                      const button =
                        sidebar?.querySelector<HTMLButtonElement>(
                          'button[aria-pressed="true"]:not(:disabled)',
                        ) ?? sidebar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                      if (button) {
                        e.preventDefault();
                        e.stopPropagation();
                        button.focus();
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      props.onRequestClose?.();
                      return;
                    }
                    if (e.key === "Enter" && highlightedModelKeyRef.current) {
                      (
                        e as typeof e & { preventBaseUIHandler?: () => void }
                      ).preventBaseUIHandler?.();
                      e.preventDefault();
                      e.stopPropagation();
                      if (isModelFirst) {
                        if (highlightedModelKeyRef.current === LOGICAL_LEGACY_SECTION_KEY) {
                          setLogicalLegacyExpanded((expanded) => !expanded);
                          return;
                        }
                        const logicalModelId = parseModelPickerLogicalModelKey(
                          highlightedModelKeyRef.current,
                        );
                        if (logicalModelId !== null) {
                          const item = logicalItemById.get(logicalModelId);
                          if (item) {
                            handleLogicalModelSelect(item);
                          }
                          return;
                        }
                      }
                      const legacyScopeKey = parseModelPickerLegacySectionKey(
                        highlightedModelKeyRef.current,
                      );
                      if (legacyScopeKey) {
                        toggleLegacySection(legacyScopeKey);
                        return;
                      }
                      const model = parseModelPickerModelKey(highlightedModelKeyRef.current);
                      if (model) {
                        handleModelSelect(model.slug, model.instanceId);
                      }
                      return;
                    }
                    e.stopPropagation();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  size="sm"
                  unstyled
                />
              </div>
            </div>

            {/* Model list */}
            <div className="relative min-h-0 flex-1 overflow-hidden pr-px">
              <ComboboxListVirtualized className="size-full min-w-0 p-0 not-empty:p-0">
                <LegendList<string>
                  ref={modelListRef}
                  data={filteredItemKeys}
                  extraData={modelListExtraData}
                  keyExtractor={(modelKey) => modelKey}
                  renderItem={({ item: modelKey, index }) => {
                    if (isModelFirst) {
                      const modelFirstRow = modelFirstRowByKey.get(modelKey);
                      if (modelFirstRow?.kind === "legacy-header") {
                        return (
                          <ComboboxItem
                            hideIndicator
                            index={index}
                            value={modelKey}
                            aria-expanded={logicalLegacyExpanded}
                            className="group w-full cursor-pointer rounded-md px-2 py-2"
                            contentClassName="flex w-full items-center gap-3"
                          >
                            <div className="min-w-0 flex-1 text-left">
                              <div className="text-xs font-medium leading-snug">Legacy models</div>
                              <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">
                                {modelFirstRow.count} models
                              </div>
                            </div>
                            <ChevronRightIcon
                              className={cn(
                                "size-4 transition-transform",
                                logicalLegacyExpanded && "rotate-90",
                              )}
                            />
                          </ComboboxItem>
                        );
                      }
                      if (!modelFirstRow) {
                        return null;
                      }
                      if (modelFirstRow.kind === "logical") {
                        const singleSourceEntry =
                          modelFirstRow.item.sources.length === 1
                            ? entryByInstanceId.get(
                                modelFirstRow.item.sources[0]!.instanceId as ProviderInstanceId,
                              )
                            : undefined;
                        return (
                          <LogicalModelRow
                            index={index}
                            item={modelFirstRow.item}
                            expanded={isLogicalModelExpanded(modelFirstRow.item)}
                            singleSourceEntry={singleSourceEntry}
                            jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                            isFavorite={isFavoriteLogicalItem(modelFirstRow.item)}
                            onToggleFavorite={() => toggleFavoriteLogical(modelFirstRow.item)}
                          />
                        );
                      }
                      const sourceEntry = entryByInstanceId.get(
                        modelFirstRow.source.instanceId as ProviderInstanceId,
                      );
                      if (!sourceEntry) {
                        return null;
                      }
                      const sourceOption = modelOptionsByInstance
                        .get(sourceEntry.instanceId)
                        ?.find((candidate) => candidate.slug === modelFirstRow.source.model);
                      return (
                        <ModelListRow
                          key={modelKey}
                          index={index}
                          model={
                            sourceOption ?? {
                              slug: modelFirstRow.source.model,
                              name: modelFirstRow.source.name ?? modelFirstRow.source.model,
                            }
                          }
                          instanceId={sourceEntry.instanceId}
                          driverKind={sourceEntry.driverKind}
                          providerDisplayName={sourceEntry.displayName}
                          providerAccentColor={sourceEntry.accentColor}
                          isFavorite={favoritesSet.has(
                            providerModelKey(sourceEntry.instanceId, modelFirstRow.source.model),
                          )}
                          isSelected={modelKey === modelFirstActiveKey}
                          showProvider
                          preferShortName={!isLocked}
                          useTriggerLabel={false}
                          showNewBadge={sourceOption?.badge === "new"}
                          unavailable={sourceOption?.isUnavailable === true}
                          viaProxy={sourceOption?.viaProxy === true}
                          capabilitiesDegraded={sourceOption?.capabilitiesDegraded === true}
                          subscription={modelFirstRow.source.authMode === "subscription"}
                          jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                          disabledReason={
                            getModelDisabledReason?.(
                              sourceEntry.instanceId,
                              modelFirstRow.source.model,
                            ) ?? null
                          }
                          onToggleFavorite={() =>
                            toggleFavorite(sourceEntry.instanceId, modelFirstRow.source.model)
                          }
                        />
                      );
                    }
                    if (legacySection?.key === modelKey) {
                      return (
                        <ComboboxItem
                          hideIndicator
                          index={index}
                          value={modelKey}
                          aria-expanded={legacySection.isExpanded}
                          className="group w-full cursor-pointer rounded-md px-2 py-2"
                          contentClassName="flex w-full items-center gap-3"
                        >
                          <div className="min-w-0 flex-1 text-left">
                            <div className="text-xs font-medium leading-snug">Legacy models</div>
                            <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">
                              {legacySection.legacyModels.length} models
                            </div>
                          </div>
                          <ChevronRightIcon
                            className={cn(
                              "size-4 transition-transform",
                              legacySection.isExpanded && "rotate-90",
                            )}
                          />
                        </ComboboxItem>
                      );
                    }
                    const model = filteredModelByKey.get(modelKey);
                    if (!model) {
                      return null;
                    }
                    const disabledReason =
                      getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                    return (
                      <ModelListRow
                        key={modelKey}
                        index={index}
                        model={model}
                        instanceId={model.instanceId}
                        driverKind={model.driverKind}
                        providerDisplayName={model.instanceDisplayName}
                        providerAccentColor={model.instanceAccentColor}
                        isFavorite={favoritesSet.has(
                          providerModelKey(model.instanceId, model.slug),
                        )}
                        isSelected={modelKey === activeModelKey}
                        showProvider
                        preferShortName={!isLocked}
                        useTriggerLabel={false}
                        showNewBadge={model.badge === "new"}
                        unavailable={model.isUnavailable === true}
                        viaProxy={model.viaProxy === true}
                        capabilitiesDegraded={model.capabilitiesDegraded === true}
                        jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                        disabledReason={disabledReason}
                        onToggleFavorite={() => toggleFavorite(model.instanceId, model.slug)}
                      />
                    );
                  }}
                  estimatedItemSize={52}
                  drawDistance={480}
                  recycleItems
                  contentContainerClassName="pl-2 pr-px"
                  ItemSeparatorComponent={ModelListSeparator}
                  onLayout={updateModelListScrollFades}
                  onScroll={updateModelListScrollFades}
                  className={cn(
                    "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
                    getVirtualizedScrollFadeClassName({
                      top: showTopScrollFade,
                      bottom: showBottomScrollFade,
                    }),
                  )}
                />
              </ComboboxListVirtualized>
            </div>
            {providerSetupEntries.length > 0 ? (
              <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
                {providerSetupEntries.map((entry) => (
                  <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
                    <p className="line-clamp-3 text-muted-foreground">
                      {getProviderStatusMessage(entry.snapshot)}
                    </p>
                    <Button
                      className="mt-1 px-0 text-foreground"
                      onClick={() => {
                        props.onRequestClose?.();
                        props.onOpenProviderSetup?.(entry.instanceId);
                      }}
                      size="xs"
                      variant="link"
                    >
                      {providerSetupEntries.length > 1
                        ? `Set up ${entry.displayName}`
                        : "Open provider setup"}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
                No models found
              </ComboboxEmpty>
            )}
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
