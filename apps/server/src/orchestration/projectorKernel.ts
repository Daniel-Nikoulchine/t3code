/**
 * projectorKernel — pure read-model helpers for the orchestration projector.
 *
 * `projector.ts` carries the ~20-case `projectEvent` switch; these eleven
 * helpers (activity/message retention, PR-link algebra, legacy-PR
 * derivation, turn-state mapping) are event-domain independent and used
 * across the switch. One owner here so the planned per-domain split can
 * import them without reaching back into the switch file — the same cut
 * made for the decider (`deciderKernel.ts`).
 *
 * Pure and covered indirectly by every `projector.*.test.ts` suite.
 *
 * @module orchestration/projectorKernel
 */
import type {
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { isImportedAgentSessionMessageId, WORKTREE_SETUP_ACTIVITY_KIND } from "@t3tools/contracts";
import {
  legacyLinkedPullRequestOf,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import * as Predicate from "effect/Predicate";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;

// Async questions can stay open while the agent produces more activity.
// Match the database snapshot's pending-question retention.
export function retainThreadActivities(activities: OrchestrationThread["activities"]) {
  const recentStart = activities.length - 500;
  if (recentStart <= 0) return activities;
  const pending = new Map<string, OrchestrationThread["activities"][number]>();
  for (const activity of activities) {
    if (!Predicate.isObject(activity.payload)) continue;
    const requestId = activity.payload.requestId;
    if (typeof requestId !== "string") continue;
    if (activity.kind === "user-input.requested" && activity.payload.responseMode === "message") {
      pending.set(requestId, activity);
    } else if (activity.kind === "user-input.resolved") {
      pending.delete(requestId);
    }
  }
  const pendingActivities = new Set(pending.values());
  return activities.filter(
    (activity, index) =>
      index >= recentStart ||
      pendingActivities.has(activity) ||
      // The worktree setup record is upserted under one id for the thread's
      // whole life and is the only durable copy of a running setup; an async
      // setup script can outlast a chatty first turn.
      activity.kind === WORKTREE_SETUP_ACTIVITY_KIND,
  );
}
export function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  // Match SQL and client projections: a missing git ref is not an interruption.
  return "completed" as const;
}
export function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

/** Patch that swaps a thread's links and re-derives the legacy single-PR field from them. */
export function pullRequestsPatch(
  thread: Pick<OrchestrationThread, "projectId">,
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  projects: OrchestrationReadModel["projects"],
): Pick<OrchestrationThread, "pullRequests" | "linkedPullRequest"> {
  return {
    pullRequests,
    linkedPullRequest: legacyLinkedPullRequestOf(
      pullRequests,
      thread.projectId,
      projects.find((project) => project.id === thread.projectId)?.repositoryIdentity,
    ),
  };
}

export function upsertPullRequestLink(
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  link: ThreadPullRequestLink,
): ReadonlyArray<ThreadPullRequestLink> {
  const index = pullRequests.findIndex((entry) => threadPullRequestKeysEqual(entry, link));
  return index === -1
    ? [...pullRequests, link]
    : pullRequests.map((entry, entryIndex) => (entryIndex === index ? link : entry));
}

export function removePullRequestLink(
  pullRequests: ReadonlyArray<ThreadPullRequestLink>,
  key: ThreadPullRequestKey,
): ReadonlyArray<ThreadPullRequestLink> {
  return pullRequests.filter((entry) => !threadPullRequestKeysEqual(entry, key));
}
/**
 * Host for a legacy `linkedPullRequest` being replayed into the link array.
 * Legacy links never carried one; the project's canonical key
 * (`<host>/<owner>/<name>`) is the best witness, then the link URL.
 */
export function legacyPullRequestHost(
  project: OrchestrationProject | undefined,
  linked: ThreadLinkedPullRequest,
): string {
  const canonicalHost = project?.repositoryIdentity?.canonicalKey.split("/")[0];
  if (canonicalHost) return canonicalHost.toLowerCase();
  try {
    return new URL(linked.url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

export function legacyLinkToPullRequests(
  thread: Pick<OrchestrationThread, "pullRequests">,
  project: OrchestrationProject | undefined,
  linked: ThreadLinkedPullRequest | null,
  linkedAt: string,
): ReadonlyArray<ThreadPullRequestLink> {
  // The legacy field held one user-chosen link, so null clears exactly the
  // manual ones and leaves created/agent/stack links alone.
  const withoutManual = thread.pullRequests.filter((entry) => entry.source !== "manual");
  if (linked === null) return withoutManual;
  return upsertPullRequestLink(withoutManual, {
    ...legacyThreadPullRequestKey(linked, legacyPullRequestHost(project, linked)),
    url: linked.url,
    source: "manual",
    linkedAt,
    snapshot: null,
    stack: null,
  });
}
export function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system" || isImportedAgentSessionMessageId(message.id)) {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) =>
      message.role === "user" &&
      !isImportedAgentSessionMessageId(message.id) &&
      retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) =>
      message.role === "assistant" &&
      !isImportedAgentSessionMessageId(message.id) &&
      retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          compareDateTimeStrings(left.createdAt, right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

export function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

export function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
