#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// Mock `pi` CLI for Pi provider tests.
//
// Usage: the test wrapper execs `node pi-rpc-mock-agent.ts [pi args]`.
// Behavior is driven by `PI_MOCK_*` environment variables:
//
//   PI_MOCK_VERSION          `pi --version` output (default "0.73.1").
//   PI_MOCK_MODELS_JSON      JSON array for `get_available_models`
//                            (default two mock models).
//   PI_MOCK_COMMANDS_JSON    JSON array for `get_commands`.
//   PI_MOCK_TEXT             Assistant reply text (default "hello from mock pi").
//   PI_MOCK_TOOLS            "1" emits one bash tool execution per turn.
//   PI_MOCK_DIALOG           "select" | "confirm" | "input" | "editor": emit one
//                            extension_ui_request per turn and wait for the
//                            matching extension_ui_response before finishing.
//   PI_MOCK_PROMPT_FAIL      When set, `prompt` responds with success:false.
//   PI_MOCK_PRINT_OUTPUT     Stdout for `-p` print mode.
//   PI_MOCK_TURN_DELAY_MS    Delay before `agent_end` (default 5ms).
//   PI_MOCK_REQUEST_LOG      Append every received stdin line (JSONL).
//   PI_MOCK_EXIT_LOG         Append exit signal/line for lifecycle assertions.
//   PI_MOCK_SESSION_FILE     `sessionFile` reported by `get_state`.
//
// Only erasable TypeScript syntax is used so plain `node` can run this file
// via type stripping (same arrangement as `acp-mock-agent.ts`).
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const args = process.argv.slice(2);
const env = process.env;

function readArgFlag(names: Array<string>): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== undefined && names.includes(flag) && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function logRequest(line: string): void {
  const path = env.PI_MOCK_REQUEST_LOG;
  if (path) {
    NodeFS.appendFileSync(path, `${line}\n`);
  }
}

function logExit(message: string): void {
  const path = env.PI_MOCK_EXIT_LOG;
  if (path) {
    NodeFS.appendFileSync(path, `${message}\n`);
  }
}

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`${env.PI_MOCK_VERSION ?? "0.73.1"}\n`);
  process.exit(0);
}

if (args.includes("-p") || args.includes("--print")) {
  logRequest(JSON.stringify({ type: "print", args }));
  process.stdout.write(`${env.PI_MOCK_PRINT_OUTPUT ?? '{"title":"Mock title"}'}\n`);
  process.exit(0);
}

interface MockModel {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
}

function readModels(): Array<MockModel> {
  const raw = env.PI_MOCK_MODELS_JSON;
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as Array<Partial<MockModel>>;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry) => entry.id && entry.provider)
          .map((entry) => ({
            id: String(entry.id),
            provider: String(entry.provider),
            name: entry.name ? String(entry.name) : String(entry.id),
            reasoning: entry.reasoning === true,
          }));
      }
    } catch {
      // Fall through to defaults on malformed fixtures.
    }
  }
  return [
    { id: "mock-model", provider: "mock-provider", name: "Mock Model", reasoning: true },
    { id: "mock-model-2", provider: "mock-provider", name: "Mock Model 2", reasoning: false },
  ];
}

function readCommands(): Array<Record<string, unknown>> {
  const raw = env.PI_MOCK_COMMANDS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null,
        );
      }
    } catch {
      // Fall through to defaults.
    }
  }
  return [
    { name: "plan", description: "Plan mode", source: "extension" },
    { name: "skill:mock-skill", description: "Mock skill", source: "skill" },
  ];
}

let currentProvider = readArgFlag(["--provider"]) ?? "mock-provider";
let currentModelId = readArgFlag(["--model"]) ?? "mock-model";
let thinkingLevel = readArgFlag(["--thinking"]) ?? "low";
const sessionId = "mock-session-1";
const turnDelayMs = Number(env.PI_MOCK_TURN_DELAY_MS ?? "5");
const replyText = env.PI_MOCK_REPLY_TEXT ?? env.PI_MOCK_TEXT ?? "hello from mock pi";

const send = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const dialogWaiters = new Map<string, (response: Record<string, unknown>) => void>();
let turnInFlight = false;
let abortRequested = false;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function assistantMessage(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: currentProvider,
    model: currentModelId,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
    stopReason: abortRequested ? "aborted" : "stop",
    timestamp: Date.now(),
  };
}

async function runTurn(promptId: string, message: string): Promise<void> {
  turnInFlight = true;
  abortRequested = false;
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  const userMessage = { role: "user", content: message, timestamp: Date.now() };
  send({ type: "message_start", message: userMessage });
  send({ type: "message_end", message: userMessage });

  if (env.PI_MOCK_TOOLS === "1" && !abortRequested) {
    send({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "echo hi" },
    });
    await sleep(2);
    if (!abortRequested) {
      send({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "hi" }] },
        isError: false,
      });
    }
  }

  const dialog = env.PI_MOCK_DIALOG;
  if (dialog && !abortRequested) {
    const dialogId = "dlg-1";
    const base = { type: "extension_ui_request", id: dialogId, method: dialog };
    if (dialog === "select") {
      send({ ...base, title: "Pick one", options: ["Allow", "Block"] });
    } else if (dialog === "confirm") {
      send({ ...base, title: "Confirm?", message: "Are you sure?" });
    } else if (dialog === "input" || dialog === "editor") {
      send({ ...base, title: "Enter value", prefill: "" });
    } else {
      send({ ...base, title: dialog });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      dialogWaiters.set(dialogId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  if (!abortRequested && turnDelayMs > 0) {
    await sleep(turnDelayMs);
  }

  const assistant = assistantMessage(abortRequested ? "" : replyText);
  if (!abortRequested) {
    send({ type: "message_start", message: { role: "assistant", content: [] } });
    const midpoint = Math.ceil(replyText.length / 2);
    send({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: replyText.slice(0, midpoint),
      },
    });
    send({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: replyText.slice(midpoint),
      },
    });
    send({ type: "message_end", message: assistant });
    send({ type: "turn_end", message: assistant, toolResults: [] });
  }
  send({ type: "agent_end", messages: [userMessage, assistant] });
  turnInFlight = false;
  void promptId;
}

function getStateData(): Record<string, unknown> {
  return {
    model: {
      id: currentModelId,
      name: currentModelId,
      api: "openai-completions",
      provider: currentProvider,
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
    },
    thinkingLevel,
    isStreaming: turnInFlight,
    sessionId,
    ...(env.PI_MOCK_SESSION_FILE ? { sessionFile: env.PI_MOCK_SESSION_FILE } : {}),
    messageCount: 0,
  };
}

async function handleCommand(raw: Record<string, unknown>): Promise<void> {
  const type = typeof raw.type === "string" ? raw.type : "";
  const id = typeof raw.id === "string" ? raw.id : undefined;
  const respond = (command: string, success: boolean, data?: unknown, error?: string): void => {
    send({
      type: "response",
      ...(id ? { id } : {}),
      command,
      success,
      ...(data !== undefined ? { data } : {}),
      ...(error ? { error } : {}),
    });
  };

  switch (type) {
    case "extension_ui_response": {
      if (id) {
        const waiter = dialogWaiters.get(id);
        if (waiter) {
          dialogWaiters.delete(id);
          waiter(raw);
        }
      }
      return;
    }
    case "get_state":
      respond("get_state", true, getStateData());
      return;
    case "get_available_models":
      respond("get_available_models", true, { models: readModels() });
      return;
    case "set_model": {
      if (typeof raw.provider === "string" && raw.provider.trim())
        currentProvider = raw.provider.trim();
      if (typeof raw.modelId === "string" && raw.modelId.trim())
        currentModelId = raw.modelId.trim();
      respond("set_model", true, { id: currentModelId, provider: currentProvider });
      return;
    }
    case "set_thinking_level":
      if (typeof raw.level === "string") thinkingLevel = raw.level;
      respond("set_thinking_level", true);
      return;
    case "prompt": {
      if (env.PI_MOCK_PROMPT_FAIL) {
        respond("prompt", false, undefined, env.PI_MOCK_PROMPT_FAIL);
        return;
      }
      // Acknowledge immediately (like real pi) and stream the turn in the
      // background so `abort` and `extension_ui_response` are processed
      // concurrently instead of queueing behind the turn.
      respond("prompt", true);
      const message = typeof raw.message === "string" ? raw.message : "";
      void runTurn(id ?? "prompt", message).catch(() => undefined);
      return;
    }
    case "steer":
    case "follow_up":
      respond(type, true);
      return;
    case "abort":
      abortRequested = true;
      respond("abort", true);
      return;
    case "new_session":
      respond("new_session", true, { cancelled: false });
      return;
    case "switch_session":
      respond("switch_session", true, { cancelled: false });
      return;
    case "get_messages":
      respond("get_messages", true, { messages: [] });
      return;
    case "get_session_stats":
      respond("get_session_stats", true, { sessionId, tokens: { input: 0, output: 0, total: 0 } });
      return;
    case "get_commands":
      respond("get_commands", true, { commands: readCommands() });
      return;
    case "get_last_assistant_text":
      respond("get_last_assistant_text", true, { text: replyText });
      return;
    case "compact":
      respond("compact", true, {
        summary: "mock summary",
        firstKeptEntryId: "abc",
        tokensBefore: 10,
      });
      return;
    case "get_fork_messages":
      respond("get_fork_messages", true, { messages: [] });
      return;
    default:
      respond(type || "unknown", false, undefined, `Unknown mock command: ${type}`);
  }
}

const rl = NodeReadline.createInterface({ input: process.stdin });
let queue: Promise<void> = Promise.resolve();
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  logRequest(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  queue = queue.then(() => handleCommand(parsed as Record<string, unknown>));
});

process.on("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});
process.on("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});
