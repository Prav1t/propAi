import type { Usage } from "./types";

// list prices in USD per million tokens, used only for *estimated* cost on the usage page.
// Prices change: set AI_PRICE_INPUT_PER_MTOK / AI_PRICE_OUTPUT_PER_MTOK to override, and models not listed
// here record no cost estimate rather than a guessed one.
export const PRICE_TABLE: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export type Price = { inputPerMTok: number; outputPerMTok: number };

export function priceFor(model: string, override: Price | null): Price | null {
  if (override) return override;
  const p = PRICE_TABLE[model];
  return p ? { inputPerMTok: p.input, outputPerMTok: p.output } : null;
}

// cache reads bill at ~10% and cache writes at ~125% of the input price (Anthropic's published multipliers)
export function estimateCostUsd(usage: Usage, price: Price | null): number | null {
  if (!price) return null;
  const input = usage.inputTokens + usage.cacheWriteTokens * 1.25 + usage.cacheReadTokens * 0.1;
  const cost = (input * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
