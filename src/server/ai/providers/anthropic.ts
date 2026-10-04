import { readSse } from "../sse";
import { ProviderError, ZERO_USAGE, type ChatEvent, type ChatMessage, type ChatModel, type ChatRequest, type StopReason, type Usage } from "../types";

type FetchLike = typeof fetch;

export type AnthropicConfig = { apiKey: string; model: string; baseUrl?: string; fetch?: FetchLike; version?: string };

type ABlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
type AMessage = { role: "user" | "assistant"; content: ABlock[] };

// provider-neutral transcript → Messages API shape (tool results ride in user turns; consecutive ones are merged)
export function toAnthropicMessages(messages: ChatMessage[]): AMessage[] {
  const out: AMessage[] = [];
  const push = (role: AMessage["role"], blocks: ABlock[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.content }]);
    else if (m.role === "assistant") {
      const blocks: ABlock[] = [];
      if (m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      push("assistant", blocks);
    } else push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) }]);
  }
  return out;
}

const STOP: Record<string, StopReason> = { end_turn: "end", stop_sequence: "end", tool_use: "tool_use", max_tokens: "max_tokens", refusal: "refusal" };

export class AnthropicModel implements ChatModel {
  readonly provider = "anthropic";
  readonly demo = false;
  readonly model: string;
  private readonly f: FetchLike;
  constructor(private cfg: AnthropicConfig) {
    this.model = cfg.model;
    this.f = cfg.fetch ?? fetch;
  }

  requestBody(req: ChatRequest) {
    return {
      model: this.model,
      max_tokens: req.maxTokens,
      // the system prompt + tool list are identical across the steps of a turn: cache them
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: toAnthropicMessages(req.messages),
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      stream: true,
    };
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const res = await this.f(`${(this.cfg.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.cfg.apiKey, "anthropic-version": this.cfg.version ?? "2023-06-01" },
      body: JSON.stringify(this.requestBody(req)),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw await providerError(res, "Anthropic");

    const usage: Usage = { ...ZERO_USAGE };
    let stop: StopReason = "other";
    const blocks = new Map<number, { id: string; name: string; json: string }>();
    for await (const ev of readSse(res.body, req.signal)) {
      if (!ev.data) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (d.type) {
        case "message_start": {
          const u = ((d.message as Record<string, unknown>)?.usage ?? {}) as Record<string, number>;
          usage.inputTokens = u.input_tokens ?? 0;
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
          usage.outputTokens = u.output_tokens ?? 0;
          break;
        }
        case "content_block_start": {
          const b = d.content_block as { type: string; id?: string; name?: string; text?: string };
          if (b.type === "tool_use") blocks.set(d.index as number, { id: b.id!, name: b.name!, json: "" });
          else if (b.type === "text" && b.text) yield { type: "text", delta: b.text };
          break;
        }
        case "content_block_delta": {
          const delta = d.delta as { type: string; text?: string; partial_json?: string };
          if (delta.type === "text_delta" && delta.text) yield { type: "text", delta: delta.text };
          else if (delta.type === "input_json_delta") {
            const b = blocks.get(d.index as number);
            if (b) b.json += delta.partial_json ?? "";
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks.get(d.index as number);
          if (b) {
            blocks.delete(d.index as number);
            yield { type: "tool_call", call: { id: b.id, name: b.name, input: parseArgs(b.json) } };
          }
          break;
        }
        case "message_delta": {
          const delta = d.delta as { stop_reason?: string };
          if (delta?.stop_reason) stop = STOP[delta.stop_reason] ?? "other";
          const u = (d.usage ?? {}) as Record<string, number>;
          if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens; // cumulative
          if (typeof u.input_tokens === "number" && u.input_tokens > 0) usage.inputTokens = u.input_tokens;
          break;
        }
        case "error": {
          const e = (d.error ?? {}) as { type?: string; message?: string };
          throw new ProviderError(`Anthropic: ${e.message ?? "stream error"}`, undefined, e.type === "overloaded_error" || e.type === "api_error");
        }
      }
    }
    yield { type: "end", stopReason: stop, usage };
  }
}

// tool arguments arrive as JSON text; invalid JSON is passed on so validation reports it instead of guessing
export function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { __invalid: json };
  } catch {
    return { __invalid: json };
  }
}

export async function providerError(res: Response, name: string): Promise<ProviderError> {
  let detail = "";
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = j?.error?.message ?? j?.message ?? body.slice(0, 300);
    } catch {
      detail = body.slice(0, 300);
    }
  } catch {
    /* no body */
  }
  const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
  return new ProviderError(`${name} returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status, retryable);
}
