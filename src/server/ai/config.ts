import { z } from "zod";

// AI configuration from the environment; nothing here is required — without a provider key the app runs in demo mode
const numberish = (def: number, min: number, max: number) =>
  z.union([z.literal(""), z.coerce.number().min(min).max(max)]).optional().transform((v) => (v === "" || v === undefined ? def : v));
const optNumber = z.union([z.literal(""), z.coerce.number().min(0)]).optional().transform((v) => (v === "" || v === undefined ? null : v));

const schema = z.object({
  AI_PROVIDER: z.enum(["demo", "anthropic", "openai", "openai-compatible"]).optional(),
  AI_MODEL: z.string().trim().optional(),
  AI_MODEL_FAST: z.string().trim().optional(),
  ANTHROPIC_API_KEY: z.string().trim().optional(),
  ANTHROPIC_BASE_URL: z.string().trim().url().optional().or(z.literal("")),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_BASE_URL: z.string().trim().url().optional().or(z.literal("")),
  AI_COMPAT_BASE_URL: z.string().trim().url().optional().or(z.literal("")),
  AI_COMPAT_API_KEY: z.string().trim().optional(),
  AI_MAX_STEPS: numberish(6, 1, 12),
  AI_TIMEOUT_MS: numberish(60_000, 5_000, 300_000),
  AI_MAX_OUTPUT_TOKENS: numberish(1500, 256, 8192),
  AI_TEMPERATURE: z.union([z.literal(""), z.coerce.number().min(0).max(2)]).optional().transform((v) => (v === "" || v === undefined ? undefined : v)),
  AI_PRICE_INPUT_PER_MTOK: optNumber,
  AI_PRICE_OUTPUT_PER_MTOK: optNumber,
  AI_MONTHLY_REQUEST_CAP: optNumber,
  AI_REQUESTS_PER_MINUTE: numberish(20, 1, 1000),
});

export type ProviderChoice =
  | { kind: "demo"; reason: string }
  | { kind: "anthropic"; apiKey: string; baseUrl?: string; model: string; fastModel: string }
  | { kind: "openai" | "openai-compatible"; apiKey?: string; baseUrl?: string; model: string; fastModel: string };

export type AiConfig = {
  provider: ProviderChoice;
  maxSteps: number;
  timeoutMs: number;
  maxOutputTokens: number;
  temperature?: number;
  priceOverride: { inputPerMTok: number; outputPerMTok: number } | null;
  defaultMonthlyCap: number | null;
  requestsPerMinute: number;
};

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
export const DEFAULT_ANTHROPIC_FAST_MODEL = "claude-haiku-4-5-20251001";

// pure: resolves which provider to use and why (unit-tested)
export function resolveAiConfig(source: Record<string, string | undefined>): AiConfig {
  const e = schema.parse(source);
  const blank = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  let provider: ProviderChoice;
  const wanted = e.AI_PROVIDER ?? (blank(e.ANTHROPIC_API_KEY) ? "anthropic" : blank(e.OPENAI_API_KEY) && blank(e.AI_MODEL) ? "openai" : "demo");
  if (wanted === "anthropic") {
    const key = blank(e.ANTHROPIC_API_KEY);
    provider = key
      ? { kind: "anthropic", apiKey: key, baseUrl: blank(e.ANTHROPIC_BASE_URL), model: blank(e.AI_MODEL) ?? DEFAULT_ANTHROPIC_MODEL, fastModel: blank(e.AI_MODEL_FAST) ?? DEFAULT_ANTHROPIC_FAST_MODEL }
      : { kind: "demo", reason: "AI_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set" };
  } else if (wanted === "openai") {
    const key = blank(e.OPENAI_API_KEY);
    const model = blank(e.AI_MODEL);
    provider = !key
      ? { kind: "demo", reason: "AI_PROVIDER is openai but OPENAI_API_KEY is not set" }
      : !model
        ? { kind: "demo", reason: "AI_PROVIDER is openai but AI_MODEL is not set" }
        : { kind: "openai", apiKey: key, baseUrl: blank(e.OPENAI_BASE_URL), model, fastModel: blank(e.AI_MODEL_FAST) ?? model };
  } else if (wanted === "openai-compatible") {
    const base = blank(e.AI_COMPAT_BASE_URL);
    const model = blank(e.AI_MODEL);
    provider = !base
      ? { kind: "demo", reason: "AI_PROVIDER is openai-compatible but AI_COMPAT_BASE_URL is not set" }
      : !model
        ? { kind: "demo", reason: "AI_PROVIDER is openai-compatible but AI_MODEL is not set" }
        : { kind: "openai-compatible", apiKey: blank(e.AI_COMPAT_API_KEY), baseUrl: base, model, fastModel: blank(e.AI_MODEL_FAST) ?? model };
  } else {
    provider = { kind: "demo", reason: e.AI_PROVIDER === "demo" ? "AI_PROVIDER is demo" : "no AI provider key is configured" };
  }
  return {
    provider,
    maxSteps: e.AI_MAX_STEPS,
    timeoutMs: e.AI_TIMEOUT_MS,
    maxOutputTokens: e.AI_MAX_OUTPUT_TOKENS,
    temperature: e.AI_TEMPERATURE,
    priceOverride: e.AI_PRICE_INPUT_PER_MTOK !== null && e.AI_PRICE_OUTPUT_PER_MTOK !== null
      ? { inputPerMTok: e.AI_PRICE_INPUT_PER_MTOK, outputPerMTok: e.AI_PRICE_OUTPUT_PER_MTOK } : null,
    defaultMonthlyCap: e.AI_MONTHLY_REQUEST_CAP,
    requestsPerMinute: e.AI_REQUESTS_PER_MINUTE,
  };
}

let cached: AiConfig | undefined;
export function aiConfig(): AiConfig {
  return (cached ??= resolveAiConfig(process.env));
}
// tests swap configuration (e.g. a scripted model) without touching process.env
export function setAiConfigForTests(c: AiConfig | undefined) {
  cached = c;
}
