import type {
  EnvironmentId,
  FallbackCombo,
  FallbackStrategy,
  ModelSelection,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
} from "@t3tools/contracts";
import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { HeaderHeightContext } from "@react-navigation/elements";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import {
  addComboTarget,
  comboModeForThread,
  MAX_FALLBACK_COMBO_TARGETS,
  removeComboTarget,
  setComboStrategy,
} from "@t3tools/client-runtime/state/fallback-combo";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Alert, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import type { ModelGroup, ModelOption } from "../../lib/modelOptions";
import { applyProviderOptionSelection } from "../../lib/providerOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  NativeHeaderToolbar,
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../native/StackHeader";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  createProviderCatalogRefreshRunner,
  providerCatalogRefreshError,
} from "./provider-catalog-refresh";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { RUNTIME_MODE_CHOICES, selectableChoices } from "./thread-settings-options";
import {
  canCommitPendingModel,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
  providerSectionIsCollapsed,
  resolveComboTargetDisplay,
} from "./thread-settings-sheet-state";

/**
 * Everyday harnesses start expanded; every other provider (OpenRouter catalogs
 * and friends) starts folded so a 300-model catalog cannot bury the list. All
 * provider headers remain user-collapsible.
 */
const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "droid",
  "hermes",
  "cline",
  "antigravity",
  "pi",
]);
/**
 * Keep measured row changes stable, but let catalog mutations use the list's
 * native bounds so a filtered catalog that underflows returns to the top.
 */
const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);
const THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_OPTION_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_OPTION_EXIT_TRANSITION = FadeOut.duration(100);
const THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(
  Platform.OS,
  Platform.Version,
);
function ModelRow(props: {
  readonly option: ModelOption;
  /**
   * The pairing's provider label, shown when the surrounding model-first
   * group pools several of them — rows would otherwise be indistinguishable.
   */
  readonly providerLabel?: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const { materialYouStyleLayoutActive } = useAppearancePreferences();
  const selectedMaterialRow = materialYouStyleLayoutActive && props.selected;
  const proxyHint = props.option.viaProxy
    ? `via provider${props.option.backendLabel ? `, ${props.option.backendLabel}` : ""}`
    : null;
  return (
    <Pressable
      accessibilityLabel={[props.option.label, props.option.subtitle, proxyHint]
        .filter(Boolean)
        .join(", ")}
      accessibilityRole="radio"
      accessibilityState={{
        checked: props.selected,
        disabled: props.option.isUnavailable === true,
      }}
      disabled={props.option.isUnavailable}
      onPress={props.onPress}
      className={cn(
        "mx-4 min-h-11 flex-row items-center gap-2 bg-card px-4 py-2 active:bg-subtle",
        selectedMaterialRow && "bg-thread-selected",
        props.isFirst && "rounded-t-2xl",
        props.isLast ? "rounded-b-2xl" : "border-b border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text
            className="min-w-0 shrink text-base font-t3-medium text-foreground"
            numberOfLines={1}
          >
            {props.option.label}
          </Text>
          {props.option.isDefault ? (
            <View className="rounded-md bg-subtle-strong px-1.5 py-0.5">
              <Text className="text-3xs font-t3-bold text-foreground-muted">Default</Text>
            </View>
          ) : null}
          {props.option.isLegacy ? (
            <View className="rounded-md bg-subtle px-1.5 py-0.5">
              <Text className="text-3xs font-t3-bold text-foreground-muted">Legacy</Text>
            </View>
          ) : null}
          {props.option.viaProxy ? (
            <View className="rounded-md bg-subtle px-1.5 py-0.5">
              <Text className="text-3xs font-t3-bold text-foreground-muted">via provider</Text>
            </View>
          ) : null}
          {props.providerLabel ? (
            <View className="rounded-md bg-subtle px-1.5 py-0.5">
              <Text className="text-3xs font-t3-bold text-foreground-muted" numberOfLines={1}>
                {props.providerLabel}
              </Text>
            </View>
          ) : null}
          {props.option.isUnavailable ? (
            <Text className="text-xs text-foreground">Unavailable</Text>
          ) : null}
        </View>
        {props.option.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.option.subtitle}
          </Text>
        ) : null}
        {props.option.viaProxy && props.option.capabilitiesDegraded ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            Capabilities degraded
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColorClassName={"accent-icon"}
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

/**
 * Model-first group header: the pooled logical model's name, with the count
 * of concrete pairings while collapsed. Rows beneath it are the pairings.
 */
function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const content = (
    <>
      <ProviderIcon provider={props.driver} size={15} />
      <Text
        className="min-w-0 shrink text-sm font-t3-medium text-foreground-muted"
        numberOfLines={1}
      >
        {props.label}
      </Text>
      {props.collapsible ? (
        <>
          <View className="flex-1" />
          {props.collapsed ? (
            <Text className="text-2xs font-t3-medium text-foreground-muted">
              {props.modelCount}
            </Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={12}
            tintColorClassName={"accent-icon-subtle"}
            type="monochrome"
          />
        </>
      ) : null}
    </>
  );

  if (props.collapsible) {
    return (
      <Pressable
        accessibilityLabel={`${props.label}, ${props.modelCount} models`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-1 min-h-11 flex-row items-center gap-2 rounded-xl px-1 pt-2 active:opacity-60"
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View accessibilityRole="header" className="mx-4 min-h-9 flex-row items-center gap-2 px-1 pt-1">
      {content}
    </View>
  );
}

/** Compact row that opens a single-choice submenu panel. */
function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onPress: () => void;
  readonly isLast?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "min-h-11 flex-row items-center gap-2 bg-card px-4 py-2 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName={"accent-icon-subtle"}
        type="monochrome"
      />
    </Pressable>
  );
}

/** Single option inside a submenu panel. */
function ChoiceRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly isLast: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={props.description ? `${props.label}. ${props.description}` : props.label}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      onPress={props.onPress}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
        {props.description ? (
          <Text className="text-sm leading-5 text-foreground-muted">{props.description}</Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColorClassName={"accent-icon"}
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly isLast?: boolean;
}) {
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center justify-between bg-card px-4 py-1",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <ThemedSwitch
        accessibilityLabel={props.label}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" }
  | { readonly kind: "combo-strategy" };

const COMBO_STRATEGY_CHOICES: ReadonlyArray<{
  readonly value: FallbackStrategy;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "priority",
    label: "Priority",
    description: "Try targets in order, top first.",
  },
  {
    value: "headroom",
    label: "Headroom",
    description: "Prefer the target with the most remaining quota.",
  },
  {
    value: "lkgp",
    label: "Last known good",
    description: "Stick with the last target that worked.",
  },
];

function comboStrategyLabel(strategy: FallbackStrategy): string {
  return COMBO_STRATEGY_CHOICES.find((choice) => choice.value === strategy)?.label ?? strategy;
}

type ThreadSettingsSessionProps = {
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ModelGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly onSelectModel: (option: ModelOption) => void;
  /**
   * The thread's fallback combo. Absent (no `onSelectCombo`) means the host
   * cannot persist one — new-task drafts hide the combo section, only
   * server-backed threads offer it.
   */
  readonly combo?: FallbackCombo | null;
  readonly onSelectCombo?: (combo: FallbackCombo | null) => void;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
};

export type ExistingThreadSettingsRouteSession = ThreadSettingsSessionProps & {
  readonly ownerId: string;
};

type ExistingThreadSettingsRouteContextValue = {
  readonly session: ExistingThreadSettingsRouteSession | null;
  readonly present: (session: ExistingThreadSettingsRouteSession) => void;
  readonly clear: (ownerId: string) => void;
};

const ExistingThreadSettingsRouteContext =
  createContext<ExistingThreadSettingsRouteContextValue | null>(null);

/** Bridges the active thread's settings state into the root native sheet route. */
export function ExistingThreadSettingsRouteProvider(props: { readonly children: ReactNode }) {
  const [session, setSession] = useState<ExistingThreadSettingsRouteSession | null>(null);
  const present = useCallback((nextSession: ExistingThreadSettingsRouteSession) => {
    setSession(nextSession);
  }, []);
  const clear = useCallback((ownerId: string) => {
    setSession((current) => (current?.ownerId === ownerId ? null : current));
  }, []);
  const value = useMemo(() => ({ session, present, clear }), [clear, present, session]);

  return (
    <ExistingThreadSettingsRouteContext.Provider value={value}>
      {props.children}
    </ExistingThreadSettingsRouteContext.Provider>
  );
}

export function useExistingThreadSettingsRoutePresentation() {
  const value = use(ExistingThreadSettingsRouteContext);
  if (!value) {
    throw new Error(
      "useExistingThreadSettingsRoutePresentation must be used inside ExistingThreadSettingsRouteProvider.",
    );
  }
  return value;
}

type ThreadSettingsSessionValue = {
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ModelGroup>;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly pendingModel: ModelOption | null;
  /** Staged fallback combo; committed together with the model on Save. */
  readonly pendingCombo: FallbackCombo | null;
  /** False for hosts without a thread to persist the combo on (drafts). */
  readonly comboSupported: boolean;
  readonly hasPendingChanges: boolean;
  readonly providerFilter: string | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
  readonly applyOptionChange: (id: string, value: string | boolean) => void;
  readonly commitPendingModel: () => boolean;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly pressModel: (option: ModelOption) => void;
  readonly setComboEnabled: (enabled: boolean) => void;
  readonly removeComboTargetAt: (index: number) => void;
  readonly updateComboStrategy: (strategy: FallbackStrategy) => void;
  readonly clearCombo: () => void;
  readonly setProviderFilter: (providerKey: string | null) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setShowLegacy: (showLegacy: boolean) => void;
  readonly toggleProvider: (providerKey: string) => void;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

/** Owns the staged model and option state for one picker presentation. */
function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  // Combo edits stage exactly like the model: taps mutate `pendingCombo`,
  // Save commits it through `onSelectCombo`. No parallel save path.
  // `initialCombo` is render state (not a ref) so the dirty check below
  // never reads a ref during render.
  const comboSupported = props.onSelectCombo !== undefined;
  const [initialCombo] = useState<FallbackCombo | null>(() => props.combo ?? null);
  const [pendingCombo, setPendingCombo] = useState<FallbackCombo | null>(() => props.combo ?? null);
  const hasPendingComboChanges = comboSupported && pendingCombo !== initialCombo;

  const isApplied = useCallback(
    (option: ModelOption) =>
      option.selection.instanceId === props.selectedModel?.instanceId &&
      option.selection.model === props.selectedModel.model,
    [props.selectedModel],
  );
  // The list highlights the staged pick; Save turns it into the applied one.
  const isDisplayed = useCallback(
    (option: ModelOption) => (pendingModel ? option.key === pendingModel.key : isApplied(option)),
    [isApplied, pendingModel],
  );

  // While a model is staged, the settings rows describe and edit the staged
  // model's options (kept on its pending selection); Save applies model and
  // options together. Otherwise they edit the applied selection directly.
  const displayedDescriptors = useMemo(
    () =>
      pendingModel
        ? pendingModel.capabilities
          ? getProviderOptionDescriptors({
              caps: pendingModel.capabilities,
              selections: pendingModel.selection.options,
            })
          : []
        : props.optionDescriptors,
    [pendingModel, props.optionDescriptors],
  );

  const hasLegacyModels = useMemo(
    () => props.providerGroups.some((group) => group.models.some((model) => model.isLegacy)),
    [props.providerGroups],
  );
  const commitPendingModel = useCallback(() => {
    if (pendingModel) {
      if (!canCommitPendingModel(pendingModel, props.providerGroups)) {
        Alert.alert(
          "Model unavailable",
          "Set up this provider on web or desktop, or select another model.",
        );
        return false;
      }
      void Haptics.selectionAsync();
      props.onSelectModel(pendingModel);
    }
    if (hasPendingComboChanges) {
      props.onSelectCombo?.(pendingCombo);
    }
    return true;
  }, [
    hasPendingComboChanges,
    pendingCombo,
    pendingModel,
    props.onSelectCombo,
    props.onSelectModel,
    props.providerGroups,
  ]);

  const applyOptionChange = useCallback(
    (id: string, value: string | boolean) => {
      const next = applyProviderOptionSelection(displayedDescriptors, { id, value });
      if (!next) {
        return;
      }
      if (pendingModel) {
        setPendingModel({
          ...pendingModel,
          selection: { ...pendingModel.selection, options: next },
        });
      } else {
        props.onUpdateOptionSelections(next);
      }
    },
    [displayedDescriptors, pendingModel, props.onUpdateOptionSelections],
  );

  const toggleProvider = useCallback((providerKey: string) => {
    setProviderExpansionOverrides((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  }, []);

  const pressModel = useCallback(
    (option: ModelOption) => {
      void Haptics.selectionAsync();
      // In combo mode the catalog is the target picker: tapping adds the
      // model as a fallback target instead of staging a single selection.
      if (comboSupported && comboModeForThread(pendingCombo) === "combo") {
        setPendingCombo((current) => addComboTarget(current, option.selection) ?? current);
        return;
      }
      setPendingModel((current) =>
        pendingModelAfterPress({
          current,
          pressed: option,
          pressedIsApplied: isApplied(option),
        }),
      );
    },
    [comboSupported, isApplied, pendingCombo],
  );

  const setComboEnabled = useCallback(
    (enabled: boolean) => {
      void Haptics.selectionAsync();
      if (!enabled) {
        setPendingCombo(null);
        return;
      }
      const seed = pendingModel?.selection ?? props.selectedModel;
      if (!seed) {
        return;
      }
      setPendingCombo((current) => addComboTarget(current, seed) ?? current);
    },
    [pendingModel, props.selectedModel],
  );

  const removeComboTargetAt = useCallback((index: number) => {
    void Haptics.selectionAsync();
    setPendingCombo((current) => {
      const next = removeComboTarget(current, index);
      // `undefined` leaves the combo untouched (out-of-range tap);
      // `null` collapses back to single when one target remains.
      return next === undefined ? current : next;
    });
  }, []);

  const updateComboStrategy = useCallback((strategy: FallbackStrategy) => {
    void Haptics.selectionAsync();
    setPendingCombo((current) => setComboStrategy(current, strategy));
  }, []);

  const clearCombo = useCallback(() => {
    void Haptics.selectionAsync();
    setPendingCombo(null);
  }, []);

  const value = useMemo<ThreadSettingsSessionValue>(
    () => ({
      environmentId: props.environmentId,
      providerInstanceId: props.providerInstanceId,
      providerGroups: props.providerGroups,
      runtimeMode: props.runtimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
      displayedDescriptors,
      providerExpansionOverrides,
      hasLegacyModels,
      pendingModel,
      pendingCombo,
      comboSupported,
      hasPendingChanges: pendingModel !== null || hasPendingComboChanges,
      providerFilter,
      searchQuery,
      showLegacy: showLegacyToggle,
      applyOptionChange,
      commitPendingModel,
      isApplied,
      isDisplayed,
      pressModel,
      setComboEnabled,
      removeComboTargetAt,
      updateComboStrategy,
      clearCombo,
      setProviderFilter,
      setSearchQuery,
      setShowLegacy: setShowLegacyToggle,
      toggleProvider,
    }),
    [
      applyOptionChange,
      clearCombo,
      comboSupported,
      commitPendingModel,
      displayedDescriptors,
      providerExpansionOverrides,
      hasLegacyModels,
      hasPendingComboChanges,
      isApplied,
      isDisplayed,
      props.environmentId,
      props.providerInstanceId,
      pendingCombo,
      pendingModel,
      pressModel,
      setComboEnabled,
      removeComboTargetAt,
      updateComboStrategy,
      providerFilter,
      props.onUpdateRuntimeMode,
      props.providerGroups,
      props.runtimeMode,
      searchQuery,
      showLegacyToggle,
      toggleProvider,
    ],
  );

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);
  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }
  return value;
}

/**
 * One model-first group in the picker: a pooled logical model and its
 * concrete pairings. `driver` comes from the first pairing so the header
 * keeps a recognizable glyph.
 */
type ThreadSettingsProviderCatalog = {
  readonly key: string;
  readonly driver: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly models: ReadonlyArray<ModelOption>;
};

type ThreadSettingsCatalogItem =
  | {
      readonly kind: "combo";
      readonly key: "combo";
    }
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly provider: ThreadSettingsProviderCatalog;
    }
  | {
      readonly kind: "model";
      readonly key: string;
      readonly option: ModelOption;
      /** Set when the group pools several pairings and rows need their provider. */
      readonly providerLabel?: string;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    }
  | {
      readonly kind: "empty";
      readonly key: "empty";
    }
  | {
      readonly kind: "options";
      readonly key: "options";
    };

function ThreadSettingsModelListRow(props: {
  readonly option: ModelOption;
  readonly providerLabel?: string;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const session = useThreadSettingsSession();
  const onPress = useCallback(
    () => session.pressModel(props.option),
    [props.option, session.pressModel],
  );

  return (
    <ModelRow
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={onPress}
      option={props.option}
      providerLabel={props.providerLabel}
      selected={session.isDisplayed(props.option)}
    />
  );
}

function ThreadSettingsProviderListHeader(props: {
  readonly provider: ThreadSettingsProviderCatalog;
}) {
  const session = useThreadSettingsSession();
  const onToggle = useCallback(
    () => session.toggleProvider(props.provider.key),
    [props.provider.key, session.toggleProvider],
  );

  return (
    <ProviderHeader
      collapsible={props.provider.collapsible}
      collapsed={props.provider.collapsed}
      driver={props.provider.driver}
      label={props.provider.label}
      modelCount={props.provider.modelCount}
      onToggle={onToggle}
    />
  );
}

function useThreadSettingsCatalogItems(
  session: ThreadSettingsSessionValue,
): ReadonlyArray<ThreadSettingsCatalogItem> {
  return useMemo(
    () =>
      session.providerGroups.flatMap((group) => {
        // The provider filter narrows pooled groups to those the chosen
        // provider instance can actually serve.
        if (
          session.providerFilter !== null &&
          !group.models.some((model) => model.providerKey === session.providerFilter)
        ) {
          return [];
        }
        const driver = group.models[0]?.providerDriver ?? group.key;
        const catalogModels = session.showLegacy
          ? group.models
          : group.models.filter((model) => !model.isLegacy || session.isDisplayed(model));
        const visibleModels = catalogModels.filter((model) =>
          modelMatchesCatalogQuery({
            model,
            groupLabel: group.label,
            query: session.searchQuery,
          }),
        );
        if (visibleModels.length === 0) {
          return [];
        }
        const isPrimary = driver !== undefined && PRIMARY_PROVIDER_DRIVERS.has(driver);
        // Staging a model must not change disclosure state. The applied model
        // stays stable for the lifetime of this picker (Save closes it), so it
        // is safe to use as the initial selected-provider default.
        const containsAppliedSelection = group.models.some(session.isApplied);
        const isNarrowed = session.providerFilter !== null || session.searchQuery.trim().length > 0;
        const collapsible = !isNarrowed;
        const collapsed = providerSectionIsCollapsed({
          defaultExpanded: isPrimary || containsAppliedSelection,
          hasExpansionOverride: session.providerExpansionOverrides.has(group.key),
          isNarrowed,
        });
        const provider: ThreadSettingsProviderCatalog = {
          key: group.key,
          driver,
          label: group.label,
          collapsible,
          collapsed,
          modelCount: visibleModels.length,
          models: collapsed ? [] : visibleModels,
        };
        // A pooled group's rows need their provider to be distinguishable;
        // a single-pairing group already says everything through the header.
        const showProvider = group.models.length > 1;
        return [
          {
            kind: "provider" as const,
            key: `provider:${group.key}`,
            provider,
          },
          ...provider.models.map((option, index) => ({
            kind: "model" as const,
            key: `model:${option.key}`,
            option,
            ...(showProvider ? { providerLabel: option.providerLabel } : {}),
            isFirst: index === 0,
            isLast: index === provider.models.length - 1,
          })),
        ];
      }),
    [
      session.isApplied,
      session.isDisplayed,
      session.providerExpansionOverrides,
      session.providerFilter,
      session.providerGroups,
      session.searchQuery,
      session.showLegacy,
    ],
  );
}

/**
 * Thread-level turn fallback: single model vs. an ordered combo of up to
 * `MAX_FALLBACK_COMBO_TARGETS` targets with a strategy. Targets reuse the
 * catalog below — in combo mode tapping a model adds it instead of staging
 * a single selection. Everything stages into `pendingCombo` and commits on
 * Save; nothing persists on tap.
 */
function ThreadSettingsComboSection(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const session = useThreadSettingsSession();
  const mode = comboModeForThread(session.pendingCombo);
  const targets = session.pendingCombo?.targets ?? [];
  const strategy = session.pendingCombo?.strategy ?? "priority";

  return (
    <View>
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">Fallback</Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-card">
        <View className="flex-row gap-2 p-2">
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: mode === "single" }}
            onPress={() => session.setComboEnabled(false)}
            className={cn(
              "min-h-11 flex-1 items-center justify-center rounded-xl px-4 active:opacity-60",
              mode === "single" ? "bg-subtle-strong" : "bg-card",
            )}
          >
            <Text className="text-sm font-t3-medium text-foreground">Single</Text>
          </Pressable>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: mode === "combo" }}
            onPress={() => session.setComboEnabled(true)}
            className={cn(
              "min-h-11 flex-1 items-center justify-center rounded-xl px-4 active:opacity-60",
              mode === "combo" ? "bg-subtle-strong" : "bg-card",
            )}
          >
            <Text className="text-sm font-t3-medium text-foreground">
              {mode === "combo" ? `Combo · ${targets.length}` : "Combo"}
            </Text>
          </Pressable>
        </View>

        {mode === "combo" ? (
          <>
            {targets.map((target, index) => {
              const display = resolveComboTargetDisplay(target, session.providerGroups);
              return (
                <View
                  key={`${String(target.instanceId)}:${target.model}`}
                  className="min-h-11 flex-row items-center gap-2 border-t border-border-subtle px-4 py-2"
                >
                  <Text className="text-xs tabular-nums text-foreground-muted">{index + 1}</Text>
                  <View className="min-w-0 flex-1">
                    <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                      {display.title}
                    </Text>
                    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                      {display.subtitle}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityLabel={`Remove ${display.title} from combo`}
                    accessibilityRole="button"
                    onPress={() => session.removeComboTargetAt(index)}
                    className="min-h-11 min-w-11 items-center justify-center active:opacity-60"
                  >
                    <SymbolView
                      name="xmark"
                      size={14}
                      tintColorClassName={"accent-icon-muted"}
                      type="monochrome"
                    />
                  </Pressable>
                </View>
              );
            })}
            <View className="border-t border-border-subtle px-4 py-2">
              <Text className="text-xs leading-5 text-foreground-muted">
                {targets.length >= MAX_FALLBACK_COMBO_TARGETS
                  ? `Up to ${MAX_FALLBACK_COMBO_TARGETS} targets. Remove one to add another.`
                  : "Tap a model below to add it as a fallback."}
              </Text>
            </View>
            <View className="border-t border-border-subtle">
              <DisclosureRow
                label="Strategy"
                value={comboStrategyLabel(strategy)}
                onPress={() => props.onOpenSubmenu({ kind: "combo-strategy" })}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={session.clearCombo}
              className="min-h-11 items-center justify-center border-t border-border-subtle px-4 active:opacity-60"
            >
              <Text className="text-sm font-t3-medium text-foreground">Clear combo</Text>
            </Pressable>
          </>
        ) : (
          <View className="border-t border-border-subtle px-4 py-2">
            <Text className="text-xs leading-5 text-foreground-muted">
              One model per turn. Switch to Combo to fall back across up to{" "}
              {MAX_FALLBACK_COMBO_TARGETS} models when a turn hits a rate limit or provider error.
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function ThreadSettingsOptionsItem(props: {
  readonly animationsReady: boolean;
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const bottomToolbarInset =
    Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED
      ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET
      : 0;

  return (
    <View style={{ paddingBottom: insets.bottom + bottomToolbarInset + 12 }}>
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">Options</Text>
      <Animated.View
        className="mx-4 overflow-hidden rounded-2xl bg-card"
        layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
      >
        {session.displayedDescriptors.map((descriptor) => {
          if (descriptor.type === "select") {
            return (
              <Animated.View
                key={descriptor.id}
                entering={
                  props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined
                }
                exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
                layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
              >
                <DisclosureRow
                  label={descriptor.label}
                  value={getProviderOptionCurrentLabel(descriptor)}
                  onPress={() => props.onOpenSubmenu({ kind: "descriptor", id: descriptor.id })}
                />
              </Animated.View>
            );
          }
          return (
            <Animated.View
              key={descriptor.id}
              entering={props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined}
              exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
              layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
            >
              <SwitchRow
                label={descriptor.label}
                value={descriptor.currentValue ?? false}
                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
              />
            </Animated.View>
          );
        })}
        <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
          <DisclosureRow
            isLast
            label="Runtime"
            value={
              RUNTIME_MODE_CHOICES.find((choice) => choice.mode === session.runtimeMode)?.label
            }
            onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
          />
        </Animated.View>
      </Animated.View>

      {Platform.OS !== "ios" && session.hasLegacyModels ? (
        <>
          <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
            Catalog
          </Text>
          <View className="mx-4 overflow-hidden rounded-2xl bg-card">
            <SwitchRow
              isLast
              label="Legacy models"
              onValueChange={session.setShowLegacy}
              value={session.showLegacy}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/** One native scroll owner for the model catalog and its related settings. */
function ThreadSettingsMainContent(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const session = useThreadSettingsSession();
  const catalogItems = useThreadSettingsCatalogItems(session);
  const [animationsReady, setAnimationsReady] = useState(false);
  const nativeHeaderHeight = use(HeaderHeightContext) ?? 0;
  const hasActiveCatalogFilter =
    session.providerFilter !== null || session.searchQuery.trim().length > 0;
  const usesTransparentNativeHeader = Platform.OS === "ios" && NATIVE_LIQUID_GLASS_SUPPORTED;
  const listItems = useMemo<ReadonlyArray<ThreadSettingsCatalogItem>>(
    () => [
      ...(session.comboSupported ? ([{ kind: "combo", key: "combo" }] as const) : []),
      ...(catalogItems.length === 0 ? ([{ kind: "empty", key: "empty" }] as const) : catalogItems),
      { kind: "options", key: "options" },
    ],
    [catalogItems, session.comboSupported],
  );
  const renderCatalogItem = useCallback(
    (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
      const item = itemProps.item;
      let content: ReactNode;

      if (item.kind === "combo") {
        content = <ThreadSettingsComboSection onOpenSubmenu={props.onOpenSubmenu} />;
      } else if (item.kind === "provider") {
        content = <ThreadSettingsProviderListHeader provider={item.provider} />;
      } else if (item.kind === "model") {
        content = (
          <ThreadSettingsModelListRow
            isFirst={item.isFirst}
            isLast={item.isLast}
            option={item.option}
            providerLabel={item.providerLabel}
          />
        );
      } else if (item.kind === "empty") {
        content = (
          <View className="items-center px-8 py-14">
            <Text className="text-center text-sm text-foreground-muted">
              {hasActiveCatalogFilter ? "No matching models" : "No available models"}
            </Text>
          </View>
        );
      } else {
        content = (
          <ThreadSettingsOptionsItem
            animationsReady={animationsReady}
            onOpenSubmenu={props.onOpenSubmenu}
          />
        );
      }

      return (
        <Animated.View
          key={item.key}
          entering={animationsReady ? THREAD_SETTINGS_CATALOG_ENTER_TRANSITION : undefined}
          exiting={animationsReady ? THREAD_SETTINGS_CATALOG_EXIT_TRANSITION : undefined}
        >
          {content}
        </Animated.View>
      );
    },
    [animationsReady, hasActiveCatalogFilter, props.onOpenSubmenu],
  );

  return (
    <AnimatedLegendList
      automaticallyAdjustsScrollIndicatorInsets
      className="flex-1 bg-sheet"
      contentContainerStyle={{ paddingTop: 4 }}
      contentInsetAdjustmentBehavior={usesTransparentNativeHeader ? "never" : "automatic"}
      data={listItems}
      estimatedItemSize={48}
      extraData={animationsReady}
      getItemType={(item) => item.kind}
      itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
      ListHeaderComponent={
        <>
          {usesTransparentNativeHeader ? <View style={{ height: nativeHeaderHeight }} /> : null}
          {Platform.OS === "android" ? (
            <View className="px-4 pb-2 pt-3">
              <TextInput
                accessibilityLabel="Find a model"
                autoCapitalize="none"
                autoCorrect={false}
                className="h-11 rounded-xl bg-card px-4 text-base text-foreground"
                onChangeText={session.setSearchQuery}
                placeholder="Find a model"
                placeholderTextColorClassName="accent-placeholder"
                value={session.searchQuery}
              />
            </View>
          ) : null}
        </>
      }
      recycleItems
      onLoad={() => setAnimationsReady(true)}
      renderItem={renderCatalogItem}
      showsVerticalScrollIndicator={false}
    />
  );
}

/** Compact choice page pushed by the picker navigator. */
function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const descriptorId = props.submenu.kind === "descriptor" ? props.submenu.id : null;

  const activeDescriptor =
    descriptorId !== null
      ? session.displayedDescriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === descriptorId,
        )
      : undefined;

  const submenuContent =
    props.submenu.kind === "runtime"
      ? {
          rows: RUNTIME_MODE_CHOICES.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            description: choice.description,
            selected: choice.mode === session.runtimeMode,
            onPress: () => {
              void Haptics.selectionAsync();
              session.onUpdateRuntimeMode(choice.mode);
              props.onSelected();
            },
          })),
        }
      : props.submenu.kind === "combo-strategy"
        ? {
            rows: COMBO_STRATEGY_CHOICES.map((choice) => ({
              id: choice.value,
              label: choice.label,
              description: choice.description,
              selected: choice.value === (session.pendingCombo?.strategy ?? "priority"),
              onPress: () => {
                session.updateComboStrategy(choice.value);
                props.onSelected();
              },
            })),
          }
        : activeDescriptor?.type === "select"
          ? {
              rows: selectableChoices(activeDescriptor).map((choice) => ({
                id: choice.id,
                label: choice.label,
                description: undefined,
                selected: choice.id === getProviderOptionCurrentValue(activeDescriptor),
                onPress: () => {
                  void Haptics.selectionAsync();
                  session.applyOptionChange(activeDescriptor.id, choice.id);
                  props.onSelected();
                },
              })),
            }
          : null;

  if (!submenuContent) {
    return <View className="flex-1 bg-sheet" />;
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 16,
        paddingTop: 16,
      }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="overflow-hidden rounded-2xl bg-card">
        {submenuContent.rows.map((row, index) => (
          <ChoiceRow
            key={row.id}
            description={row.description}
            isLast={index === submenuContent.rows.length - 1}
            label={row.label}
            selected={row.selected}
            onPress={row.onPress}
          />
        ))}
      </View>
    </ScrollView>
  );
}

type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
};

type ThreadSettingsPickerPresentation = {
  readonly onClose: () => void;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

function ThreadSettingsModelsScreen() {
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const usesNativeMailSearchToolbar = Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  const hasCustomCatalogFilter = session.providerFilter !== null || session.showLegacy;
  const refreshProvidersCommand = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshProviderCatalog = useMemo(
    () => createProviderCatalogRefreshRunner(refreshProvidersCommand),
    [refreshProvidersCommand],
  );
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshProviders = useCallback(() => {
    if (!session.environmentId || isRefreshingProviders) return;
    setIsRefreshingProviders(true);
    void refreshProviderCatalog(session.environmentId).then((result) => {
      setIsRefreshingProviders(false);
      const error = providerCatalogRefreshError(result);
      if (error) Alert.alert("Could not refresh models", error);
    });
  }, [isRefreshingProviders, refreshProviderCatalog, session.environmentId]);
  const commitAndClose = useCallback(() => {
    if (!session.commitPendingModel()) return;
    presentation.onClose();
  }, [presentation, session]);
  // Groups are logical models, so the provider filter enumerates the
  // distinct providers behind the group's pairings.
  const providerChoices = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const group of session.providerGroups) {
      for (const model of group.models) {
        if (!byKey.has(model.providerKey)) {
          byKey.set(model.providerKey, model.providerLabel);
        }
      }
    }
    return [...byKey.entries()].map(([key, label]) => ({ key, label }));
  }, [session.providerGroups]);
  const filterMenu = useMemo(
    () => ({
      title: "Model filters",
      items: [
        {
          type: "submenu" as const,
          title: "Provider",
          items: [
            {
              type: "action" as const,
              title: "All providers",
              state: session.providerFilter === null ? ("on" as const) : ("off" as const),
              onPress: () => session.setProviderFilter(null),
            },
            ...providerChoices.map((choice) => ({
              type: "action" as const,
              title: choice.label,
              state: session.providerFilter === choice.key ? ("on" as const) : ("off" as const),
              onPress: () => session.setProviderFilter(choice.key),
            })),
          ],
        },
        ...(session.hasLegacyModels
          ? [
              {
                type: "action" as const,
                title: "Show legacy models",
                state: session.showLegacy ? ("on" as const) : ("off" as const),
                onPress: () => session.setShowLegacy(!session.showLegacy),
              },
            ]
          : []),
      ],
    }),
    [providerChoices, session],
  );

  return (
    <>
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          actions={[
            {
              accessibilityLabel: "Refresh models",
              disabled: isRefreshingProviders || session.environmentId === null,
              icon: "arrow.clockwise",
              onPress: refreshProviders,
            },
            {
              accessibilityLabel: session.hasPendingChanges ? "Save thread settings" : "Done",
              icon: "checkmark",
              onPress: commitAndClose,
            },
          ]}
          onBack={presentation.onClose}
          title="Thread settings"
        />
      ) : null}
      <NativeStackScreenOptions
        optionsVersion={[
          session.providerFilter,
          session.providerGroups.map((group) => group.key),
          session.showLegacy,
        ]}
        options={{
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  filterButtonId: "thread-settings-model-filter",
                  filterMenu,
                  filterSystemImageName: hasCustomCatalogFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onSearchTextChange: session.setSearchQuery,
                  placeholder: "Find a model",
                  searchTextChangeId: "thread-settings-model-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerShown: Platform.OS !== "android",
          headerSearchBarOptions:
            Platform.OS === "ios" && !usesNativeMailSearchToolbar
              ? {
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => session.setSearchQuery(""),
                  onChangeText: (event) => session.setSearchQuery(event.nativeEvent.text),
                  placeholder: "Find a model",
                }
              : undefined,
        }}
      />
      <ThreadSettingsMainContent
        onOpenSubmenu={(submenu) => {
          const title =
            submenu.kind === "runtime"
              ? "Runtime"
              : submenu.kind === "combo-strategy"
                ? "Strategy"
                : (session.displayedDescriptors.find(
                    (descriptor) => descriptor.type === "select" && descriptor.id === submenu.id,
                  )?.label ?? "Option");
          navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
        }}
      />
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Cancel thread settings"
          label="Cancel"
          onPress={presentation.onClose}
        />
      </NativeHeaderToolbar>
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Refresh models"
          disabled={isRefreshingProviders || session.environmentId === null}
          icon="arrow.clockwise"
          onPress={refreshProviders}
          separateBackground
        />
        <NativeHeaderToolbar.Button
          accessibilityLabel={session.hasPendingChanges ? "Save thread settings" : "Done"}
          label={session.hasPendingChanges ? "Save" : "Done"}
          onPress={commitAndClose}
        />
      </NativeHeaderToolbar>
      {Platform.OS === "ios" && !usesNativeMailSearchToolbar ? (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter models"
            icon={
              hasCustomCatalogFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            separateBackground
            title="Model filters"
          >
            <NativeHeaderToolbar.Menu title="Provider">
              <NativeHeaderToolbar.Label>Provider</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={session.providerFilter === null}
                onPress={() => session.setProviderFilter(null)}
              >
                All providers
              </NativeHeaderToolbar.MenuAction>
              {providerChoices.map((choice) => (
                <NativeHeaderToolbar.MenuAction
                  key={choice.key}
                  isOn={session.providerFilter === choice.key}
                  onPress={() => session.setProviderFilter(choice.key)}
                >
                  {choice.label}
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>
            {session.hasLegacyModels ? (
              <NativeHeaderToolbar.MenuAction
                isOn={session.showLegacy}
                onPress={() => session.setShowLegacy(!session.showLegacy)}
              >
                Show legacy models
              </NativeHeaderToolbar.MenuAction>
            ) : null}
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      ) : null}
    </>
  );
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={route.params.title} onBack={() => navigation.goBack()} />
      ) : null}
      <ThreadSettingsChoiceContent submenu={route.params} onSelected={() => navigation.goBack()} />
    </>
  );
}

function ThreadSettingsPickerNavigator(props: ThreadSettingsPickerPresentation) {
  const theme = useUniwindTheme();
  const solidSheetBackground = theme["--color-sheet-solid"];
  const foreground = theme["--color-foreground"];
  const presentation = useMemo(
    () => ({
      onClose: props.onClose,
    }),
    [props.onClose],
  );

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={{
          animation: "slide_from_right",
          contentStyle: { backgroundColor: solidSheetBackground },
          gestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: {
            backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED ? "transparent" : solidSheetBackground,
          },
          headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
          headerTintColor: foreground,
          headerTitleStyle: { fontSize: 17, fontWeight: "700" },
          scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
            ? THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS
            : undefined,
        }}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
          options={{ headerBackVisible: false, title: "Thread settings" }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsChoice"
          component={ThreadSettingsChoiceScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
      </ThreadSettingsPickerStack.Navigator>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}

/** Existing-thread model picker hosted by the root RNS form-sheet route. */
export function ExistingThreadSettingsRouteScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const presentation = useExistingThreadSettingsRoutePresentation();
  const session = presentation.session;

  useEffect(() => {
    if (session) {
      return;
    }

    navigation.goBack();
  }, [navigation, session]);

  if (!session) {
    return <View className="flex-1 bg-sheet" />;
  }

  const { ownerId: _ownerId, ...settings } = session;

  return (
    <ThreadSettingsSessionProvider {...settings}>
      <ThreadSettingsPickerNavigator onClose={() => navigation.goBack()} />
    </ThreadSettingsSessionProvider>
  );
}

/**
 * Native stack hosted by the New Task navigator's form-sheet route. Keeping
 * the sheet presentation in RNS gives UIKit ownership of nested dismissal,
 * while Reasoning and Runtime remain regular pushes inside this navigator.
 */
export function NewTaskThreadSettingsRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: flow.selectedModelOption?.capabilities,
        selections: flow.selectedModel?.options,
      }),
    [flow.selectedModel?.options, flow.selectedModelOption?.capabilities],
  );

  return (
    <ThreadSettingsSessionProvider
      environmentId={flow.selectedEnvironmentId}
      providerGroups={flow.providerGroups}
      selectedModel={flow.selectedModel}
      onSelectModel={(option) => flow.setSelectedModelKey(option.key, option.selection.options)}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={flow.setSelectedModelOptions}
      runtimeMode={flow.runtimeMode}
      onUpdateRuntimeMode={flow.setRuntimeMode}
    >
      <ThreadSettingsPickerNavigator onClose={() => navigation.goBack()} />
    </ThreadSettingsSessionProvider>
  );
}
