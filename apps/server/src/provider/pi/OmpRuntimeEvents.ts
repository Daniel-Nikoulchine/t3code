/**
 * OmpRuntimeEvents — `ProviderRuntimeEvent` constructors for the Oh-My-Pi /
 * Pi native RPC adapter.
 *
 * Mirrors `AcpCoreRuntimeEvents` but tags `raw.source` as `pi.rpc` so
 * downstream diagnostics can tell harness frames apart from ACP frames.
 *
 * @module provider/pi/OmpRuntimeEvents
 */
import {
  type EventId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type RuntimeRequestId,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { RuntimeItemId as RuntimeItemIdMaker } from "@t3tools/contracts";

export interface OmpEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

const PI_RPC_SOURCE = "pi.rpc" as const;

export function makeOmpContentDeltaEvent(input: {
  readonly stamp: OmpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly streamKind: "assistant_text" | "reasoning_text";
  readonly text: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: {
      streamKind: input.streamKind,
      delta: input.text,
    },
    raw: {
      source: PI_RPC_SOURCE,
      method: "message_update",
      payload: input.rawPayload,
    },
  };
}

export function makeOmpToolCallEvent(input: {
  readonly stamp: OmpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  /** Terminal lifecycle of the tool call. Ongoing updates are `inProgress`. */
  readonly status: "inProgress" | "completed" | "failed";
  readonly detail?: string;
  readonly data?: unknown;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: input.status === "inProgress" ? "item.updated" : "item.completed",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemIdMaker.make(input.toolCallId),
    payload: {
      itemType: "dynamic_tool_call",
      status: input.status,
      title: input.toolName,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    },
    raw: {
      source: PI_RPC_SOURCE,
      method: "tool_execution",
      payload: input.rawPayload,
    },
  };
}

export function makeOmpUserInputRequestedEvent(input: {
  readonly stamp: OmpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "user-input.requested",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      questions: [
        {
          id: "choice",
          header: input.header,
          question: input.question,
          options: input.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
        },
      ],
    },
    raw: {
      source: PI_RPC_SOURCE,
      method: "extension_ui_request",
      payload: input.rawPayload,
    },
  };
}

export function makeOmpUserInputResolvedEvent(input: {
  readonly stamp: OmpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly answers: Record<string, unknown>;
}): ProviderRuntimeEvent {
  return {
    type: "user-input.resolved",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: { answers: input.answers },
  };
}

export function makeOmpTurnCompletedEvent(input: {
  readonly stamp: OmpEventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly state: "completed" | "failed" | "cancelled";
  readonly errorMessage?: string;
}): ProviderRuntimeEvent {
  return {
    type: "turn.completed",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: {
      state: input.state,
      ...(input.state === "completed" ? { stopReason: "stop" } : {}),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    },
  };
}
