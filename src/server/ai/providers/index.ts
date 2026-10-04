import { aiConfig, type AiConfig } from "../config";
import type { ChatModel } from "../types";
import { AnthropicModel } from "./anthropic";
import { DemoModel } from "./demo";
import { OpenAiModel } from "./openai";

// What the model is being asked to do. Routing picks a tier; Iteration 6 wires only "chat" to the main model —
// "classify"/"extract" exist so cheaper or specialised models can be slotted in without touching callers.
export type ModelTask = "chat" | "classify" | "extract" | "vision";

const g = globalThis as unknown as { __aiModelOverride?: ChatModel };

// tests (and the eval runner) can install a scripted model in place of the configured one
export function setChatModelForTests(m: ChatModel | undefined) {
  g.__aiModelOverride = m;
}

export function routeModel(task: ModelTask, cfg: AiConfig = aiConfig()): ChatModel {
  if (g.__aiModelOverride) return g.__aiModelOverride;
  const p = cfg.provider;
  const tier = task === "classify" ? "fast" : "main";
  switch (p.kind) {
    case "anthropic":
      return new AnthropicModel({ apiKey: p.apiKey, baseUrl: p.baseUrl, model: tier === "fast" ? p.fastModel : p.model });
    case "openai":
    case "openai-compatible":
      return new OpenAiModel({ provider: p.kind, apiKey: p.apiKey, baseUrl: p.baseUrl, model: tier === "fast" ? p.fastModel : p.model });
    case "demo":
      return new DemoModel();
  }
}

// for the UI: is the assistant running without a language model, and why
export function providerStatus(cfg: AiConfig = aiConfig()) {
  const p = cfg.provider;
  if (g.__aiModelOverride) return { demo: g.__aiModelOverride.demo, provider: g.__aiModelOverride.provider, model: g.__aiModelOverride.model, reason: null };
  if (p.kind === "demo") return { demo: true, provider: "demo", model: "demo-rules-v1", reason: p.reason };
  return { demo: false, provider: p.kind, model: p.model, reason: null };
}
