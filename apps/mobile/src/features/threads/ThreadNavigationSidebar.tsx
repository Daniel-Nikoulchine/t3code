import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { createThreadMovePlanner } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { LegendList } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchBarCommands } from "react-native-screens";

import { AppText as Text } from "../../components/AppText";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useProjects, useThreadShells } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";
import { usePendingThreadOrder } from "../../state/thread-order";
import { environmentServerConfigsAtom } from "../../state/server";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { useHomeListOptions } from "../home/home-list-options";
import { buildHomeListFilterMenu } from "../home/home-list-filter-menu";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import {
  getConnectionAwareBrandHeaderOptions,
  WorkspaceConnectionTitle,
} from "../home/WorkspaceConnectionTitle";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { SidebarFilterButton } from "./sidebar-filter-button";
import { createSidebarHeaderItems } from "./sidebar-native-header-items";
import { SidebarNavigationShell } from "./sidebar-navigation-shell";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SettledShelfHeader,
  ThreadListV2SnoozedShelfHeader,
} from "./thread-list-v2-items";
import { resolveThreadProviderInstance } from "./thread-provider-instance";
import {
  getThreadListV2OrderedSection,
  THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  type ThreadListV2ListItem,
} from "./threadListV2";
import {
  buildThreadListV2DisplayItems,
  filterThreadListV2PendingTasks,
  shouldAppendSettledShowMoreRow,
  useSnoozeWakeRepartition,
  useThreadListV2Layout,
} from "./useThreadListV2Layout";

/** The sidebar list serves the flat v2 rows with queued tasks spliced in and
    a settled "Show more" pager. */
type SidebarListItem =
  | ThreadListV2ListItem
  | { readonly type: "v2-show-more"; readonly key: string; readonly hiddenCount: number };

const SIDEBAR_STICKY_HEADER_HEIGHT = 106;

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

/**
 * iPad/large-width sidebar column.
 *
 * On iOS the pane is hosted inside its own navigation-inert single-screen
 * native stack (SidebarNavigationShell) so the header is a real
 * UINavigationBar: large title, native bar-button items, and a
 * UISearchController search field — the same chrome a UISplitViewController
 * column gets. Other platforms keep the custom header chrome.
 */
export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  if (Platform.OS !== "ios") {
    return <ThreadNavigationSidebarPane {...props} nativeChrome={false} />;
  }
  return <NativeSidebarContainer {...props} />;
}

function NativeSidebarContainer(props: ThreadNavigationSidebarProps) {
  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-border bg-drawer"
      style={{ borderRightWidth: StyleSheet.hairlineWidth, width: props.width }}
    >
      <SidebarNavigationShell>
        <ThreadNavigationSidebarPane {...props} nativeChrome />
      </SidebarNavigationShell>
    </View>
  );
}

function ThreadNavigationSidebarPane(
  props: ThreadNavigationSidebarProps & { readonly nativeChrome: boolean },
) {
  const { materialYouStyleLayoutActive, themeVariables: materialTheme } =
    useAppearancePreferences();
  const screenColor = materialTheme["--color-screen"];
  const mutedColor = materialTheme["--color-foreground-muted"];

  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const searchInputRef = useRef<TextInput>(null);
  const searchBarRef = useRef<SearchBarCommands>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const sidebarScrollGesture = useMemo(() => Gesture.Native(), []);
  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    moveThread,
    regenerateThreadTitle,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const queuedThreadKeys = useQueuedThreadKeys();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(
    () =>
      Object.values(savedConnectionsById)
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    [savedConnectionsById],
  );
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const { options, setSelectedEnvironmentId } = useHomeListOptions(availableEnvironmentIds);
  const searchEnvironmentIds = useMemo(
    () =>
      options.selectedEnvironmentId === null
        ? workspaceEnvironments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : workspaceEnvironments.some(
              (environment) =>
                environment.environmentId === options.selectedEnvironmentId &&
                environment.connectionState === "connected",
            )
          ? [options.selectedEnvironmentId]
          : [],
    [options.selectedEnvironmentId, workspaceEnvironments],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const matchedThreadKeys = useMemo(
    () => new Set(threadSearch.matches.map(threadSearchMatchKey)),
    [threadSearch.matches],
  );
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: options.selectedEnvironmentId,
        projectGroupingMode: options.projectGroupingMode,
      }),
    [options.projectGroupingMode, options.selectedEnvironmentId, projects],
  );
  const projectFilterOptions = useMemo(
    () =>
      projectScopes.map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes],
  );
  const projectTitleByProjectKey = useMemo(
    () =>
      new Map(
        projectScopes.flatMap((scope) =>
          scope.projectRefs.map(
            (projectRef) =>
              [
                scopedProjectKey(projectRef.environmentId, projectRef.projectId),
                scope.title,
              ] as const,
          ),
        ),
      ),
    [projectScopes],
  );
  const selectedProjectScope = useMemo(
    () =>
      selectedProjectKey === null
        ? null
        : (projectScopes.find((scope) => scope.key === selectedProjectKey) ?? null),
    [projectScopes, selectedProjectKey],
  );
  useEffect(() => {
    if (
      selectedProjectKey !== null &&
      !projectFilterOptions.some((project) => project.key === selectedProjectKey)
    ) {
      setSelectedProjectKey(null);
    }
  }, [projectFilterOptions, selectedProjectKey]);
  const selectedProjectRefs = useMemo(
    () =>
      selectedProjectScope === null
        ? null
        : new Set(
            selectedProjectScope.projectRefs.map((projectRef) =>
              scopedProjectKey(projectRef.environmentId, projectRef.projectId),
            ),
          ),
    [selectedProjectScope],
  );
  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [projects]);

  // The settled tail renders in pages; expansion resets when the filter
  // context changes so environment/search flips never inherit a deep page.
  const [settledVisibleCount, setSettledVisibleCount] = useState(
    THREAD_LIST_V2_SETTLED_INITIAL_COUNT,
  );
  const settledResetKey = `${options.selectedEnvironmentId ?? "all"}:${selectedProjectKey ?? "all"}:${props.searchQuery.trim()}`;
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    setSettledVisibleCount(THREAD_LIST_V2_SETTLED_INITIAL_COUNT);
  }
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + THREAD_LIST_V2_SETTLED_PAGE_COUNT),
    [],
  );
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
  } = useThreadListV2ShelfPreferences();
  // The queued-start and snooze helpers need a clock while the pane stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    // Refresh immediately because the mount-time value can be hours old.
    setNowMinute(new Date().toISOString().slice(0, 16));
    const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(id);
  }, []);
  // Threads on servers without the settlement capability never classify as
  // settled (the user could neither un-settle nor pin them).
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const settlementEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSettlement === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const snoozeEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSnooze === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinningEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinning === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const pinReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadPinReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const activeReorderEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadActiveReorder === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const titleRegenerationEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadTitleRegeneration === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);
  const machineByEnvironmentId = useMemo(
    () =>
      new Map(
        [...serverConfigs].map(
          ([environmentId, config]) =>
            [environmentId, resolveEnvironmentMachineKind(config)] as const,
        ),
      ),
    [serverConfigs],
  );
  const pendingOrder = usePendingThreadOrder(nowMinute, snoozeWakeTick);
  const threadMovePlanners = useMemo(() => {
    const sectionPlanner = (section: "pinned" | "active") =>
      createThreadMovePlanner({
        allThreads: threads,
        section,
        reorderableEnvironmentIds: new Set(
          [...serverConfigs].flatMap(([id, config]) =>
            (section === "pinned"
              ? config.environment.capabilities.threadPinReorder
              : config.environment.capabilities.threadActiveReorder) === true
              ? [id]
              : [],
          ),
        ),
        ordered: getThreadListV2OrderedSection({
          threads,
          section,
          pendingOrder,
          now: new Date().toISOString(),
          settlementEnvironmentIds,
          snoozeEnvironmentIds,
          queuedThreadKeys,
        }),
      });
    return { pinned: sectionPlanner("pinned"), active: sectionPlanner("active") };
  }, [
    serverConfigs,
    threads,
    pendingOrder,
    queuedThreadKeys,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    nowMinute,
    snoozeWakeTick,
  ]);
  const threadListV2Layout = useThreadListV2Layout({
    threads,
    environmentId: options.selectedEnvironmentId,
    projectRefs: selectedProjectScope === null ? null : selectedProjectScope.projectRefs,
    searchQuery: props.searchQuery,
    matchedThreadKeys,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    queuedThreadKeys,
    pendingOrder,
    settledVisibleCount,
    nowMinute,
    snoozeWakeTick,
    snoozedShelfExpanded,
    settledShelfExpanded,
    selectedThreadKey: props.selectedThreadKey ?? null,
  });
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useSnoozeWakeRepartition(nextSnoozeWakeAt, snoozeWakeTick, bumpSnoozeWakeTick);
  const listItems = useMemo<readonly SidebarListItem[]>(() => {
    // Queued offline tasks are not thread shells, so the v2 item builder
    // never sees them; the shared splice puts them below the active block
    // (mirrors the compact Home v2 list) where they stay visible and
    // deletable while their environment is offline. Same environment scope
    // and search filter as the list.
    const v2PendingTasks = filterThreadListV2PendingTasks({
      pendingTasks,
      selectedEnvironmentId: options.selectedEnvironmentId,
      scopedProjectKeys: selectedProjectRefs,
      searchQuery: props.searchQuery,
    });
    const items: SidebarListItem[] = buildThreadListV2DisplayItems({
      layout: threadListV2Layout,
      pendingTasks: v2PendingTasks,
      snoozedShelfExpanded,
      settledShelfExpanded,
      nowMinute,
    });
    if (shouldAppendSettledShowMoreRow(threadListV2Layout, settledShelfExpanded)) {
      items.push({
        type: "v2-show-more",
        key: "v2-show-more",
        hiddenCount: threadListV2Layout.hiddenSettledCount,
      });
    }
    return items;
  }, [
    nowMinute,
    options.selectedEnvironmentId,
    pendingTasks,
    props.searchQuery,
    selectedProjectRefs,
    settledShelfExpanded,
    snoozedShelfExpanded,
    threadListV2Layout,
  ]);
  const listMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            subtitle: "Show threads from every environment",
            state: options.selectedEnvironmentId === null ? "on" : "off",
          },
          ...environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              options.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ],
      },
      ...(projectFilterOptions.length === 0
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  subtitle: "Show threads from every project",
                  state: selectedProjectKey === null ? "on" : "off",
                },
                ...projectFilterOptions.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
                })),
              ],
            },
          ] satisfies MenuAction[])),
    ],
    [environments, options.selectedEnvironmentId, projectFilterOptions, selectedProjectKey],
  );
  const handleListMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const event = nativeEvent.event;
      if (event === "environment:all") {
        setSelectedEnvironmentId(null);
        return;
      }
      if (event.startsWith("environment:")) {
        const environment = environments.find(
          (candidate) => String(candidate.environmentId) === event.slice("environment:".length),
        );
        if (environment) setSelectedEnvironmentId(environment.environmentId);
        return;
      }
      if (event === "project:all") {
        setSelectedProjectKey(null);
        return;
      }
      if (event.startsWith("project:")) {
        const projectKey = event.slice("project:".length);
        if (projectFilterOptions.some((project) => project.key === projectKey)) {
          setSelectedProjectKey(projectKey);
        }
        return;
      }
    },
    [environments, projectFilterOptions, setSelectedEnvironmentId],
  );

  const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState<number | null>(null);
  // The sticky header (title row, search field, optional connection status)
  // is measured so the list inset always matches its real height — no
  // hardcoded per-variant constants.
  const stickyHeaderHeight = measuredHeaderHeight ?? insets.top + SIDEBAR_STICKY_HEADER_HEIGHT;
  const topListInset = stickyHeaderHeight + 6;
  const handleStickyHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = Math.round(event.nativeEvent.layout.height);
    setMeasuredHeaderHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      props.onSelectThread(thread);
      openSwipeableRef.current?.close();
    },
    [props.onSelectThread],
  );
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // Project shells load after the first rows draw, so the maps they feed have
  // to bust the recycler's memoization — otherwise a row keeps the blank
  // favicon and fallback title it was first rendered with.
  const listExtraData = useMemo(
    () => ({
      selectedThreadKey: props.selectedThreadKey ?? "",
      projectByKey,
      projectTitleByProjectKey,
      savedConnectionsById,
      serverConfigs,
      snoozePresetMinute: nowMinute,
      threadSearchMatchByKey,
    }),
    [
      props.selectedThreadKey,
      projectByKey,
      projectTitleByProjectKey,
      savedConnectionsById,
      serverConfigs,
      nowMinute,
      threadSearchMatchByKey,
    ],
  );
  useThreadJumpShortcuts(listItems, handleSelectThread);
  const sidebarItemsAreEqual = useCallback(
    (previous: SidebarListItem, item: SidebarListItem): boolean => {
      if (previous.type === "v2-thread" && item.type === "v2-thread") {
        return (
          previous.key === item.key &&
          previous.item.thread === item.item.thread &&
          previous.item.variant === item.item.variant &&
          previous.item.snoozed === item.item.snoozed &&
          previous.item.pinned === item.item.pinned &&
          previous.snoozeWakeLabelText === item.snoozeWakeLabelText
        );
      }
      if (previous.type === "v2-show-more" && item.type === "v2-show-more") {
        return previous.hiddenCount === item.hiddenCount;
      }
      if (previous.type === "v2-pending" && item.type === "v2-pending") {
        return (
          previous.pendingTask === item.pendingTask &&
          previous.showPendingDivider === item.showPendingDivider
        );
      }
      if (previous.type === "v2-snoozed-shelf" && item.type === "v2-snoozed-shelf") {
        return previous.count === item.count && previous.expanded === item.expanded;
      }
      if (previous.type === "v2-settled-shelf" && item.type === "v2-settled-shelf") {
        return previous.count === item.count && previous.expanded === item.expanded;
      }
      return false;
    },
    [],
  );
  const focusSearch = useCallback(() => {
    const focus = () => {
      if (props.nativeChrome) {
        searchBarRef.current?.focus();
        return;
      }
      searchInputRef.current?.focus();
    };
    if (!props.visible) {
      props.onRequestVisibility();
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  }, [props.nativeChrome, props.onRequestVisibility, props.visible]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const renderListItem = useCallback(
    ({ item }: { readonly item: SidebarListItem }) => {
      switch (item.type) {
        case "v2-pending": {
          const pendingScopeKey = scopedProjectKey(
            item.pendingTask.environmentId,
            item.pendingTask.projectId,
          );
          return (
            <ThreadListV2PendingRow
              pendingTask={item.pendingTask}
              project={projectByKey.get(pendingScopeKey) ?? null}
              projectTitle={projectTitleByProjectKey.get(pendingScopeKey)}
              environmentLabel={
                Object.keys(savedConnectionsById).length > 1
                  ? (savedConnectionsById[item.pendingTask.environmentId]?.environmentLabel ?? null)
                  : null
              }
              environmentMachine={machineByEnvironmentId.get(item.pendingTask.environmentId)}
              pane="sidebar"
              showPendingDivider={item.showPendingDivider}
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        }
        case "v2-thread": {
          const thread = item.item.thread;
          const movePlanner = item.item.pinned
            ? threadMovePlanners.pinned
            : threadMovePlanners.active;
          const movedId = `${thread.environmentId}:${thread.id}`;
          const scopeKey = scopedProjectKey(thread.environmentId, thread.projectId);
          return (
            <ThreadListV2Row
              onNewThreadOnBranch={props.onNewThreadOnBranch}
              thread={thread}
              variant={item.item.variant}
              hasQueuedMessages={queuedThreadKeys.has(`${thread.environmentId}:${thread.id}`)}
              snoozed={item.item.snoozed}
              pinned={item.item.pinned}
              snoozePresetMinute={nowMinute}
              snoozeWakeLabelText={item.snoozeWakeLabelText}
              project={projectByKey.get(scopeKey) ?? null}
              projectTitle={projectTitleByProjectKey.get(scopeKey)}
              providerInstance={resolveThreadProviderInstance(serverConfigs, thread)}
              environmentLabel={
                Object.keys(savedConnectionsById).length > 1
                  ? (savedConnectionsById[thread.environmentId]?.environmentLabel ?? null)
                  : null
              }
              environmentMachine={machineByEnvironmentId.get(thread.environmentId)}
              searchMatch={threadSearchMatchByKey.get(
                threadSearchMatchKey({
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                }),
              )}
              searchQuery={props.searchQuery}
              pane={materialYouStyleLayoutActive ? "screen" : "sidebar"}
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onSelectThread={handleSelectThread}
              onDeleteThread={confirmDeleteThread}
              onArchiveThread={archiveThread}
              onRegenerateThreadTitle={regenerateThreadTitle}
              titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
              settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
              onSettleThread={settleThread}
              snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
              pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
              reorderSupported={
                item.item.pinned
                  ? pinReorderEnvironmentIds.has(thread.environmentId)
                  : activeReorderEnvironmentIds.has(thread.environmentId)
              }
              canMoveUp={pendingOrder === null && movePlanner(movedId, "up") !== null}
              canMoveDown={pendingOrder === null && movePlanner(movedId, "down") !== null}
              onSnoozeThread={snoozeThread}
              onUnsnoozeThread={unsnoozeThread}
              onUnsettleThread={unsettleThread}
              onPinThread={pinThread}
              onUnpinThread={unpinThread}
              onMoveThread={moveThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "v2-snoozed-shelf":
          return (
            <ThreadListV2SnoozedShelfHeader
              count={item.count}
              disabled={!shelfPreferencesLoaded}
              expanded={item.expanded}
              onToggle={toggleSnoozedShelf}
              pane={materialYouStyleLayoutActive ? "screen" : "sidebar"}
            />
          );
        case "v2-settled-shelf":
          return (
            <ThreadListV2SettledShelfHeader
              count={item.count}
              disabled={!shelfPreferencesLoaded}
              expanded={item.expanded}
              onToggle={toggleSettledShelf}
              pane={materialYouStyleLayoutActive ? "screen" : "sidebar"}
            />
          );
        case "v2-show-more":
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Show ${Math.min(item.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT)} more settled threads`}
              onPress={showMoreSettled}
              className="mx-4 mt-2 items-center rounded-lg border border-dashed border-border py-2.5"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Text className="text-xs font-t3-medium text-foreground-muted">
                Show more ({item.hiddenCount} settled hidden)
              </Text>
            </Pressable>
          );
      }
    },
    [
      materialYouStyleLayoutActive,
      archiveThread,
      activeReorderEnvironmentIds,
      threadMovePlanners,
      pendingOrder,
      queuedThreadKeys,
      confirmDeletePendingTask,
      confirmDeleteThread,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      machineByEnvironmentId,
      moveThread,
      openPendingTask,
      pinReorderEnvironmentIds,
      pinThread,
      pinningEnvironmentIds,
      projectByKey,
      projectTitleByProjectKey,
      regenerateThreadTitle,
      props.onNewThreadOnBranch,
      props.searchQuery,
      props.selectedThreadKey,
      props.width,
      savedConnectionsById,
      serverConfigs,
      shelfPreferencesLoaded,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      settleThread,
      settlementEnvironmentIds,
      showMoreSettled,
      sidebarScrollGesture,
      snoozeEnvironmentIds,
      snoozeThread,
      nowMinute,
      toggleSettledShelf,
      toggleSnoozedShelf,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
    ],
  );
  // Only the environment/project filters can light the "customized" state.
  const filterCustomized = options.selectedEnvironmentId !== null || selectedProjectKey !== null;
  const filterIcon = filterCustomized
    ? "line.3.horizontal.decrease.circle.fill"
    : "line.3.horizontal.decrease.circle";
  const filterMenu = useMemo(
    () =>
      buildHomeListFilterMenu({
        environments,
        projects: projectFilterOptions,
        selectedEnvironmentId: options.selectedEnvironmentId,
        selectedProjectKey,
        onEnvironmentChange: setSelectedEnvironmentId,
        onProjectChange: setSelectedProjectKey,
      }),
    [
      environments,
      options.selectedEnvironmentId,
      projectFilterOptions,
      selectedProjectKey,
      setSelectedEnvironmentId,
    ],
  );
  const nativeHeaderItems = useMemo(
    () =>
      createSidebarHeaderItems({
        filterIcon,
        filterMenu,
        onOpenSettings: props.onOpenSettings,
      }),
    [filterIcon, filterMenu, props.onOpenSettings],
  );
  // Snoozed threads need no special case: the shelf header is a list row
  // even while collapsed.
  const listEmpty = (
    <Text className="px-2 py-4 text-sm text-foreground-muted">
      {catalogState.isLoadingConnections
        ? "Loading threads…"
        : props.searchQuery.trim().length > 0
          ? threadSearch.isPending
            ? "Searching thread messages…"
            : "No matching threads"
          : selectedProjectScope !== null
            ? `No threads in ${selectedProjectScope.title}`
            : "No threads yet"}
    </Text>
  );

  if (props.nativeChrome) {
    return (
      <>
        <NativeStackScreenOptions
          optionsVersion={[nativeHeaderItems, props.width]}
          options={{
            // Re-applies the shell's static brand slot with the
            // connection-status swap so reconnects surface in the header
            // instead of shifting the list.
            ...getConnectionAwareBrandHeaderOptions({
              headerWidth: props.width,
              trailingItemCount: nativeHeaderItems.length,
              onOpenEnvironments: props.onOpenEnvironmentSettings,
              fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
            }),
            headerSearchBarOptions: {
              ref: searchBarRef,
              autoCapitalize: "none",
              hideNavigationBar: false,
              // Keep the search bar pinned under the title — UIKit's default
              // hidesSearchBarWhenScrolling collapses it on scroll.
              hideWhenScrolling: false,
              obscureBackground: false,
              placeholder: "Search",
              placement: "stacked",
              onCancelButtonPress: () => {
                props.onSearchQueryChange("");
              },
              onChangeText: (event) => {
                props.onSearchQueryChange(event.nativeEvent.text);
              },
            },
            unstable_headerRightItems: () => nativeHeaderItems,
          }}
        />
        <View className="flex-1">
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <LegendList
                data={listItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={sidebarItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
                contentInsetAdjustmentBehavior={
                  NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"
                }
                contentContainerStyle={[
                  styles.threadListContent,
                  materialYouStyleLayoutActive ? { paddingHorizontal: 0 } : null,
                  {
                    paddingBottom: Math.max(insets.bottom, 16) + 16,
                    paddingTop: 6,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={listEmpty}
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        </View>
      </>
    );
  }

  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-r border-border bg-drawer"
      style={{ width: props.width }}
    >
      <View
        className="flex-1"
        style={
          materialYouStyleLayoutActive
            ? {
                marginTop: stickyHeaderHeight,
                paddingBottom: insets.bottom,
                backgroundColor: screenColor,
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                overflow: "hidden",
              }
            : { paddingBottom: insets.bottom }
        }
      >
        <SwipeableScrollGateProvider enabled={swipeEnabled}>
          <GestureDetector gesture={sidebarScrollGesture}>
            <LegendList
              data={listItems}
              drawDistance={500}
              estimatedItemSize={64}
              extraData={listExtraData}
              getItemType={(item) => item.type}
              itemsAreEqual={sidebarItemsAreEqual}
              keyExtractor={(item) => item.key}
              renderItem={renderListItem}
              contentContainerStyle={[
                styles.threadListContent,
                materialYouStyleLayoutActive ? { paddingHorizontal: 0 } : null,
                {
                  paddingBottom:
                    Platform.OS === "android"
                      ? Math.max(insets.bottom, 16) + 88 - insets.bottom
                      : 16 + insets.bottom,
                  paddingTop: materialYouStyleLayoutActive ? 6 : topListInset,
                },
              ]}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              {...scrollGateHandlers}
              recycleItems
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              style={styles.threadList}
              ListEmptyComponent={listEmpty}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
      </View>

      <View
        className="absolute inset-x-0 top-0 z-[4] bg-drawer"
        collapsable={false}
        onLayout={handleStickyHeaderLayout}
        pointerEvents="auto"
        style={{ paddingTop: insets.top }}
      >
        <View className="h-[50px] flex-row items-end gap-0.5 pr-2 pl-5">
          {/* Title slot doubles as the connection status surface: while an
              environment reconnects, the brand fades to a status label in
              place (no layout shift in the list below). */}
          <WorkspaceConnectionTitle
            grow
            onPress={props.onOpenEnvironmentSettings}
            size="pageTitle"
            brand={
              <View className="h-11 flex-1 justify-center">
                <CompactBrandTitle allowFontScaling={false} />
              </View>
            }
          />
          <View className="flex-row items-center gap-2.5">
            <ControlPillMenu actions={listMenuActions} onPressAction={handleListMenuAction}>
              <SidebarFilterButton accessibilityLabel="Filter and sort threads" icon={filterIcon} />
            </ControlPillMenu>
            <SidebarHeaderActions onOpenSettings={props.onOpenSettings} />
          </View>
        </View>

        <View
          className={
            materialYouStyleLayoutActive
              ? "mx-4 mt-[9px] min-h-12 flex-row items-center gap-2.5 rounded-full border border-input-border bg-input px-3.5"
              : "mx-4 mt-[9px] h-[38px] flex-row items-center gap-1.5 rounded-xl bg-sidebar-search pr-2.5 pl-[11px]"
          }
        >
          <SymbolView
            name="magnifyingglass"
            size={15}
            tintColorClassName={"accent-foreground-muted"}
            type="monochrome"
          />
          <TextInput
            ref={searchInputRef}
            accessibilityLabel="Search threads"
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode={materialYouStyleLayoutActive ? "never" : "while-editing"}
            onChangeText={props.onSearchQueryChange}
            placeholder="Search"
            placeholderTextColorClassName={"accent-placeholder"}
            returnKeyType="search"
            className={
              materialYouStyleLayoutActive
                ? "flex-1 px-0 py-2.5 font-sans text-base text-foreground"
                : "h-[34px] flex-1 px-0 py-0 font-sans text-base text-foreground"
            }
            value={props.searchQuery}
          />
          {materialYouStyleLayoutActive && props.searchQuery.length > 0 ? (
            <Pressable
              accessibilityLabel="Clear search"
              hitSlop={10}
              onPress={() => props.onSearchQueryChange("")}
            >
              <SymbolView
                name="xmark.circle.fill"
                size={17}
                tintColor={mutedColor}
                type="monochrome"
              />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
