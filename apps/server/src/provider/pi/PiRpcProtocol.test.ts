import { describe, expect, it } from "@effect/vitest";

import {
  buildPromptCommand,
  buildPiModelsFromDiscovery,
  deltaFromMessageUpdate,
  extractSkillNames,
  extractSlashCommands,
  isPiRpcEvent,
  isPiRpcResponse,
  isPiThinkingLevel,
  isThinkingDelta,
  lastAssistantText,
  parseAvailableModels,
  parseCommandDescriptors,
  parseMissingApiKeyProvider,
  parseRpcLine,
  parseSessionState,
  PiRpcLineParseError,
  splitProviderModel,
  textFromAgentMessage,
  toolCallFromToolEvent,
} from "./PiRpcProtocol.ts";

describe("PiRpcProtocol", () => {
  it("builds prompt commands with ids, images, and streaming behavior", () => {
    expect(buildPromptCommand({ message: "hi" })).toEqual({ type: "prompt", message: "hi" });
    expect(
      buildPromptCommand({
        message: "hi",
        images: [{ type: "image", data: "abc", mimeType: "image/png" }],
        streamingBehavior: "steer",
        id: "req-1",
      }),
    ).toEqual({
      type: "prompt",
      message: "hi",
      images: [{ type: "image", data: "abc", mimeType: "image/png" }],
      streamingBehavior: "steer",
      id: "req-1",
    });
  });

  it("parses responses, events, and blank lines", () => {
    expect(parseRpcLine("")).toBeUndefined();
    expect(parseRpcLine("   \n")).toBeUndefined();
    const response = parseRpcLine(
      `{"type":"response","command":"get_state","success":true,"id":"r1","data":{}}`,
    );
    expect(isPiRpcResponse(response)).toBe(true);
    const event = parseRpcLine(`{"type":"turn_start"}`);
    expect(isPiRpcEvent(event)).toBe(true);
    expect(isPiRpcResponse(event)).toBe(false);
  });

  it("rejects malformed lines and unknown record types", () => {
    expect(() => parseRpcLine("{nope")).toThrow(PiRpcLineParseError);
    expect(() => parseRpcLine(`{"type":"nope"}`)).toThrow(PiRpcLineParseError);
    expect(() => parseRpcLine(`[1,2]`)).toThrow(PiRpcLineParseError);
  });

  it("parses session state", () => {
    expect(parseSessionState(undefined)).toBeUndefined();
    expect(parseSessionState({})).toEqual({ model: null, isStreaming: false, isCompacting: false });
    expect(
      parseSessionState({
        model: { id: "anthropic/claude-opus-4-6", name: "Opus" },
        thinkingLevel: "high",
        isStreaming: true,
        sessionId: "abc",
        sessionFile: "/tmp/s.jsonl",
        messageCount: 4,
      }),
    ).toEqual({
      model: { id: "anthropic/claude-opus-4-6", name: "Opus" },
      thinkingLevel: "high",
      isStreaming: true,
      isCompacting: false,
      sessionId: "abc",
      sessionFile: "/tmp/s.jsonl",
      messageCount: 4,
    });
  });

  it("parses available models, skipping invalid entries", () => {
    expect(parseAvailableModels({})).toEqual([]);
    expect(parseAvailableModels({ models: [{ id: " a " }, { id: "" }, { nope: 1 }, "x"] })).toEqual(
      [{ id: "a" }],
    );
  });

  it("extracts skill and slash commands from get_commands", () => {
    const commands = parseCommandDescriptors({
      commands: [
        { name: "skill:brave-search", description: "Search", source: "skill", path: "/s/SKILL.md" },
        { name: "skill:brave-search", description: "dup", source: "skill" },
        { name: "fix-tests", description: "Fix", source: "prompt" },
        { name: "/leading-slash", source: "prompt" },
        { name: "session-name", source: "extension" },
        { name: "", source: "skill" },
      ],
    });
    expect(extractSkillNames(commands)).toEqual([
      { name: "brave-search", description: "Search", path: "/s/SKILL.md" },
    ]);
    expect(extractSlashCommands(commands)).toEqual([
      { name: "fix-tests", description: "Fix" },
      { name: "leading-slash" },
    ]);
  });

  it("reads file metadata from nested sourceInfo", () => {
    const commands = parseCommandDescriptors({
      commands: [
        {
          name: "skill:search",
          description: "Search",
          source: "skill",
          sourceInfo: { path: "/s/SKILL.md", scope: "project" },
        },
      ],
    });
    expect(commands).toEqual([
      {
        name: "skill:search",
        description: "Search",
        source: "skill",
        location: "project",
        path: "/s/SKILL.md",
      },
    ]);
    expect(extractSkillNames(commands)).toEqual([
      { name: "search", description: "Search", path: "/s/SKILL.md", location: "project" },
    ]);
  });

  it("extracts assistant text and deltas", () => {
    expect(textFromAgentMessage({ role: "assistant", content: "hello" })).toBe("hello");
    expect(
      textFromAgentMessage({
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "image", data: "x" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
    expect(textFromAgentMessage(undefined)).toBe("");
    expect(
      lastAssistantText([
        { role: "user", content: "hi" },
        { role: "assistant", content: "first" },
        { role: "assistant", content: "  " },
        { role: "assistant", content: [{ type: "text", text: "second" }] },
      ]),
    ).toBe("second");
    expect(lastAssistantText([])).toBeUndefined();
    expect(
      deltaFromMessageUpdate({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hi" },
      }),
    ).toBe("Hi");
    expect(
      isThinkingDelta({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
      }),
    ).toBe(true);
    expect(
      deltaFromMessageUpdate({ type: "message_update", assistantMessageEvent: { type: "done" } }),
    ).toBeUndefined();
  });

  it("extracts tool calls from tool events", () => {
    expect(
      toolCallFromToolEvent({
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "ls" },
      }),
    ).toEqual({ toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    expect(toolCallFromToolEvent({ type: "tool_execution_start" })).toBeUndefined();
  });

  it("detects missing-API-key provider names", () => {
    expect(parseMissingApiKeyProvider("No API key found for opencode-go.\n\nUse /login")).toBe(
      "opencode-go",
    );
    expect(parseMissingApiKeyProvider("all good")).toBeUndefined();
  });

  it("validates thinking levels and splits provider/model ids", () => {
    expect(isPiThinkingLevel("high")).toBe(true);
    expect(isPiThinkingLevel("ultra")).toBe(false);
    expect(splitProviderModel("openai/gpt-4o")).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(splitProviderModel("gpt-4o")).toEqual({ modelId: "gpt-4o" });
  });

  it("never surfaces the t3-backend harness bucket as subProvider", () => {
    const models = buildPiModelsFromDiscovery({
      models: [
        { id: "gpt-5.6", provider: "t3-backend" },
        { id: "opencode-go/kimi-k3", provider: "t3-backend" },
        { id: "claude-opus-4-7", provider: "anthropic" },
      ],
    });
    expect(models.map(({ slug, name, subProvider }) => ({ slug, name, subProvider }))).toEqual([
      { slug: "t3-backend/gpt-5.6", name: "gpt-5.6", subProvider: undefined },
      {
        slug: "t3-backend/opencode-go/kimi-k3",
        name: "kimi-k3",
        subProvider: "opencode-go",
      },
      {
        slug: "anthropic/claude-opus-4-7",
        name: "claude-opus-4-7",
        subProvider: "anthropic",
      },
    ]);
  });

  it("degrades a stale bucket-prefixed discovery id to the bare model", () => {
    const models = buildPiModelsFromDiscovery({
      models: [{ id: "t3-backend/probe-go", provider: "t3-backend" }],
    });
    expect(models.map(({ slug, name, subProvider }) => ({ slug, name, subProvider }))).toEqual([
      { slug: "t3-backend/t3-backend/probe-go", name: "probe-go", subProvider: undefined },
    ]);
  });
});
