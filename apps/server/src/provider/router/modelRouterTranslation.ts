/**
 * Pure wire-format translation between the Anthropic Messages API and the
 * OpenAI Chat Completions API — requests, non-streaming responses, and SSE
 * streams. No HTTP, no Effect; everything here is exercised directly by unit
 * tests with recorded payloads.
 *
 * Coverage is the 1:1 common denominator of the two formats:
 *
 *   mapped    system prompt ↔ system role message, user/assistant messages,
 *             text blocks ↔ string/array content, tool definitions
 *             (`input_schema` ↔ `function.parameters`), tool_use/tool_result
 *             blocks ↔ `tool_calls`/`role:"tool"` messages, max_tokens,
 *             stop_sequences ↔ stop, temperature, top_p, tool_choice,
 *             streaming chunks (message_start/content_block_delta/
 *             message_stop ↔ chat.completion.chunk/[DONE]) and usage counts.
 *
 *   dropped   thinking blocks, prompt caching, images and any other content
 *             block type, `metadata`, `response_format`/`tool_choice:"none"`
 *             nuances, penalties/seed/logprobs, and unknown fields — a
 *             cross-protocol harness needing those is out of scope, and a
 *             dropped field degrades to plain text rather than erroring.
 *
 * Chat Completions ↔ Responses (OpenAI's two dialects) covers the
 * `codex-oauth` upstream, whose backend only serves `/responses`:
 *
 *   mapped    system messages → `instructions`, user/assistant messages,
 *             text/image parts, tool definitions and tool_choice, assistant
 *             `tool_calls` ↔ `function_call` items, `role:"tool"` messages ↔
 *             `function_call_output`, `parallel_tool_calls`,
 *             `response_format` ↔ `text.format`, usage counts, finish
 *             reasons, streaming text and function-argument deltas.
 *
 *   dropped   temperature, top_p, max_tokens, stop sequences, n, seed,
 *             penalties, logit_bias, logprobs, reasoning summaries, and
 *             unknown content part types — the backend answers `400
 *             Unsupported parameter` for sampling and budget knobs, so they
 *             never go upstream; the rest follows the degrade-to-text policy
 *             above.
 *
 * Same-protocol traffic never enters this module: the proxy pipes those
 * bytes through untouched.
 *
 * @module provider/router/modelRouterTranslation
 */
import * as Predicate from "effect/Predicate";

// ── shared guards ────────────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(value) ? value : undefined;

const asArray = (value: unknown): ReadonlyArray<unknown> | undefined =>
  Array.isArray(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  Predicate.isString(value) ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  Predicate.isNumber(value) ? value : undefined;

const textOf = (value: unknown): string => asString(value) ?? "";

/** OpenAI tool arguments are JSON text; malformed args degrade to `{}`. */
const parseJsonObject = (value: unknown): Record<string, unknown> => {
  if (!Predicate.isString(value) || value.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(value);
  return asRecord(parsed) ?? {};
};

// ── request: Anthropic Messages → OpenAI Chat Completions ───────────────────

interface OpenAIMessage {
  readonly role: string;
  readonly content: string | null | ReadonlyArray<Record<string, unknown>>;
  readonly tool_calls?: ReadonlyArray<Record<string, unknown>>;
  readonly tool_call_id?: string;
}

const anthropicBlocksToOpenAIContent = (blocks: ReadonlyArray<unknown>): string => {
  const texts: Array<string> = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record?.type === "text") texts.push(textOf(record.text));
  }
  return texts.join("");
};

export const anthropicRequestToOpenAI = (
  body: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> => {
  const messages: Array<OpenAIMessage> = [];

  // System prompt: string or text blocks → a leading system message.
  const system = body.system;
  if (Predicate.isString(system)) {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = anthropicBlocksToOpenAIContent(system);
    if (text.length > 0) messages.push({ role: "system", content: text });
  }

  for (const entry of asArray(body.messages) ?? []) {
    const message = asRecord(entry);
    if (message === undefined) continue;
    const role = asString(message.role);
    const content = message.content;
    if (role === "user") {
      // tool_result blocks must come first so they directly follow the
      // assistant tool_use turn, mirroring Anthropic's own ordering rule.
      if (Array.isArray(content)) {
        const texts: Array<string> = [];
        for (const block of content) {
          const record = asRecord(block);
          if (record?.type === "tool_result") {
            messages.push({
              role: "tool",
              content: anthropicToolResultText(record),
              tool_call_id: asString(record.tool_use_id) ?? "",
            });
          } else if (record?.type === "text") {
            texts.push(textOf(record.text));
          }
        }
        if (texts.length > 0) {
          messages.push({ role: "user", content: texts.join("") });
        }
      } else {
        messages.push({ role: "user", content: textOf(content) });
      }
    } else if (role === "assistant") {
      const toolCalls: Array<Record<string, unknown>> = [];
      let text = "";
      if (Array.isArray(content)) {
        text = anthropicBlocksToOpenAIContent(content);
        for (const block of content) {
          const record = asRecord(block);
          if (record?.type === "tool_use") {
            toolCalls.push({
              id: asString(record.id) ?? "",
              type: "function",
              function: {
                name: asString(record.name) ?? "",
                arguments: JSON.stringify(record.input ?? {}),
              },
            });
          }
        }
      } else {
        text = textOf(content);
      }
      messages.push({
        role: "assistant",
        ...(toolCalls.length > 0
          ? { tool_calls: toolCalls, content: text.length > 0 ? text : null }
          : { content: text }),
      });
    }
  }

  const tools = toolsToOpenAI(asArray(body.tools));
  return {
    model: upstreamModel,
    messages,
    ...(Predicate.isNumber(body.max_tokens) ? { max_tokens: body.max_tokens } : {}),
    ...(Predicate.isNumber(body.temperature) ? { temperature: body.temperature } : {}),
    ...(Predicate.isNumber(body.top_p) ? { top_p: body.top_p } : {}),
    ...(asArray(body.stop_sequences) !== undefined ? { stop: asArray(body.stop_sequences) } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...anthropicToolChoiceToOpenAI(body.tool_choice),
  };
};

const anthropicToolResultText = (block: Record<string, unknown>): string => {
  const content = block.content;
  if (Predicate.isString(content)) return content;
  if (Array.isArray(content)) return anthropicBlocksToOpenAIContent(content);
  return "";
};

const toolsToOpenAI = (
  tools: ReadonlyArray<unknown> | undefined,
): ReadonlyArray<Record<string, unknown>> | undefined => {
  if (tools === undefined) return undefined;
  const mapped = tools.flatMap((entry) => {
    const tool = asRecord(entry);
    if (tool === undefined) return [];
    return [
      {
        type: "function",
        function: {
          name: asString(tool.name) ?? "",
          ...(tool.description !== undefined
            ? { description: asString(tool.description) ?? "" }
            : {}),
          parameters: asRecord(tool.input_schema) ?? {},
        },
      },
    ];
  });
  return mapped.length > 0 ? mapped : undefined;
};

const anthropicToolChoiceToOpenAI = (choice: unknown): Record<string, unknown> => {
  const record = asRecord(choice);
  if (record?.type === "any") return { tool_choice: "required" };
  if (record?.type === "tool") {
    return {
      tool_choice: { type: "function", function: { name: asString(record.name) ?? "" } },
    };
  }
  // `auto` is the OpenAI default and omitted; "none" has no faithful mapping
  // (Anthropic cannot forbid tool use while still sending tool definitions).
  return {};
};

// ── request: OpenAI Chat Completions → Anthropic Messages ───────────────────

/** Anthropic rejects `max_tokens: 0`; a missing value needs a real budget. */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

export const openAIRequestToAnthropic = (
  body: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> => {
  const messages: Array<Record<string, unknown>> = [];
  const systemParts: Array<string> = [];
  // Consecutive `role:"tool"` messages group into one user message holding
  // all tool_result blocks, as Anthropic expects them immediately after the
  // assistant tool_use turn.
  let pendingToolResults: Array<Record<string, unknown>> | undefined = undefined;
  const flushToolResults = () => {
    if (pendingToolResults === undefined) return;
    messages.push({ role: "user", content: pendingToolResults });
    pendingToolResults = undefined;
  };

  for (const entry of asArray(body.messages) ?? []) {
    const message = asRecord(entry);
    if (message === undefined) continue;
    const role = asString(message.role);
    if (role === "system" || role === "developer") {
      flushToolResults();
      systemParts.push(openAIContentText(message.content));
    } else if (role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: asString(message.tool_call_id) ?? "",
        content: openAIContentText(message.content),
      };
      if (pendingToolResults === undefined) pendingToolResults = [block];
      else pendingToolResults.push(block);
    } else if (role === "assistant") {
      flushToolResults();
      const blocks: Array<Record<string, unknown>> = [];
      const text = openAIContentText(message.content);
      if (text.length > 0) blocks.push({ type: "text", text });
      for (const toolCall of asArray(message.tool_calls) ?? []) {
        const call = asRecord(toolCall);
        const fn = asRecord(call?.function);
        if (fn === undefined) continue;
        blocks.push({
          type: "tool_use",
          id: asString(call?.id) ?? `toolu_${blocks.length}`,
          name: asString(fn.name) ?? "",
          input: parseJsonObject(fn.arguments),
        });
      }
      messages.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : text,
      });
    } else if (role === "user") {
      flushToolResults();
      const parts = asArray(message.content);
      if (parts === undefined) {
        messages.push({ role: "user", content: openAIContentText(message.content) });
      } else {
        const blocks = parts.flatMap((part) => {
          const record = asRecord(part);
          if (record?.type === "text") return [{ type: "text", text: textOf(record.text) }];
          return []; // image_url and friends: dropped, see module docs.
        });
        messages.push({ role: "user", content: blocks.length > 0 ? blocks : "" });
      }
    }
  }
  flushToolResults();

  const system = systemParts.join("\n\n");
  const maxTokens =
    asNumber(body.max_tokens) ??
    asNumber(body.max_completion_tokens) ??
    DEFAULT_ANTHROPIC_MAX_TOKENS;
  const stop = asString(body.stop);
  const stopList = asArray(body.stop);
  return {
    model: upstreamModel,
    max_tokens: maxTokens,
    ...(system.length > 0 ? { system } : {}),
    messages,
    ...(asNumber(body.temperature) !== undefined
      ? { temperature: asNumber(body.temperature) }
      : {}),
    ...(asNumber(body.top_p) !== undefined ? { top_p: asNumber(body.top_p) } : {}),
    ...(stop !== undefined
      ? { stop_sequences: [stop] }
      : stopList !== undefined
        ? { stop_sequences: stopList.map(textOf) }
        : {}),
    ...openAIToolsToAnthropic(body),
  };
};

const openAIContentText = (content: unknown): string => {
  if (Predicate.isString(content)) return content;
  const parts = asArray(content);
  if (parts === undefined) return "";
  const texts: Array<string> = [];
  for (const part of parts) {
    const record = asRecord(part);
    if (record?.type === "text") texts.push(textOf(record.text));
  }
  return texts.join("");
};

const openAIToolsToAnthropic = (body: Record<string, unknown>): Record<string, unknown> => {
  const tools = asArray(body.tools);
  const mapped =
    tools === undefined
      ? undefined
      : tools.flatMap((entry) => {
          const tool = asRecord(entry);
          const fn = asRecord(tool?.function);
          if (tool?.type !== "function" || fn === undefined) return [];
          return [
            {
              name: asString(fn.name) ?? "",
              ...(fn.description !== undefined
                ? { description: asString(fn.description) ?? "" }
                : {}),
              input_schema: asRecord(fn.parameters) ?? { type: "object", properties: {} },
            },
          ];
        });
  const choice = body.tool_choice;
  const choiceRecord = asRecord(choice);
  const choiceFn = asRecord(choiceRecord?.function);
  return {
    ...(mapped !== undefined && mapped.length > 0 ? { tools: mapped } : {}),
    ...(choice === "auto" ? { tool_choice: { type: "auto" } } : {}),
    ...(choice === "required" ? { tool_choice: { type: "any" } } : {}),
    ...(choiceRecord?.type === "function"
      ? { tool_choice: { type: "tool", name: asString(choiceFn?.name) ?? "" } }
      : {}),
  };
};

// ── non-streaming responses ─────────────────────────────────────────────────

export const openAIResponseToAnthropic = (
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const choice = (asArray(body.choices) ?? []).map(asRecord).find((c) => c !== undefined);
  const message = asRecord(choice?.message);
  const blocks: Array<Record<string, unknown>> = [];
  const content = message?.content;
  if (Predicate.isString(content) && content.length > 0) {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      const record = asRecord(part);
      if (record?.type === "text") blocks.push({ type: "text", text: textOf(record.text) });
    }
  }
  for (const toolCall of asArray(message?.tool_calls) ?? []) {
    const call = asRecord(toolCall);
    const fn = asRecord(call?.function);
    if (fn === undefined) continue;
    blocks.push({
      type: "tool_use",
      id: asString(call?.id) ?? `toolu_${blocks.length}`,
      name: asString(fn.name) ?? "",
      input: parseJsonObject(fn.arguments),
    });
  }
  const usage = asRecord(body.usage);
  return {
    id: asString(body.id) ?? "msg_proxy",
    type: "message",
    role: "assistant",
    model: asString(body.model) ?? "",
    content: blocks,
    stop_reason: openAIFinishToAnthropicStop(asString(choice?.finish_reason)),
    stop_sequence: null,
    usage: {
      input_tokens: asNumber(usage?.prompt_tokens) ?? 0,
      output_tokens: asNumber(usage?.completion_tokens) ?? 0,
    },
  };
};

/**
 * Declarative finish/stop-reason maps. The translators below are procedural
 * (ordering rules, stream lifecycles, drop-lists — all live-verified), but
 * these three mappings are pure 1:1 tables, so they live as consts instead
 * of switch statements.
 */
const OPENAI_FINISH_TO_ANTHROPIC_STOP: Record<string, string> = {
  length: "max_tokens",
  tool_calls: "tool_use",
  function: "tool_use",
};

const ANTHROPIC_STOP_TO_OPENAI_FINISH: Record<string, string> = {
  max_tokens: "length",
  tool_use: "tool_calls",
};

const RESPONSES_INCOMPLETE_TO_CHAT_FINISH: Record<string, string> = {
  max_output_tokens: "length",
  content_filter: "content_filter",
};

export const openAIFinishToAnthropicStop = (finish: string | undefined): string =>
  (finish !== undefined ? OPENAI_FINISH_TO_ANTHROPIC_STOP[finish] : undefined) ?? "end_turn";

/**
 * Translate a completed Anthropic message into an OpenAI completion.
 * `createdSeconds` comes from the caller's clock (Effect code passes
 * `Clock`-derived time; tests pass a fixed value).
 */
export const anthropicResponseToOpenAI = (
  body: Record<string, unknown>,
  createdSeconds: number,
): Record<string, unknown> => {
  const texts: Array<string> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of asArray(body.content) ?? []) {
    const record = asRecord(block);
    if (record?.type === "text") {
      texts.push(textOf(record.text));
    } else if (record?.type === "tool_use") {
      toolCalls.push({
        id: asString(record.id) ?? `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: asString(record.name) ?? "",
          arguments: JSON.stringify(record.input ?? {}),
        },
      });
    }
  }
  const content = texts.join("");
  const usage = asRecord(body.usage);
  const promptTokens = asNumber(usage?.input_tokens) ?? 0;
  const completionTokens = asNumber(usage?.output_tokens) ?? 0;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: content.length > 0 ? content : toolCalls.length > 0 ? null : "",
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  return {
    id: asString(body.id) ?? "chatcmpl-proxy",
    object: "chat.completion",
    created: createdSeconds,
    model: asString(body.model) ?? "",
    choices: [
      {
        index: 0,
        message,
        finish_reason: anthropicStopToOpenAIFinish(asString(body.stop_reason)),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
};

export const anthropicStopToOpenAIFinish = (stop: string | undefined): string =>
  (stop !== undefined ? ANTHROPIC_STOP_TO_OPENAI_FINISH[stop] : undefined) ?? "stop";

// ── non-streaming upstream → streaming inbound ──────────────────────────────
// An upstream that answered JSON despite `stream: true` still has to reach an
// SSE-expecting harness as a valid event stream; these wrap one translated
// response object into the minimal well-formed sequence.

export const anthropicMessageToStreamEvents = (
  message: Record<string, unknown>,
): ReadonlyArray<Record<string, unknown>> => {
  const blocks = asArray(message.content) ?? [];
  const events: Array<Record<string, unknown>> = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { ...message, content: [] },
      },
    },
  ];
  blocks.forEach((entry, index) => {
    const block = asRecord(entry);
    if (block === undefined) return;
    events.push({
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: block },
    });
    if (block.type === "text") {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: textOf(block.text) },
        },
      });
    } else if (block.type === "tool_use") {
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
        },
      });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });
  events.push({
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: asString(message.stop_reason) ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: asNumber(asRecord(message.usage)?.output_tokens) ?? 0 },
    },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
};

export const openAICompletionToChunkSequence = (
  completion: Record<string, unknown>,
): ReadonlyArray<Record<string, unknown>> => {
  const choice = (asArray(completion.choices) ?? []).map(asRecord).find((c) => c !== undefined);
  const message = asRecord(choice?.message);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: asString(completion.id) ?? "chatcmpl-proxy",
    object: "chat.completion.chunk",
    created: asNumber(completion.created) ?? 0,
    model: asString(completion.model) ?? "",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  const out: Array<Record<string, unknown>> = [chunk({ role: "assistant" })];
  const text = openAIContentText(message?.content);
  if (text.length > 0) out.push(chunk({ content: text }));
  (asArray(message?.tool_calls) ?? []).forEach((entry, index) => {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    if (fn === undefined) return;
    out.push(
      chunk({
        tool_calls: [
          {
            index,
            id: asString(call?.id) ?? `call_${index}`,
            type: "function",
            function: { name: asString(fn.name) ?? "", arguments: asString(fn.arguments) ?? "" },
          },
        ],
      }),
    );
  });
  out.push(chunk({}, asString(choice?.finish_reason) ?? "stop"));
  return out;
};

// ── SSE streams ─────────────────────────────────────────────────────────────

/** One parsed SSE frame; `event` is absent on OpenAI-style data-only frames. */
export interface SseFrame {
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Incremental `text/event-stream` parser. `push` accepts arbitrary text
 * fragments (chunk boundaries are handled internally) and returns the frames
 * completed by them; `end` flushes a trailing frame without a final blank
 * line. Only `event:`/`data:` fields are interpreted — the proxy ignores
 * comments, ids, and retry hints.
 */
export const createSseParser = () => {
  let buffer = "";
  let eventName: string | undefined = undefined;
  const dataLines: Array<string> = [];

  const dispatch = (): Array<SseFrame> => {
    if (dataLines.length === 0 && eventName === undefined) return [];
    const frame: SseFrame = { event: eventName, data: dataLines.join("\n") };
    eventName = undefined;
    dataLines.length = 0;
    return [frame];
  };

  const handleLine = (line: string): Array<SseFrame> => {
    if (line.length === 0) return dispatch();
    if (line.startsWith(":")) return [];
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
    return [];
  };

  return {
    push(chunk: string): Array<SseFrame> {
      buffer += chunk;
      const frames: Array<SseFrame> = [];
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        frames.push(...handleLine(line));
      }
      return frames;
    },
    end(): Array<SseFrame> {
      const trailing = buffer.length > 0 ? handleLine(buffer.replace(/\r$/, "")) : [];
      return [...trailing, ...dispatch()];
    },
  };
};

/** Anthropic streams carry named events; OpenAI streams are data-only. */
export const encodeSseFrame = (frame: {
  readonly event?: string;
  readonly data: unknown;
}): string =>
  `${frame.event === undefined ? "" : `event: ${frame.event}\n`}data: ${JSON.stringify(frame.data)}\n\n`;

export interface StreamChunkTranslator<T> {
  /** Translate one upstream event; returns the downstream events it yields. */
  readonly push: (input: T) => ReadonlyArray<Record<string, unknown>>;
  /** Flush state when the upstream stream ends (or `[DONE]` arrives). */
  readonly end: () => ReadonlyArray<Record<string, unknown>>;
}

/**
 * Upstream Anthropic SSE events → downstream OpenAI `chat.completion.chunk`
 * payloads. The downstream `[DONE]` sentinel is emitted by the HTTP layer
 * after `end()`, not here.
 */
export const createAnthropicToOpenAIChunkTranslator = (base: {
  readonly id: string;
  readonly model: string;
  readonly created: number;
}): StreamChunkTranslator<Record<string, unknown>> => {
  let started = false;
  let finished = false;
  let nextToolIndex = 0;
  // Anthropic block index → OpenAI tool_calls index for the streaming block.
  const toolBlocks = new Map<number, number>();
  let stopReason: string | undefined = undefined;
  let outputTokens = 0;

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  return {
    push(event) {
      switch (event.type) {
        case "message_start": {
          started = true;
          const message = asRecord(event.message);
          outputTokens = asNumber(asRecord(message?.usage)?.output_tokens) ?? 0;
          return [chunk({ role: "assistant" })];
        }
        case "content_block_start": {
          const block = asRecord(event.content_block);
          if (block?.type !== "tool_use") return [];
          const index = nextToolIndex++;
          toolBlocks.set(asNumber(event.index) ?? index, index);
          return [
            chunk({
              tool_calls: [
                {
                  index,
                  id: asString(block.id) ?? `call_${index}`,
                  type: "function",
                  function: { name: asString(block.name) ?? "", arguments: "" },
                },
              ],
            }),
          ];
        }
        case "content_block_delta": {
          const delta = asRecord(event.delta);
          if (delta?.type === "text_delta" && Predicate.isString(delta.text)) {
            return [chunk({ content: delta.text })];
          }
          if (delta?.type === "input_json_delta") {
            const index = toolBlocks.get(asNumber(event.index) ?? -1);
            if (index === undefined) return [];
            return [
              chunk({
                tool_calls: [
                  { index, function: { arguments: asString(delta.partial_json) ?? "" } },
                ],
              }),
            ];
          }
          return [];
        }
        case "message_delta": {
          const delta = asRecord(event.delta);
          stopReason = anthropicStopToOpenAIFinish(asString(delta?.stop_reason));
          outputTokens = asNumber(asRecord(event.usage)?.output_tokens) ?? outputTokens;
          return [];
        }
        case "message_stop": {
          finished = true;
          return [chunk({}, stopReason ?? "stop")];
        }
        default:
          // ping, content_block_stop, error events: nothing to map.
          return [];
      }
    },
    end() {
      if (!started) return [];
      if (finished) return [];
      // Upstream closed without message_stop — close the stream so the
      // harness sees a finished response instead of a hang.
      return [chunk({}, stopReason ?? "stop")];
    },
  };
};

/**
 * Upstream OpenAI `chat.completion.chunk` payloads → downstream Anthropic
 * SSE events (already shaped as `{event, data}` for the wire writer). The
 * trailing `message_stop` is emitted by `end()`, which the HTTP layer calls
 * on `[DONE]` or upstream close.
 */
export const createOpenAIToAnthropicChunkTranslator = (base: {
  readonly model: string;
  readonly id: string;
}): StreamChunkTranslator<Record<string, unknown>> => {
  let started = false;
  let nextBlockIndex = 0;
  let openTextBlock: number | undefined = undefined;
  const openToolBlocks = new Map<number, number>();
  let finishReason: string | undefined = undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let stopped = false;

  const event = (name: string, data: Record<string, unknown>) => ({ event: name, data });

  const messageStart = () => {
    started = true;
    return event("message_start", {
      type: "message_start",
      message: {
        id: base.id,
        type: "message",
        role: "assistant",
        model: base.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: promptTokens, output_tokens: 0 },
      },
    });
  };

  const closeBlock = (index: number) =>
    event("content_block_stop", { type: "content_block_stop", index });

  const finish = (): ReadonlyArray<Record<string, unknown>> => {
    if (stopped) return [];
    stopped = true;
    const out: Array<Record<string, unknown>> = [];
    if (openTextBlock !== undefined) {
      out.push(closeBlock(openTextBlock));
      openTextBlock = undefined;
    }
    for (const index of [...openToolBlocks.values()].sort((a, b) => a - b)) {
      out.push(closeBlock(index));
    }
    openToolBlocks.clear();
    out.push(
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: finishReason ?? "end_turn", stop_sequence: null },
        usage: { output_tokens: completionTokens },
      }),
      event("message_stop", { type: "message_stop" }),
    );
    return out;
  };

  const handleChoice = (
    choice: Record<string, unknown>,
  ): ReadonlyArray<Record<string, unknown>> => {
    const delta = asRecord(choice.delta);
    const out: Array<Record<string, unknown>> = [];
    if (!started) out.push(messageStart());
    const text = asString(delta?.content);
    if (text !== undefined && text.length > 0) {
      if (openTextBlock === undefined) {
        openTextBlock = nextBlockIndex++;
        out.push(
          event("content_block_start", {
            type: "content_block_start",
            index: openTextBlock,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      out.push(
        event("content_block_delta", {
          type: "content_block_delta",
          index: openTextBlock,
          delta: { type: "text_delta", text },
        }),
      );
    }
    for (const toolCall of asArray(delta?.tool_calls) ?? []) {
      const call = asRecord(toolCall);
      if (call === undefined) continue;
      const openAiIndex = asNumber(call.index) ?? 0;
      let blockIndex = openToolBlocks.get(openAiIndex);
      if (
        blockIndex === undefined &&
        (call.id !== undefined || asRecord(call.function)?.name !== undefined)
      ) {
        blockIndex = nextBlockIndex++;
        openToolBlocks.set(openAiIndex, blockIndex);
        const fn = asRecord(call.function);
        out.push(
          event("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: asString(call.id) ?? `toolu_${blockIndex}`,
              name: asString(fn?.name) ?? "",
              input: {},
            },
          }),
        );
      }
      const argumentsDelta = asString(asRecord(call.function)?.arguments);
      if (blockIndex !== undefined && argumentsDelta !== undefined && argumentsDelta.length > 0) {
        out.push(
          event("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: argumentsDelta },
          }),
        );
      }
    }
    const finishReasonRaw = asString(choice.finish_reason);
    if (finishReasonRaw !== undefined) {
      finishReason = openAIFinishToAnthropicStop(finishReasonRaw);
      out.push(...finish());
    }
    return out;
  };

  return {
    push(chunk) {
      const usage = asRecord(chunk.usage);
      if (usage !== undefined) {
        promptTokens = asNumber(usage.prompt_tokens) ?? promptTokens;
        completionTokens = asNumber(usage.completion_tokens) ?? completionTokens;
      }
      const choices = asArray(chunk.choices);
      if (choices === undefined) {
        // Usage-only trailing chunk (stream_options.include_usage).
        return [];
      }
      const out: Array<Record<string, unknown>> = [];
      for (const choice of choices) {
        const record = asRecord(choice);
        if (record !== undefined) out.push(...handleChoice(record));
      }
      return out;
    },
    end() {
      if (!started) {
        // Empty upstream stream — emit a minimal valid message.
        return [messageStart(), ...finish()];
      }
      return finish();
    },
  };
};

// ── Chat Completions ↔ Responses ─────────────────────────────────────────────
// The ChatGPT backend behind `codex-oauth` routes only serves `/responses`,
// so chat-shaped harnesses ride this translation both ways. Recorded shapes
// come from live `chatgpt.com/backend-api/codex` traffic, not the public
// docs (which describe a wider API than this backend serves).

const chatContentToResponsesParts = (
  content: unknown,
  role?: string,
): Array<Record<string, unknown>> => {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (Predicate.isString(content)) {
    return content.length > 0 ? [{ type: textType, text: content }] : [];
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of asArray(content) ?? []) {
    const record = asRecord(part);
    if (record?.type === "text") {
      const text = textOf(record.text);
      if (text.length > 0) parts.push({ type: textType, text });
    } else if (record?.type === "image_url") {
      const url = asString(asRecord(record.image_url)?.url);
      if (url !== undefined) {
        parts.push({
          type: "input_image",
          image_url: url,
          ...(asString(record.detail) !== undefined ? { detail: record.detail } : {}),
        });
      }
    }
  }
  return parts;
};

const chatToolsToResponses = (
  tools: ReadonlyArray<unknown> | undefined,
): Array<Record<string, unknown>> => {
  const mapped: Array<Record<string, unknown>> = [];
  for (const entry of tools ?? []) {
    const tool = asRecord(entry);
    const fn = asRecord(tool?.function);
    if (tool?.type !== "function" || fn === undefined) continue;
    mapped.push({
      type: "function",
      name: asString(fn.name) ?? "",
      ...(fn.description !== undefined ? { description: textOf(fn.description) } : {}),
      parameters: asRecord(fn.parameters) ?? {},
      ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
    });
  }
  return mapped;
};

const chatToolChoiceToResponses = (choice: unknown): Record<string, unknown> => {
  if (choice === undefined || choice === "auto" || choice === "none" || choice === "required") {
    return choice === undefined ? {} : { tool_choice: choice };
  }
  const record = asRecord(choice);
  const fn = asRecord(record?.function);
  if (record?.type === "function" && fn !== undefined) {
    return { tool_choice: { type: "function", name: asString(fn.name) ?? "" } };
  }
  return {};
};

const chatResponseFormatToResponses = (format: unknown): Record<string, unknown> | undefined => {
  const record = asRecord(format);
  if (record?.type === "json_object") return { type: "json_object" };
  if (record?.type === "json_schema") {
    return {
      type: "json_schema",
      ...(asString(record.name) !== undefined ? { name: record.name } : {}),
      ...(asRecord(record.schema) !== undefined ? { schema: record.schema } : {}),
      ...(typeof record.strict === "boolean" ? { strict: record.strict } : {}),
    };
  }
  return undefined;
};

/**
 * Translate an OpenAI Chat Completions request into a Responses request.
 * `stream` stays with the caller (the proxy forces it for this backend);
 * `store: false` keeps the stateless proxy from persisting conversations on
 * the account.
 *
 * Assistant history may only carry `output_text` parts (input_text 400s on
 * assistant messages, verified live against opencode-go). Text-only
 * assistant turns without tool calls are dropped instead: they restate
 * earlier context the upstream keeps, and re-sending them as output_text
 * risks a forged-prior-output rejection.
 */
export const chatCompletionsRequestToResponses = (
  body: Record<string, unknown>,
  upstreamModel: string,
): Record<string, unknown> => {
  const instructions: Array<string> = [];
  const input: Array<Record<string, unknown>> = [];
  for (const entry of asArray(body.messages) ?? []) {
    const message = asRecord(entry);
    if (message === undefined) continue;
    const role = asString(message.role);
    if (role === "system") {
      const text = openAIContentText(message.content);
      if (text.length > 0) instructions.push(text);
    } else if (role === "developer" || role === "user" || role === "assistant") {
      const parts = chatContentToResponsesParts(message.content, role);
      if (role === "assistant") {
        const toolCalls = asArray(message.tool_calls) ?? [];
        // Assistant history with tool calls rides function_call items; the
        // preceding text is dropped (it restates context the upstream keeps
        // and re-sending it as output_text risks forged-output rejection).
        if (parts.length > 0 && toolCalls.length === 0) continue;
        for (const toolCall of toolCalls) {
          const call = asRecord(toolCall);
          const fn = asRecord(call?.function);
          if (fn === undefined) continue;
          input.push({
            type: "function_call",
            call_id: asString(call?.id) ?? "",
            name: asString(fn.name) ?? "",
            arguments: asString(fn.arguments) ?? "{}",
          });
        }
      } else if (parts.length > 0) {
        input.push({ type: "message", role, content: parts });
      }
    } else if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: asString(message.tool_call_id) ?? "",
        output: openAIContentText(message.content),
      });
    }
  }
  const tools = chatToolsToResponses(asArray(body.tools));
  const textFormat = chatResponseFormatToResponses(body.response_format);
  return {
    model: upstreamModel,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    input,
    store: false,
    ...(tools.length > 0 ? { tools } : {}),
    ...chatToolChoiceToResponses(body.tool_choice),
    // Reasoning effort rides `reasoning_effort` (pi `supportsReasoningEffort`,
    // OpenRouter style) into Responses `reasoning.effort`. `off`/`none` and
    // anything unknown stay home: the backend 400s on unexpected params.
    ...(typeof body.reasoning_effort === "string" &&
    ["minimal", "low", "medium", "high"].includes(body.reasoning_effort)
      ? { reasoning: { effort: body.reasoning_effort } }
      : {}),
    // Sampling and budget knobs (temperature, top_p, max_tokens, stop, n,
    // seed, penalties) never go upstream: the backend answers `400
    // Unsupported parameter` for them, verified live.
    ...(typeof body.parallel_tool_calls === "boolean"
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
    ...(textFormat !== undefined ? { text: { format: textFormat } } : {}),
  };
};

export const responsesStatusToChatFinish = (
  status: string | undefined,
  incompleteReason: string | undefined,
  hasToolCalls: boolean,
): string => {
  if (status === "incomplete") {
    return (
      (incompleteReason !== undefined
        ? RESPONSES_INCOMPLETE_TO_CHAT_FINISH[incompleteReason]
        : undefined) ?? "stop"
    );
  }
  if (hasToolCalls) return "tool_calls";
  return "stop";
};

/**
 * Translate a completed Responses object into a Chat Completion. `items`
 * are the accumulated `output_item.done` payloads — the completed envelope
 * itself can carry an empty `output` while the items only arrived as stream
 * events (seen live with tool-call-only turns).
 */
export const responsesResponseToChatCompletion = (
  response: Record<string, unknown>,
  items: ReadonlyArray<unknown>,
  upstreamModel: string,
  createdSeconds: number,
): Record<string, unknown> => {
  const texts: Array<string> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const entry of items) {
    const item = asRecord(entry);
    if (item?.type === "message") {
      for (const part of asArray(item.content) ?? []) {
        const record = asRecord(part);
        if (record?.type === "output_text") texts.push(textOf(record.text));
        else if (record?.type === "refusal") texts.push(textOf(record.refusal));
      }
    } else if (item?.type === "function_call") {
      toolCalls.push({
        id: asString(item.call_id) ?? `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: asString(item.name) ?? "",
          arguments: asString(item.arguments) ?? "{}",
        },
      });
    }
  }
  const content = texts.join("");
  const usage = asRecord(response.usage);
  const promptTokens = asNumber(usage?.input_tokens) ?? 0;
  const completionTokens = asNumber(usage?.output_tokens) ?? 0;
  return {
    id: `chatcmpl_${asString(response.id) ?? "proxy"}`,
    object: "chat.completion",
    created: asNumber(response.created_at) ?? createdSeconds,
    model: upstreamModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content.length > 0 ? content : toolCalls.length > 0 ? null : "",
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: responsesStatusToChatFinish(
          asString(response.status),
          asString(asRecord(response.incomplete_details)?.reason),
          toolCalls.length > 0,
        ),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: asNumber(usage?.total_tokens) ?? promptTokens + completionTokens,
    },
  };
};

/**
 * Upstream Responses SSE events → downstream OpenAI `chat.completion.chunk`
 * payloads. Mirrors `createAnthropicToOpenAIChunkTranslator`: the downstream
 * `[DONE]` sentinel is emitted by the HTTP layer after `end()`, not here.
 * Mid-stream upstream failures end the stream silently, same as the sibling
 * translators — the non-streaming path surfaces them as 502 instead.
 */
export const createResponsesToOpenAIChunkTranslator = (base: {
  readonly id: string;
  readonly model: string;
  readonly created: number;
  readonly includeUsage?: boolean | undefined;
}): StreamChunkTranslator<Record<string, unknown>> => {
  let started = false;
  let finished = false;
  let finishReason: string | undefined = undefined;
  let sawToolCalls = false;
  let nextToolIndex = 0;
  let usage: Record<string, unknown> | undefined = undefined;
  // Responses `output_index` → chat `tool_calls` index for the stream.
  const toolCalls = new Map<number, { readonly index: number; readonly callId: string }>();

  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: base.id,
    object: "chat.completion.chunk",
    created: base.created,
    model: base.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  const ensureStarted = (): ReadonlyArray<Record<string, unknown>> => {
    if (started) return [];
    started = true;
    return [chunk({ role: "assistant" })];
  };

  const toolEntryFor = (outputIndex: number | undefined): { index: number; callId: string } => {
    const known = outputIndex === undefined ? undefined : toolCalls.get(outputIndex);
    if (known !== undefined) return known;
    if (outputIndex === undefined && toolCalls.size === 1) {
      return [...toolCalls.values()][0]!;
    }
    const entry = { index: nextToolIndex++, callId: "" };
    toolCalls.set(outputIndex ?? -1 - entry.index, entry);
    return entry;
  };

  return {
    push(event) {
      switch (event.type) {
        case "response.created":
        case "response.in_progress":
          return ensureStarted();
        case "response.output_item.added": {
          const item = asRecord(event.item);
          if (item?.type !== "function_call") return ensureStarted();
          const outputIndex = asNumber(event.output_index);
          const known = outputIndex === undefined ? undefined : toolCalls.get(outputIndex);
          const index = known?.index ?? nextToolIndex++;
          const entry = {
            index,
            callId: asString(item.call_id) ?? known?.callId ?? "",
          };
          if (outputIndex !== undefined) toolCalls.set(outputIndex, entry);
          else toolCalls.set(-1 - index, entry);
          sawToolCalls = true;
          return [
            ...ensureStarted(),
            chunk({
              tool_calls: [
                {
                  index,
                  id: entry.callId.length > 0 ? entry.callId : `call_${index}`,
                  type: "function",
                  function: { name: asString(item.name) ?? "", arguments: "" },
                },
              ],
            }),
          ];
        }
        case "response.output_text.delta": {
          const delta = asString(event.delta);
          if (delta === undefined || delta.length === 0) return ensureStarted();
          return [...ensureStarted(), chunk({ content: delta })];
        }
        case "response.function_call_arguments.delta": {
          const delta = asString(event.delta);
          const entry = toolEntryFor(asNumber(event.output_index));
          sawToolCalls = true;
          if (delta === undefined || delta.length === 0) return ensureStarted();
          return [
            ...ensureStarted(),
            chunk({ tool_calls: [{ index: entry.index, function: { arguments: delta } }] }),
          ];
        }
        case "response.completed": {
          const response = asRecord(event.response);
          finished = true;
          if (asString(response?.status) === "failed") return [];
          const usageRecord = asRecord(response?.usage);
          if (usageRecord !== undefined) {
            usage = {
              prompt_tokens: asNumber(usageRecord.input_tokens) ?? 0,
              completion_tokens: asNumber(usageRecord.output_tokens) ?? 0,
              total_tokens: asNumber(usageRecord.total_tokens) ?? 0,
            };
          }
          finishReason = responsesStatusToChatFinish(
            asString(response?.status),
            asString(asRecord(response?.incomplete_details)?.reason),
            sawToolCalls,
          );
          return [chunk({}, finishReason)];
        }
        default:
          // done events, failures, and unknown frames: nothing to map.
          return [];
      }
    },
    end() {
      const out: Array<Record<string, unknown>> = [];
      if (!started) return out;
      if (!finished) {
        // Upstream closed without response.completed — close the stream so
        // the harness sees a finished response instead of a hang.
        out.push(chunk({}, finishReason ?? (sawToolCalls ? "tool_calls" : "stop")));
      }
      if (base.includeUsage === true && usage !== undefined) {
        out.push({
          id: base.id,
          object: "chat.completion.chunk",
          created: base.created,
          model: base.model,
          choices: [],
          usage,
        });
      }
      return out;
    },
  };
};
