import { describe, expect, it } from "@effect/vitest";

import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  makeOmpContentDeltaEvent,
  makeOmpToolCallEvent,
  makeOmpTurnCompletedEvent,
  makeOmpUserInputRequestedEvent,
  makeOmpUserInputResolvedEvent,
} from "./OmpRuntimeEvents.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const stamp = {
  eventId: EventId.make("00000000-0000-4000-8000-000000000000"),
  createdAt: "2026-01-01T00:00:00.000Z",
};
const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");

describe("OmpRuntimeEvents", () => {
  it("builds content deltas tagged as pi.rpc", () => {
    const event = makeOmpContentDeltaEvent({
      stamp,
      provider: PROVIDER,
      threadId,
      turnId,
      streamKind: "assistant_text",
      text: "hello",
      rawPayload: { type: "message_update" },
    });
    expect(event.type).toBe("content.delta");
    if (event.type === "content.delta") {
      expect(event.payload).toEqual({ streamKind: "assistant_text", delta: "hello" });
    }
    expect(event.raw).toMatchObject({ source: "pi.rpc", method: "message_update" });
  });

  it("maps tool lifecycles to item events", () => {
    const started = makeOmpToolCallEvent({
      stamp,
      provider: PROVIDER,
      threadId,
      turnId,
      toolCallId: "call-1",
      toolName: "bash",
      status: "inProgress",
      rawPayload: {},
    });
    expect(started.type).toBe("item.updated");
    const done = makeOmpToolCallEvent({
      stamp,
      provider: PROVIDER,
      threadId,
      turnId,
      toolCallId: "call-1",
      toolName: "bash",
      status: "completed",
      rawPayload: {},
    });
    expect(done.type).toBe("item.completed");
  });

  it("builds turn completions and user-input round trips", () => {
    const completed = makeOmpTurnCompletedEvent({
      stamp,
      provider: PROVIDER,
      threadId,
      turnId,
      state: "completed",
    });
    expect(completed.type).toBe("turn.completed");
    if (completed.type === "turn.completed") {
      expect(completed.payload.state).toBe("completed");
    }
    const requestId = RuntimeRequestId.make("req-1");
    const requested = makeOmpUserInputRequestedEvent({
      stamp,
      provider: PROVIDER,
      threadId,
      turnId,
      requestId,
      header: "Pick one",
      question: "Which?",
      options: [{ label: "A", description: "First" }],
      rawPayload: {},
    });
    expect(requested.type).toBe("user-input.requested");
    const resolved = makeOmpUserInputResolvedEvent({
      stamp,
      provider: PROVIDER,
      threadId,
      turnId,
      requestId,
      answers: { choice: "A" },
    });
    expect(resolved.type).toBe("user-input.resolved");
  });
});
