#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- Test double runs on bare Node without Effect.
// @effect-diagnostics globalRandom:off -- Mock dialog ids only need uniqueness, not randomness.
// @effect-diagnostics globalTimers:off -- Test double drives its own dialog timeouts.
// pi-mock-agent.ts — fake `pi --mode rpc` / `omp --mode rpc` peer for
// OmpAdapter / OmpProvider integration tests.
//
// Modes:
//   --version        print T3_PI_VERSION (default "0.73.1"), exit 0
//   --list-models    print T3_PI_LIST_MODELS_TEXT or a model list, exit 0
//   --mode rpc       JSONL RPC loop on stdio
//   -p/--print       print T3_PI_PRINT_TEXT (default canned text), exit 0/1
//
// RPC behavior is driven by environment toggles (all optional):
//   T3_PI_LOG_PATH            append every inbound command as JSONL
//   T3_PI_MODELS              JSON array for get_available_models
//   T3_PI_MODELS_ERROR        when "1", get_available_models fails
//   T3_PI_COMMANDS            JSON array for get_commands
//   T3_PI_MODEL_ID            current model id for get_state (default "test-provider/test-model")
//   T3_PI_SESSION_ID          session id for get_state (default "mock-session-1")
//   T3_PI_RESPONSE_TEXT       assistant text for prompt runs (default "mock reply")
//   T3_PI_EMIT_TOOL           when "1", emit a bash tool_execution triple per prompt
//   T3_PI_DIALOG              when "select"|"confirm"|"input", emit that dialog per prompt
//   T3_PI_DIALOG_LOG_PATH     append received extension_ui_response frames as JSONL
//   T3_PI_HANG_PROMPT         when "1", accept prompts but never emit agent_end
//   T3_PI_REJECT_PROMPT       when "1", reject prompts with "No API key found for test-provider."
//   T3_PI_PROMPT_DELAY_MS     delay before emitting agent events
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const args = process.argv.slice(2);

const DEFAULT_MODELS = [
  { id: "test-model", name: "Test Model", provider: "test-provider", contextWindow: 200000 },
  {
    id: "test-model-mini",
    name: "Test Model Mini",
    provider: "test-provider",
    contextWindow: 128000,
  },
];

const DEFAULT_COMMANDS = [
  // Newer harnesses nest file metadata in sourceInfo (mirrors real pi).
  {
    name: "skill:brave-search",
    description: "Web search",
    source: "skill",
    sourceInfo: { path: "/mock/skills/brave-search/SKILL.md", scope: "project" },
  },
  {
    name: "fix-tests",
    description: "Fix failing tests",
    source: "prompt",
    location: "project",
    path: "/mock/prompts/fix-tests.md",
  },
];

let currentModelId = process.env.T3_PI_MODEL_ID ?? "test-model";
let currentProvider = "test-provider";
{
  const slash = currentModelId.indexOf("/");
  if (slash > 0) {
    currentProvider = currentModelId.slice(0, slash);
    currentModelId = currentModelId.slice(slash + 1);
  }
}

function logInbound(command: unknown) {
  const logPath = process.env.T3_PI_LOG_PATH;
  if (!logPath) return;
  NodeFS.appendFileSync(logPath, `${JSON.stringify(command)}\n`, "utf8");
}

function logDialog(frame: unknown) {
  const logPath = process.env.T3_PI_DIALOG_LOG_PATH;
  if (!logPath) return;
  NodeFS.appendFileSync(logPath, `${JSON.stringify(frame)}\n`, "utf8");
}

if (args.includes("--version")) {
  process.stdout.write(`${process.env.T3_PI_VERSION ?? "0.73.1"}\n`);
  process.exit(0);
}

if (args.includes("--list-models")) {
  const text = process.env.T3_PI_LIST_MODELS_TEXT;
  if (text !== undefined) {
    process.stdout.write(`${text}\n`);
  } else {
    process.stdout.write(
      "Available models:\n  * test-provider/test-model (default)\n  - test-provider/test-model-mini\n",
    );
  }
  process.exit(0);
}

if (args.includes("-p") || args.includes("--print") || args.includes("-print")) {
  const text = process.env.T3_PI_PRINT_TEXT ?? "mock response text";
  process.stdout.write(`${text}\n`);
  process.exit(Number(process.env.T3_PI_PRINT_EXIT ?? "0"));
}

if (!args.includes("--mode") || args[args.indexOf("--mode") + 1] !== "rpc") {
  process.stderr.write(`pi-mock-agent: unsupported args ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const out = (obj: unknown) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};
const success = (id: unknown, command: string, data?: unknown) =>
  data === undefined
    ? out({ id, type: "response", command, success: true })
    : out({ id, type: "response", command, success: true, data });
const failure = (id: unknown, command: string, message: string) =>
  out({ id, type: "response", command, success: false, error: message });

function catalog(): Array<Record<string, unknown>> {
  if ((process.env.T3_PI_MODELS ?? "").trim()) {
    try {
      const parsed = JSON.parse(process.env.T3_PI_MODELS ?? "[]") as unknown;
      if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    } catch {
      // fall through to defaults
    }
  }
  return DEFAULT_MODELS.map((model) => ({ ...model }));
}

function commands(): Array<Record<string, unknown>> {
  if ((process.env.T3_PI_COMMANDS ?? "").trim()) {
    try {
      const parsed = JSON.parse(process.env.T3_PI_COMMANDS ?? "[]") as unknown;
      if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>;
    } catch {
      // fall through to defaults
    }
  }
  return DEFAULT_COMMANDS.map((command) => ({ ...command }));
}

const pendingDialogs = new Map<string, (response: Record<string, unknown>) => void>();

function emitDialog(kind: string) {
  const id = `dlg-${Math.random().toString(36).slice(2)}`;
  return new Promise<Record<string, unknown> | undefined>((resolve) => {
    const timer = setTimeout(() => {
      pendingDialogs.delete(id);
      resolve(undefined);
    }, 5000);
    pendingDialogs.set(id, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    if (kind === "select") {
      out({
        type: "extension_ui_request",
        id,
        method: "select",
        title: "Pick one",
        options: [
          { label: "Alpha", description: "First" },
          { label: "Beta", description: "Second" },
        ],
      });
    } else if (kind === "confirm") {
      out({
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: "Are you sure?",
        message: "Proceed?",
      });
    } else {
      out({
        type: "extension_ui_request",
        id,
        method: "input",
        title: "Your name",
        placeholder: "Name",
      });
    }
  });
}

async function runPrompt(command: Record<string, unknown>) {
  const delayMs = Number(process.env.T3_PI_PROMPT_DELAY_MS ?? "0");
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (process.env.T3_PI_HANG_PROMPT === "1") return;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  const text = process.env.T3_PI_RESPONSE_TEXT ?? "mock reply";
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text }] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  });
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  if (process.env.T3_PI_EMIT_TOOL === "1") {
    const toolCallId = "call_mock_1";
    out({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "ls" } });
    out({
      type: "tool_execution_end",
      toolCallId,
      toolName: "bash",
      result: { content: [{ type: "text", text: "mock-output" }] },
      isError: false,
    });
  }
  const dialog = process.env.T3_PI_DIALOG;
  if (dialog === "select" || dialog === "confirm" || dialog === "input") {
    await emitDialog(dialog);
  }
  out({
    type: "turn_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
    toolResults: [],
  });
  out({
    type: "agent_end",
    messages: [
      { role: "user", content: typeof command.message === "string" ? command.message : "" },
      { role: "assistant", content: [{ type: "text", text }] },
    ],
  });
}

async function handleCommand(command: Record<string, unknown>) {
  const id = command.id;
  const type = command.type;
  switch (type) {
    case "get_state":
      return success(id, "get_state", {
        model: { id: currentModelId, name: "Mock Model", provider: currentProvider },
        thinkingLevel: "low",
        isStreaming: false,
        isCompacting: false,
        sessionId: process.env.T3_PI_SESSION_ID ?? "mock-session-1",
        messageCount: 0,
      });
    case "get_available_models":
      if (process.env.T3_PI_MODELS_ERROR === "1") {
        return failure(id, "get_available_models", "No API key found for test-provider.");
      }
      return success(id, "get_available_models", { models: catalog() });
    case "get_commands":
      return success(id, "get_commands", { commands: commands() });
    case "set_model": {
      const found = catalog().find(
        (model) => model.provider === command.provider && model.id === command.modelId,
      );
      if (!found) {
        return failure(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
      }
      currentProvider = String(found.provider ?? currentProvider);
      currentModelId = String(found.id ?? currentModelId);
      return success(id, "set_model", found);
    }
    case "set_thinking_level":
    case "set_session_name":
    case "set_steering_mode":
    case "set_follow_up_mode":
    case "set_auto_compaction":
    case "set_auto_retry":
    case "abort":
    case "abort_retry":
    case "abort_bash":
    case "new_session":
    case "compact":
    case "clone":
      return success(id, String(type), {});
    case "prompt": {
      if (process.env.T3_PI_REJECT_PROMPT === "1") {
        return failure(id, "prompt", "No API key found for test-provider.");
      }
      // Preflight acceptance first (mirrors the real harness), run async.
      success(id, "prompt");
      await runPrompt(command);
      return undefined;
    }
    case "steer":
    case "follow_up":
      success(id, String(type));
      await runPrompt(command);
      return undefined;
    default:
      return failure(id, String(type), `pi-mock-agent: unknown command ${String(type)}`);
  }
}

async function main() {
  const rl = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === "extension_ui_response"
    ) {
      logDialog(parsed);
      const pending = pendingDialogs.get(String((parsed as Record<string, unknown>).id ?? ""));
      if (pending) {
        pendingDialogs.delete(String((parsed as Record<string, unknown>).id ?? ""));
        pending(parsed as Record<string, unknown>);
      }
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const command = parsed as Record<string, unknown>;
    logInbound(command);
    try {
      await handleCommand(command);
    } catch (error) {
      failure(
        command.id,
        String(command.type ?? "unknown"),
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

void main();
