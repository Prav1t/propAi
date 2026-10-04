// provider-neutral types shared by every model adapter, the demo model and the orchestrator

export type JsonSchema = Record<string, unknown>;

export type ToolSpec = { name: string; description: string; inputSchema: JsonSchema };

export type ToolCall = { id: string; name: string; input: Record<string, unknown> };

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type Usage = {
  inputTokens: number; // uncached input
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "end"; stopReason: StopReason; usage: Usage };

// facts the demo model needs to parse relative dates; real models get the same facts in the system prompt
export type ChatHints = { today: string; timeZone: string; resident: boolean; orgSlug: string };

export type ChatRequest = {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  hints?: ChatHints;
};

export interface ChatModel {
  readonly provider: string;
  readonly model: string;
  readonly demo: boolean;
  stream(req: ChatRequest): AsyncIterable<ChatEvent>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}
