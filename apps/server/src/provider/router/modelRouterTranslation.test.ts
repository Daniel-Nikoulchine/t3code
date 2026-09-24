import { describe, expect, it } from "vite-plus/test";

import {
  anthropicMessageToStreamEvents,
  anthropicRequestToOpenAI,
  anthropicResponseToOpenAI,
  chatCompletionsRequestToResponses,
  createAnthropicToOpenAIChunkTranslator,
  createOpenAIToAnthropicChunkTranslator,
  createResponsesToOpenAIChunkTranslator,
  createSseParser,
  encodeSseFrame,
  openAICompletionToChunkSequence,
  openAIRequestToAnthropic,
  openAIResponseToAnthropic,
  responsesResponseToChatCompletion,
} from "./modelRouterTranslation.ts";

/** Typed view over OpenAI completion/chunk payloads for assertions. */
interface CompletionLike {
  readonly choices?: ReadonlyArray<{
    readonly finish_reason?: string;
    readonly delta?: {
      readonly content?: unknown;
      readonly tool_calls?: ReadonlyArray<{ readonly function?: unknown }>;
    };
  }>;
  readonly usage?: Record<string, number>;
}

const asCompletion = (value: unknown): CompletionLike => value as CompletionLike;

describe("anthropicRequestToOpenAI", () => {
  it("maps the common denominator including tools", () => {
    const out = anthropicRequestToOpenAI(
      {
        model: "claude-sonnet",
        system: "Be terse.",
        max_tokens: 512,
        temperature: 0.2,
        top_p: 0.9,
        stop_sequences: ["STOP"],
        tools: [
          {
            name: "get_weather",
            description: "Weather lookup",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        tool_choice: { type: "tool", name: "get_weather" },
        messages: [
          { role: "user", content: "Weather in Paris?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Checking." },
              { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "22C and clear" }],
          },
        ],
        // Intentionally dropped fields:
        metadata: { user_id: "u" },
        thinking: { type: "enabled", budget_tokens: 1024 },
      },
      "gpt-5.2",
    );
    expect(out.model).toBe("gpt-5.2");
    expect(out.messages).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "22C and clear" },
    ]);
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather lookup",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);
    expect(out.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
    expect(out.max_tokens).toBe(512);
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.9);
    expect(out.stop).toEqual(["STOP"]);
    expect("metadata" in out).toBe(false);
    expect("thinking" in out).toBe(false);
  });

  it("maps block-array system prompts and puts tool results before trailing text", () => {
    const out = anthropicRequestToOpenAI(
      {
        model: "m",
        max_tokens: 10,
        system: [
          { type: "text", text: "One." },
          { type: "text", text: "Two." },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
              { type: "text", text: "and then?" },
            ],
          },
        ],
      },
      "up",
    );
    expect(out.messages).toEqual([
      { role: "system", content: "One.Two." },
      { role: "tool", tool_call_id: "t1", content: "ok" },
      { role: "user", content: "and then?" },
    ]);
  });

  it("maps tool_choice auto/any and omits what has no mapping", () => {
    expect(
      anthropicRequestToOpenAI({ max_tokens: 1, tool_choice: { type: "auto" } }, "m").tool_choice,
    ).toBeUndefined();
    expect(
      anthropicRequestToOpenAI({ max_tokens: 1, tool_choice: { type: "any" } }, "m").tool_choice,
    ).toBe("required");
  });
});

describe("openAIRequestToAnthropic", () => {
  it("maps the common denominator including tools and grouped tool results", () => {
    const out = openAIRequestToAnthropic(
      {
        model: "gpt-5.2",
        temperature: 0.5,
        top_p: 0.8,
        stop: ["END"],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Weather lookup",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "get_weather" } },
        messages: [
          { role: "developer", content: "Be terse." },
          { role: "user", content: "Weather in Paris?" },
          {
            role: "assistant",
            content: "Checking.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "22C" },
          { role: "tool", tool_call_id: "call_2", content: "windy" },
        ],
      },
      "claude-sonnet",
    );
    expect(out.model).toBe("claude-sonnet");
    expect(out.system).toBe("Be terse.");
    expect(out.messages).toEqual([
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "22C" },
          { type: "tool_result", tool_use_id: "call_2", content: "windy" },
        ],
      },
    ]);
    expect(out.tools).toEqual([
      {
        name: "get_weather",
        description: "Weather lookup",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ]);
    expect(out.tool_choice).toEqual({ type: "tool", name: "get_weather" });
    expect(out.stop_sequences).toEqual(["END"]);
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.8);
  });

  it("supplies the required max_tokens with a default", () => {
    const out = openAIRequestToAnthropic({ model: "m", messages: [] }, "up");
    expect(out.max_tokens).toBe(4096);
    const explicit = openAIRequestToAnthropic({ model: "m", messages: [], max_tokens: 128 }, "up");
    expect(explicit.max_tokens).toBe(128);
  });

  it("maps string stop and tool_choice variants", () => {
    const out = openAIRequestToAnthropic(
      { model: "m", messages: [], stop: "END", tool_choice: "auto" },
      "up",
    );
    expect(out.stop_sequences).toEqual(["END"]);
    expect(out.tool_choice).toEqual({ type: "auto" });
    const required = openAIRequestToAnthropic(
      { model: "m", messages: [], tool_choice: "required" },
      "up",
    );
    expect(required.tool_choice).toEqual({ type: "any" });
  });
});

describe("openAIResponseToAnthropic", () => {
  it("maps content, tool calls, stop reason, and usage", () => {
    const out = openAIResponseToAnthropic({
      id: "chatcmpl-1",
      model: "gpt-5.2",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello",
            tool_calls: [
              {
                id: "call_9",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    });
    expect(out).toMatchObject({
      id: "chatcmpl-1",
      type: "message",
      role: "assistant",
      model: "gpt-5.2",
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 34 },
    });
    expect(out.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "call_9", name: "get_weather", input: { city: "Paris" } },
    ]);
  });

  it("maps finish reasons", () => {
    const length = openAIResponseToAnthropic({
      choices: [{ message: { content: "x" }, finish_reason: "length" }],
    });
    expect(length.stop_reason).toBe("max_tokens");
    const stop = openAIResponseToAnthropic({
      choices: [{ message: { content: "x" }, finish_reason: "stop" }],
    });
    expect(stop.stop_reason).toBe("end_turn");
  });
});

describe("anthropicResponseToOpenAI", () => {
  it("maps content blocks, tool_use, stop reason, and usage", () => {
    const out = anthropicResponseToOpenAI(
      {
        id: "msg_1",
        model: "claude-sonnet",
        content: [
          { type: "text", text: "Part one." },
          { type: "text", text: "Part two." },
          { type: "tool_use", id: "toolu_2", name: "get_weather", input: { city: "Rome" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 7, output_tokens: 11 },
      },
      1700000000,
    );
    expect(out).toMatchObject({
      id: "msg_1",
      object: "chat.completion",
      created: 1700000000,
      model: "claude-sonnet",
      usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 },
    });
    expect(out.choices).toEqual([
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Part one.Part two.",
          tool_calls: [
            {
              id: "toolu_2",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Rome"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ]);
  });

  it("maps stop reasons", () => {
    expect(
      asCompletion(
        anthropicResponseToOpenAI(
          { content: [{ type: "text", text: "x" }], stop_reason: "max_tokens" },
          0,
        ),
      ).choices?.[0]?.finish_reason,
    ).toBe("length");
    expect(
      asCompletion(
        anthropicResponseToOpenAI(
          { content: [{ type: "text", text: "x" }], stop_reason: "end_turn" },
          0,
        ),
      ).choices?.[0]?.finish_reason,
    ).toBe("stop");
  });
});

describe("createSseParser", () => {
  it("parses frames across arbitrary chunk boundaries", () => {
    const parser = createSseParser();
    expect(parser.push("event: message_star")).toEqual([]);
    expect(parser.push('t\ndata: {"type":"message_start"}\n\n')).toHaveLength(1);
    // `event: ping` gets its own blank line; only then is the frame complete.
    expect(parser.push("event: ping\n\n")).toEqual([{ event: "ping", data: "" }]);
    const rest = parser.push('data: {"type":"message_stop"}\n\n');
    expect(rest).toEqual([{ event: undefined, data: '{"type":"message_stop"}' }]);
    expect(parser.end()).toEqual([]);
  });

  it("flushes a trailing frame without a final blank line and joins multi-line data", () => {
    const parser = createSseParser();
    parser.push("data: one\ndata: two\n");
    expect(parser.end()).toEqual([{ event: undefined, data: "one\ntwo" }]);
  });
});

describe("createOpenAIToAnthropicChunkTranslator", () => {
  const translator = createOpenAIToAnthropicChunkTranslator({
    model: "claude-sonnet",
    id: "msg_t3",
  });
  const chunk = (delta: unknown, finishReason: string | null = null) => ({
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  it("translates a text stream into a well-formed event sequence", () => {
    const events = [
      ...translator.push(chunk({ role: "assistant" })),
      ...translator.push(chunk({ content: "Hel" })),
      ...translator.push(chunk({ content: "lo" })),
      ...translator.push(chunk({}, "stop")),
    ];
    expect(events.map((event) => event["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]?.["data"]).toMatchObject({
      type: "message_start",
      message: { id: "msg_t3", role: "assistant", model: "claude-sonnet", content: [] },
    });
    expect(events[2]?.["data"]).toMatchObject({
      index: 0,
      delta: { type: "text_delta", text: "Hel" },
    });
    expect(events[5]?.["data"]).toMatchObject({ delta: { stop_reason: "end_turn" } });
    // end() after message_stop emits nothing more.
    expect(translator.end()).toEqual([]);
  });

  it("streams tool calls as input_json_delta", () => {
    const t = createOpenAIToAnthropicChunkTranslator({ model: "m", id: "msg_x" });
    const events = [
      ...t.push(
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        }),
      ),
      ...t.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] })),
      ...t.push(chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] })),
      ...t.push(chunk({}, "tool_calls")),
    ];
    expect(events.filter((e) => e["event"] === "content_block_start")).toEqual([
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
        },
      },
    ]);
    const deltas = events.filter((e) => e["event"] === "content_block_delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0]?.["data"]).toMatchObject({
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"ci' },
    });
    expect(events.at(-2)).toMatchObject({
      event: "message_delta",
      data: { delta: { stop_reason: "tool_use" } },
    });
    expect(events.at(-1)).toMatchObject({ event: "message_stop" });
  });

  it("emits a minimal valid message when the upstream stream is empty", () => {
    const t = createOpenAIToAnthropicChunkTranslator({ model: "m", id: "msg_y" });
    const events = t.end();
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "message_delta",
      "message_stop",
    ]);
  });
});

describe("createAnthropicToOpenAIChunkTranslator", () => {
  const translator = createAnthropicToOpenAIChunkTranslator({
    id: "chatcmpl_t3",
    model: "gpt-5.2",
    created: 42,
  });

  it("translates message_start/deltas/message_stop into chunks", () => {
    const events = [
      ...translator.push({
        type: "message_start",
        message: { usage: { input_tokens: 5 } },
      }),
      ...translator.push({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      ...translator.push({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hi" },
      }),
      ...translator.push({ type: "content_block_stop", index: 0 }),
      ...translator.push({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 3 },
      }),
      ...translator.push({ type: "message_stop" }),
      ...translator.end(),
    ];
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      object: "chat.completion.chunk",
      id: "chatcmpl_t3",
      created: 42,
      model: "gpt-5.2",
      choices: [{ delta: { role: "assistant" }, finish_reason: null }],
    });
    expect(asCompletion(events[1]).choices?.[0]?.delta).toEqual({ content: "Hi" });
    expect(asCompletion(events[2]).choices?.[0]?.finish_reason).toBe("stop");
  });

  it("streams tool_use blocks as tool_calls deltas", () => {
    const t = createAnthropicToOpenAIChunkTranslator({ id: "c1", model: "m", created: 0 });
    const events = [
      ...t.push({ type: "message_start", message: {} }),
      ...t.push({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      }),
      ...t.push({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city"' },
      }),
      ...t.push({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      ...t.push({ type: "message_stop" }),
    ];
    const withTools = events.filter(
      (event) => asCompletion(event).choices?.[0]?.delta?.tool_calls !== undefined,
    );
    expect(withTools).toHaveLength(2);
    expect(asCompletion(withTools[0]).choices?.[0]?.delta?.tool_calls?.[0]).toEqual({
      index: 0,
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    });
    expect(
      (
        asCompletion(withTools[1]).choices?.[0]?.delta?.tool_calls?.[0] as
          | { function?: unknown }
          | undefined
      )?.function,
    ).toEqual({
      arguments: '{"city"',
    });
    expect(asCompletion(events.at(-1)).choices?.[0]?.finish_reason).toBe("tool_calls");
  });

  it("closes an unterminated stream with a finish chunk on end()", () => {
    const t = createAnthropicToOpenAIChunkTranslator({ id: "c2", model: "m", created: 0 });
    expect(t.push({ type: "message_start", message: {} })).toHaveLength(1);
    const tail = t.end();
    expect(tail).toHaveLength(1);
    expect(asCompletion(tail[0]).choices?.[0]?.finish_reason).toBe("stop");
  });
});

describe("synthetic stream wrappers", () => {
  it("anthropicMessageToStreamEvents emits the full event envelope", () => {
    const events = anthropicMessageToStreamEvents(
      openAIResponseToAnthropic({
        choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("openAICompletionToChunkSequence emits role, content, and finish chunks", () => {
    const chunks = openAICompletionToChunkSequence(
      anthropicResponseToOpenAI(
        { content: [{ type: "text", text: "Hey" }], stop_reason: "end_turn" },
        7,
      ),
    );
    expect(chunks).toHaveLength(3);
    expect(asCompletion(chunks[0]).choices?.[0]?.delta).toEqual({ role: "assistant" });
    expect(asCompletion(chunks[1]).choices?.[0]?.delta).toEqual({ content: "Hey" });
    expect(asCompletion(chunks[2]).choices?.[0]?.finish_reason).toBe("stop");
  });
});

describe("encodeSseFrame", () => {
  it("emits named events for anthropic and data-only frames for openai", () => {
    expect(encodeSseFrame({ event: "message_stop", data: { type: "message_stop" } })).toBe(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(encodeSseFrame({ data: { a: 1 } })).toBe('data: {"a":1}\n\n');
  });
});

describe("chatCompletionsRequestToResponses", () => {
  it("maps messages and tools; sampling knobs stay home", () => {
    expect(
      chatCompletionsRequestToResponses(
        {
          model: "alias",
          messages: [
            { role: "system", content: "Be terse." },
            { role: "user", content: "Hi" },
            {
              role: "assistant",
              content: "Checking.",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "w", arguments: "{}" } },
              ],
            },
            { role: "tool", tool_call_id: "call_1", content: "sunny" },
          ],
          // The backend 400s on these (verified live), so they never go up.
          temperature: 0.2,
          top_p: 0.9,
          max_tokens: 64,
          stop: ["STOP"],
          tools: [
            {
              type: "function",
              function: {
                name: "w",
                description: "Weather",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          tool_choice: "auto",
        },
        "upstream-luna",
      ),
    ).toEqual({
      model: "upstream-luna",
      instructions: "Be terse.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
        { type: "function_call", call_id: "call_1", name: "w", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "sunny" },
      ],
      store: false,
      tools: [
        {
          type: "function",
          name: "w",
          description: "Weather",
          parameters: { type: "object", properties: {} },
        },
      ],
      tool_choice: "auto",
    });
  });

  it("maps image parts and a named tool choice", () => {
    const out = chatCompletionsRequestToResponses(
      {
        model: "alias",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
            ],
          },
        ],
        tool_choice: { type: "function", function: { name: "w" } },
      },
      "upstream-luna",
    ) as { input: Array<{ content: Array<Record<string, unknown>> }>; tool_choice: unknown };
    expect(out.input[0]?.content).toEqual([
      { type: "input_text", text: "What is this?" },
      { type: "input_image", image_url: "data:image/png;base64,AAA" },
    ]);
    expect(out.tool_choice).toEqual({ type: "function", name: "w" });
  });

  it("drops text-only assistant history; it restates context the upstream keeps", () => {
    const out = chatCompletionsRequestToResponses(
      {
        model: "alias",
        messages: [
          { role: "user", content: "What is 2+2?" },
          { role: "assistant", content: "4" },
          { role: "user", content: "And plus 1?" },
        ],
      },
      "upstream-luna",
    ) as { input: Array<unknown> };
    expect(out.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "What is 2+2?" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "And plus 1?" }] },
    ]);
  });

  it("maps reasoning_effort into Responses reasoning; off and unknown stay home", () => {
    const base = { model: "alias", messages: [{ role: "user", content: "Hi" }] };
    expect(
      chatCompletionsRequestToResponses({ ...base, reasoning_effort: "high" }, "upstream-luna"),
    ).toMatchObject({ reasoning: { effort: "high" } });
    for (const effort of ["off", "none", "ultra", 7, null, undefined]) {
      expect(
        chatCompletionsRequestToResponses({ ...base, reasoning_effort: effort }, "upstream-luna"),
      ).not.toHaveProperty("reasoning");
    }
  });
});

describe("responsesResponseToChatCompletion", () => {
  // Recorded from chatgpt.com/backend-api/codex (ids shortened).
  const response = {
    id: "resp_abc",
    object: "response",
    created_at: 1789683892,
    status: "completed",
    model: "gpt-5.6-luna",
    usage: { input_tokens: 51, output_tokens: 18, total_tokens: 69 },
  };

  it("reads text and usage off the completed envelope", () => {
    const completion = responsesResponseToChatCompletion(
      response,
      [
        {
          id: "msg_abc",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "OK", annotations: [] }],
        },
      ],
      "upstream-luna",
      0,
    );
    expect(completion).toMatchObject({
      id: "chatcmpl_resp_abc",
      object: "chat.completion",
      created: 1789683892,
      model: "upstream-luna",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 51, completion_tokens: 18, total_tokens: 69 },
    });
  });

  it("reads tool calls off accumulated items even when the envelope output is empty", () => {
    const completion = asCompletion(
      responsesResponseToChatCompletion(
        { ...response, output: [] },
        [
          {
            id: "fc_abc",
            type: "function_call",
            status: "completed",
            arguments: '{"name":"Ada"}',
            call_id: "call_xyz",
            name: "greet",
          },
        ],
        "upstream-luna",
        0,
      ),
    );
    expect(completion.choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(completion.choices?.[0]?.delta).toBeUndefined();
    const message = (
      completion as unknown as {
        choices: Array<{ message: { content: null; tool_calls: Array<unknown> } }>;
      }
    ).choices[0]?.message;
    expect(message?.content).toBeNull();
    expect(message?.tool_calls).toEqual([
      {
        id: "call_xyz",
        type: "function",
        function: { name: "greet", arguments: '{"name":"Ada"}' },
      },
    ]);
  });

  it("maps an incomplete response to length", () => {
    const completion = asCompletion(
      responsesResponseToChatCompletion(
        { ...response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        [],
        "upstream-luna",
        7,
      ),
    );
    expect(completion.choices?.[0]?.finish_reason).toBe("length");
  });
});

describe("createResponsesToOpenAIChunkTranslator", () => {
  const base = { id: "chatcmpl_test", model: "upstream-luna", created: 11 };

  const feed = (
    events: ReadonlyArray<Record<string, unknown>>,
  ): ReadonlyArray<Record<string, unknown>> => {
    const translator = createResponsesToOpenAIChunkTranslator(base);
    const out = events.flatMap((event) => translator.push(event));
    return [...out, ...translator.end()];
  };

  it("streams text deltas and closes with the completed finish reason", () => {
    const chunks = feed([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_text.delta", delta: "O", content_index: 0 },
      { type: "response.output_text.delta", delta: "K", content_index: 0 },
      {
        type: "response.completed",
        response: { ...{ id: "resp_1", status: "completed", usage: null } },
      },
    ]).map(asCompletion);
    expect(chunks.map((c) => c.choices?.[0]?.delta)).toEqual([
      { role: "assistant" },
      { content: "O" },
      { content: "K" },
      {},
    ]);
    expect(chunks.map((c) => c.choices?.[0]?.finish_reason)).toEqual([null, null, null, "stop"]);
  });

  it("streams tool calls by output index with arguments appended", () => {
    const chunks = feed([
      { type: "response.created", response: {} },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "greet" },
      },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"na' },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: 'me":"Ada"}' },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: '{"name":"Ada"}',
      },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ]).map(asCompletion);
    const toolDeltas = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
    expect(toolDeltas[0]).toMatchObject({ index: 0, id: "call_1", function: { name: "greet" } });
    expect(toolDeltas.slice(1)).toEqual([
      { index: 0, function: { arguments: '{"na' } },
      { index: 0, function: { arguments: 'me":"Ada"}' } },
    ]);
    expect(chunks.at(-1)?.choices?.[0]?.finish_reason).toBe("tool_calls");
  });

  it("closes a truncated stream instead of hanging", () => {
    const translator = createResponsesToOpenAIChunkTranslator(base);
    const out = [
      ...translator.push({ type: "response.created", response: {} }),
      ...translator.end(),
    ].map(asCompletion);
    expect(out.at(-1)?.choices?.[0]?.finish_reason).toBe("stop");
  });
});
