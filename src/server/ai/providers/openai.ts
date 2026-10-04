import { readSse } from "../sse";
import { ZERO_USAGE, type ChatEvent, type ChatMessage, type ChatModel, type ChatRequest, type StopReason, type Usage } from "../types";
import { parseArgs, providerError } from "./anthropic";

type FetchLike = typeof fetch;

// "openai" talks to api.openai.com; "openai-compatible" to any Chat Completions server (vLLM, Ollama, LM Studio, gateways)
export type OpenAiConfig = {
  provider: "openai" | "openai-compatible";
  apiKey?: string;
  model: string;
  baseUrl?: string;
  fetch?: FetchLike;
};

type OMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export function toOpenAiMessages(system: string, messages: ChatMessage[]): OMessage[] {
  const out: OMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.isError ? `ERROR: ${m.content}` : m.content });
  }
  return out;
}

const STOP: Record<string, StopReason> = { stop: "end", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

export class OpenAiModel implements ChatModel {
  readonly demo = false;
  readonly provider: string;
  readonly model: string;
  private readonly f: FetchLike;
  constructor(private cfg: OpenAiConfig) {
    this.provider = cfg.provider;
    this.model = cfg.model;
    this.f = cfg.fetch ?? fetch;
  }

  requestBody(req: ChatRequest) {
    return {
      model: this.model,
      messages: toOpenAiMessages(req.system, req.messages),
      ...(req.tools.length
        ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
        : {}),
      // current OpenAI models take max_completion_tokens; most compatible servers still expect max_tokens
      ...(this.cfg.provider === "openai" ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const base = (this.cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const res = await this.f(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      body: JSON.stringify(this.requestBody(req)),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw await providerError(res, this.provider === "openai" ? "OpenAI" : "Model server");

    const usage: Usage = { ...ZERO_USAGE };
    let stop: StopReason = "other";
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const ev of readSse(res.body, req.signal)) {
      if (!ev.data || ev.data === "[DONE]") continue;
      let d: {
        choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
        error?: { message?: string };
      };
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (d.error) throw await providerError(new Response(JSON.stringify(d), { status: 502 }), this.provider);
      for (const ch of d.choices ?? []) {
        if (ch.delta?.content) yield { type: "text", delta: ch.delta.content };
        for (const tc of ch.delta?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (ch.finish_reason) stop = STOP[ch.finish_reason] ?? "other";
      }
      if (d.usage) {
        const cached = d.usage.prompt_tokens_details?.cached_tokens ?? 0;
        usage.inputTokens = (d.usage.prompt_tokens ?? 0) - cached;
        usage.cacheReadTokens = cached;
        usage.outputTokens = d.usage.completion_tokens ?? 0;
      }
    }
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: "tool_call", call: { id: c.id || `call_${i}`, name: c.name, input: parseArgs(c.args) } };
    }
    if (calls.size && stop === "other") stop = "tool_use";
    yield { type: "end", stopReason: stop, usage };
  }
}
