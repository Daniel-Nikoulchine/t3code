import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/pending-new-tasks-model";
import {
  buildThreadListV2DisplayItems,
  filterThreadListV2PendingTasks,
  shouldAppendSettledShowMoreRow,
} from "./useThreadListV2Layout";
import type { ThreadListV2Layout } from "./threadListV2";

const NOW = "2026-06-01T00:00:00.000Z";
const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

function makePendingTask(
  id: string,
  overrides?: Partial<Pick<PendingNewTask, "environmentId" | "projectId" | "title">>,
): PendingNewTask {
  const creation = {
    projectId: overrides?.projectId ?? projectId,
    workspaceMode: "worktree" as const,
    branch: null,
    worktreePath: null,
  };
  const taskEnvironmentId = overrides?.environmentId ?? environmentId;
  return {
    kind: "pending",
    key: `pending-task:${id}`,
    environmentId: taskEnvironmentId,
    projectId: creation.projectId,
    projectTitle: undefined,
    projectCwd: undefined,
    branch: null,
    title: overrides?.title ?? id,
    createdAt: NOW,
    message: {
      environmentId: taskEnvironmentId,
      threadId: ThreadId.make(`thread-${id}`),
      messageId: MessageId.make(id),
      commandId: CommandId.make(`command-${id}`),
      text: id,
      attachments: [],
      createdAt: NOW,
      creation,
    },
    creation,
  };
}

const emptyLayout: ThreadListV2Layout = {
  items: [],
  hiddenSettledCount: 0,
  snoozedCount: 0,
  snoozedShelfHeaderIndex: null,
  settledCount: 0,
  settledShelfHeaderIndex: null,
  nextSnoozeWakeAt: null,
};

describe("filterThreadListV2PendingTasks", () => {
  const tasks = [makePendingTask("alpha"), makePendingTask("beta")];

  it("keeps tasks in the selected environment and matching search", () => {
    expect(
      filterThreadListV2PendingTasks({
        pendingTasks: tasks,
        selectedEnvironmentId: null,
        scopedProjectKeys: null,
        searchQuery: "alp",
      }).map((task) => task.title),
    ).toEqual(["alpha"]);
  });

  it("drops tasks outside the environment and project scope", () => {
    const otherEnv = EnvironmentId.make("environment-2");
    expect(
      filterThreadListV2PendingTasks({
        pendingTasks: tasks,
        selectedEnvironmentId: otherEnv,
        scopedProjectKeys: null,
        searchQuery: "",
      }),
    ).toEqual([]);
    expect(
      filterThreadListV2PendingTasks({
        pendingTasks: tasks,
        selectedEnvironmentId: null,
        scopedProjectKeys: new Set([scopedProjectKey(environmentId, ProjectId.make("other"))]),
        searchQuery: "",
      }),
    ).toEqual([]);
  });
});

describe("buildThreadListV2DisplayItems", () => {
  it("splices pending tasks into an empty layout", () => {
    const items = buildThreadListV2DisplayItems({
      layout: emptyLayout,
      pendingTasks: [makePendingTask("queued-1")],
      snoozedShelfExpanded: false,
      settledShelfExpanded: true,
      nowMinute: 0,
    });
    expect(items.map((item) => item.type)).toEqual(["v2-pending"]);
  });
});

describe("shouldAppendSettledShowMoreRow", () => {
  it("only appends when expanded with hidden settled rows", () => {
    expect(shouldAppendSettledShowMoreRow({ ...emptyLayout, hiddenSettledCount: 3 }, true)).toBe(
      true,
    );
    expect(shouldAppendSettledShowMoreRow({ ...emptyLayout, hiddenSettledCount: 3 }, false)).toBe(
      false,
    );
    expect(shouldAppendSettledShowMoreRow(emptyLayout, true)).toBe(false);
  });
});
