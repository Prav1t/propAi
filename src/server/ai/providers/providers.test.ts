import { describe, expect, it } from "vitest";
import { AnthropicModel, parseArgs, toAnthropicMessages } from "./anthropic";
import { OpenAiModel, toOpenAiMessages } from "./openai";
import { ProviderError, type ChatEvent, type ChatMessage, type ChatRequest } from "../types";
import { readSse } from "../sse";

// a fetch stub that streams the given SSE text in awkward chunk sizes
function sseFetch(body: string, opts: { status?: number; chunk?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (opts.status && opts.status >= 400) return new Response(body, { status: opts.status });
    const bytes = new TextEncoder().encode(body);
    const size = opts.chunk ?? 7;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const collect = async (it: AsyncIterable<ChatEvent>) => {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

const REQ: ChatRequest = {
  system: "You are helpful.",
  messages: [{ role: "user", content: "Overdue?" }],
  tools: [{ name: "search_work_orders", description: "List work orders", inputSchema: { type: "object", properties: { view: { type: "string" } } } }],
  maxTokens: 500,
};

describe("SSE reader", () => {
  it("handles chunk boundaries, CRLF, comments and multi-line data", async () => {
    const text = ": keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: {\"x\":1}\n\ndata: tail";
    for (const chunk of [1, 3, 64]) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          const b = new TextEncoder().encode(text);
          for (let i = 0; i < b.length; i += chunk) c.enqueue(b.slice(i, i + chunk));
          c.close();
        },
      });
      const evs = [];
      for await (const e of readSse(stream)) evs.push(e);
      expect(evs).toEqual([{ event: "a", data: "one\ntwo" }, { event: null, data: '{"x":1}' }, { event: null, data: "tail" }]);
    }
  });
});

describe("Anthropic adapter", () => {
  it("merges consecutive tool results into one user turn and drops empty assistant text", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "a", input: {} }, { id: "t2", name: "b", input: { x: 1 } }] },
      { role: "tool", toolCallId: "t1", name: "a", content: "{}" },
      { role: "tool", toolCallId: "t2", name: "b", content: "oops", isError: true },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "a", input: {} }, { type: "tool_use", id: "t2", name: "b", input: { x: 1 } }] });
    expect(out[2].role).toBe("user");
    expect(out[2].content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "{}" }, { type: "tool_result", tool_use_id: "t2", content: "oops", is_error: true }]);
  });

  it("sends a cached system prompt, the tools and the API headers", async () => {
    const { f, calls } = sseFetch('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    await collect(new AnthropicModel({ apiKey: "sk-test", model: "claude-sonnet-5", fetch: f }).stream(REQ));
    const body = JSON.parse(String(calls[0].init.body));
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    expect((calls[0].init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
    expect(body).toMatchObject({ model: "claude-sonnet-5", max_tokens: 500, stream: true, system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }] });
    expect(body.tools[0]).toEqual({ name: "search_work_orders", description: "List work orders", input_schema: REQ.tools[0].inputSchema });
  });

  it("streams text, assembles tool input from partial JSON and reports usage", async () => {
    const sse = [
      { type: "message_start", message: { usage: { input_tokens: 120, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "search_work_orders", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"vi' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ew":"overdue"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
      { type: "message_stop" },
    ].map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    const evs = await collect(new AnthropicModel({ apiKey: "k", model: "m", fetch: sseFetch(sse).f }).stream(REQ));
    expect(evs.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Let me check.");
    expect(evs.find((e) => e.type === "tool_call")).toEqual({ type: "tool_call", call: { id: "toolu_1", name: "search_work_orders", input: { view: "overdue" } } });
    expect(evs.at(-1)).toEqual({ type: "end", stopReason: "tool_use", usage: { inputTokens: 120, outputTokens: 42, cacheReadTokens: 900, cacheWriteTokens: 0 } });
  });

  it("turns HTTP errors into ProviderErrors, retryable for overload and rate limits", async () => {
    const m = (status: number) => new AnthropicModel({ apiKey: "k", model: "m", fetch: sseFetch(JSON.stringify({ error: { message: "slow down" } }), { status }).f });
    await expect(collect(m(429).stream(REQ))).rejects.toMatchObject({ status: 429, retryable: true, message: expect.stringContaining("slow down") });
    await expect(collect(m(529).stream(REQ))).rejects.toMatchObject({ retryable: true });
    await expect(collect(m(400).stream(REQ))).rejects.toMatchObject({ status: 400, retryable: false });
    await expect(collect(m(401).stream(REQ))).rejects.toBeInstanceOf(ProviderError);
  });

  it("surfaces mid-stream error events", async () => {
    const sse = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    await expect(collect(new AnthropicModel({ apiKey: "k", model: "m", fetch: sseFetch(sse).f }).stream(REQ))).rejects.toMatchObject({ retryable: true });
  });

  it("keeps invalid tool JSON visible instead of guessing", () => {
    expect(parseArgs("")).toEqual({});
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs("{oops")).toEqual({ __invalid: "{oops" });
    expect(parseArgs("[1]")).toEqual({ __invalid: "[1]" });
  });
});

describe("OpenAI-style adapter", () => {
  it("maps the transcript to Chat Completions messages", () => {
    const out = toOpenAiMessages("sys", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "a", input: { x: 1 } }] },
      { role: "tool", toolCallId: "c1", name: "a", content: "{}" },
    ]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: '{"x":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "{}" },
    ]);
  });

  it("uses max_completion_tokens for OpenAI and max_tokens for compatible servers", async () => {
    const done = "data: [DONE]\n\n";
    const a = sseFetch(done);
    await collect(new OpenAiModel({ provider: "openai", apiKey: "sk", model: "gpt-x", fetch: a.f }).stream(REQ));
    const b = sseFetch(done);
    await collect(new OpenAiModel({ provider: "openai-compatible", baseUrl: "http://llm.local/v1/", model: "llama", fetch: b.f }).stream(REQ));
    const ba = JSON.parse(String(a.calls[0].init.body));
    const bb = JSON.parse(String(b.calls[0].init.body));
    expect(a.calls[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(ba.max_completion_tokens).toBe(500);
    expect(ba.max_tokens).toBeUndefined();
    expect(b.calls[0].url).toBe("http://llm.local/v1/chat/completions");
    expect(bb.max_tokens).toBe(500);
    expect((b.calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(ba.tools[0]).toEqual({ type: "function", function: { name: "search_work_orders", description: "List work orders", parameters: REQ.tools[0].inputSchema } });
  });

  it("assembles streamed tool calls by index and reads usage", async () => {
    const chunks = [
      { choices: [{ delta: { content: "Checking" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "search_packages", arguments: '{"view":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "ops_kpis", arguments: "{}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"waiting"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 300, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } } },
    ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const evs = await collect(new OpenAiModel({ provider: "openai", apiKey: "k", model: "m", fetch: sseFetch(chunks, { chunk: 5 }).f }).stream(REQ));
    expect(evs.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", call: { id: "call_a", name: "search_packages", input: { view: "waiting" } } },
      { type: "tool_call", call: { id: "call_b", name: "ops_kpis", input: {} } },
    ]);
    expect(evs.at(-1)).toEqual({ type: "end", stopReason: "tool_use", usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 } });
  });
});
