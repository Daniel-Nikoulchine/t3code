import { useEffect, useMemo } from "react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/pending-new-tasks-model";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  type ThreadListV2Layout,
  type ThreadListV2ListItem,
} from "./threadListV2";
import type { PendingThreadOrder } from "./threadOrder";

/**
 * Shared v2 list layout for Home and the thread navigation sidebar.
 *
 * Both screens partitioned the same inputs (threads, environment scope,
 * project scope, search, shelves) through `buildThreadListV2Items` and
 * re-armed the same snooze-expiry timer. This hook owns that composition
 * once; the two screens only differ in where their inputs come from
 * (props vs. options/state) and in how they render the resulting items.
 */
export function useThreadListV2Layout(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery: string;
  readonly matchedThreadKeys: ReadonlySet<string>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly pendingOrder: PendingThreadOrder | null;
  readonly settledVisibleCount: number;
  readonly nowMinute: number;
  readonly snoozeWakeTick: number;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
  readonly selectedThreadKey: string | null;
}): ThreadListV2Layout {
  const {
    threads,
    environmentId,
    projectRefs,
    searchQuery,
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
    selectedThreadKey,
  } = input;
  return useMemo(
    () =>
      buildThreadListV2Items({
        pendingOrder,
        threads: threads.filter((thread) => thread.archivedAt === null),
        environmentId,
        projectRefs,
        searchQuery,
        matchedThreadKeys,
        settlementEnvironmentIds,
        snoozeEnvironmentIds,
        queuedThreadKeys,
        settledLimit: settledVisibleCount,
        now: new Date().toISOString(),
        snoozedShelfExpanded,
        settledShelfExpanded,
        selectedThreadKey,
      }),
    [
      pendingOrder,
      threads,
      environmentId,
      projectRefs,
      searchQuery,
      matchedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      queuedThreadKeys,
      settledVisibleCount,
      nowMinute,
      snoozeWakeTick,
      snoozedShelfExpanded,
      settledShelfExpanded,
      selectedThreadKey,
    ],
  );
}

/**
 * Re-partition the moment the earliest snooze expires (clamped to the
 * signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
 */
export function useSnoozeWakeRepartition(
  nextSnoozeWakeAt: string | null,
  snoozeWakeTick: number,
  bumpSnoozeWakeTick: (updater: (tick: number) => number) => void,
): void {
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
    // bumpSnoozeWakeTick is a stable useState setter and stays out of deps.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
}

/**
 * Queued tasks are not thread shells, so the v2 partition never sees them;
 * they are spliced in below the active block with the same environment
 * scope and search filter as the list itself.
 */
export function filterThreadListV2PendingTasks(input: {
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly searchQuery: string;
}): ReadonlyArray<PendingNewTask> {
  const { pendingTasks, selectedEnvironmentId, scopedProjectKeys, searchQuery } = input;
  const query = searchQuery.trim().toLocaleLowerCase();
  return pendingTasks.filter(
    (pendingTask) =>
      (selectedEnvironmentId === null || pendingTask.environmentId === selectedEnvironmentId) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(
          scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
        )) &&
      (query.length === 0 || pendingTask.title.toLocaleLowerCase().includes(query)),
  );
}

/** Splice filtered pending tasks into the layout's display items. */
export function buildThreadListV2DisplayItems(input: {
  readonly layout: ThreadListV2Layout;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
  readonly nowMinute: number;
}): ThreadListV2ListItem[] {
  const { layout, pendingTasks, snoozedShelfExpanded, settledShelfExpanded, nowMinute } = input;
  return buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks,
    snoozedCount: layout.snoozedCount,
    snoozedShelfExpanded,
    snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
    settledCount: layout.settledCount,
    settledShelfExpanded,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    snoozeLabelNow: `${nowMinute}:00.000Z`,
  });
}

/** Sidebar-only: settled overflow behind "Show more" stays countable. */
export function shouldAppendSettledShowMoreRow(
  layout: ThreadListV2Layout,
  settledShelfExpanded: boolean,
): boolean {
  return settledShelfExpanded && layout.hiddenSettledCount > 0;
}
