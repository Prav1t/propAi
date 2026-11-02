import "server-only";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { aiUsage, organizations } from "@/server/db/schema";
import { loadEntitlements } from "@/server/billing/entitlements";
import { tenantTx, type TenantCtx } from "@/server/modules/context";
import { aiConfig } from "./config";
import { readAiSettings, requestsThisMonth } from "./usage";

// Speech-to-text behind the model abstraction (Iteration 12). Any OpenAI-compatible /audio/transcriptions endpoint
// works: OpenAI itself, or a self-hosted Whisper server. It's on when the chat provider is OpenAI (or compatible)
// with a key, or when AI_TRANSCRIBE_BASE_URL is set on its own (e.g. chat on Anthropic, speech elsewhere).

const env = z.object({
  AI_TRANSCRIBE_BASE_URL: z.string().trim().url().optional().or(z.literal("")),
  AI_TRANSCRIBE_API_KEY: z.string().trim().optional(),
  AI_TRANSCRIBE_MODEL: z.string().trim().optional(),
});

export type Transcriber = { provider: string; model: string; baseUrl: string; apiKey?: string };

export function transcriberFor(source: Record<string, string | undefined> = process.env): Transcriber | null {
  const e = env.parse(source);
  const model = e.AI_TRANSCRIBE_MODEL || "whisper-1";
  if (e.AI_TRANSCRIBE_BASE_URL) return { provider: "openai-compatible", model, baseUrl: e.AI_TRANSCRIBE_BASE_URL.replace(/\/$/, ""), apiKey: e.AI_TRANSCRIBE_API_KEY || undefined };
  const chat = aiConfig().provider;
  if (chat.kind === "openai" && chat.apiKey) return { provider: "openai", model, baseUrl: (chat.baseUrl || "https://api.openai.com/v1").replace(/\/$/, ""), apiKey: chat.apiKey };
  if (chat.kind === "openai-compatible" && chat.baseUrl) return { provider: "openai-compatible", model, baseUrl: chat.baseUrl.replace(/\/$/, ""), apiKey: chat.apiKey };
  return null;
}

export const AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac"];
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export class TranscribeRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// the same switches as typed questions: assistant on for the organization, in the plan, under the monthly caps
async function assertAvailable(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.permissions.has("ai.use")) throw new TranscribeRefused(403, "The assistant isn't available to your role.");
  await tenantTx(ctx, async (tx) => {
    const [org] = await tx.select({ timezone: organizations.timezone, settings: organizations.settings }).from(organizations).where(eq(organizations.id, p.orgId));
    const settings = readAiSettings(org.settings);
    const ent = await loadEntitlements(tx, p.orgId);
    if (!settings.enabled || !ent.features.ai_assistant) throw new TranscribeRefused(403, "The assistant is switched off for your organization.");
    if (!ent.flags.voice_input) throw new TranscribeRefused(403, "Voice input is switched off.");
    const caps = [settings.monthlyRequestCap, ent.limits.ai_requests].filter((c): c is number => c !== null);
    if (caps.length && (await requestsThisMonth(tx, p.orgId, org.timezone)) >= Math.min(...caps)) {
      throw new TranscribeRefused(429, "Your organization has used this month's assistant requests.");
    }
  });
}

export async function transcribe(ctx: TenantCtx, audio: File, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<string> {
  const t = transcriberFor();
  if (!t) throw new TranscribeRefused(404, "No speech-to-text provider is set up.");
  if (!AUDIO_TYPES.includes(audio.type.split(";")[0])) throw new TranscribeRefused(415, "Unsupported audio format.");
  if (audio.size === 0 || audio.size > MAX_AUDIO_BYTES) throw new TranscribeRefused(413, "Recordings can be up to 10 MB (about a minute).");
  await assertAvailable(ctx);
  const started = Date.now();
  const form = new FormData();
  form.append("file", audio, audio.name || "dictation.webm");
  form.append("model", t.model);
  form.append("response_format", "json");
  let outcome = "error";
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${t.baseUrl}/audio/transcriptions`, {
      method: "POST", body: form, signal: opts.signal ?? AbortSignal.timeout(30_000), redirect: "error",
      headers: t.apiKey ? { authorization: `Bearer ${t.apiKey}` } : undefined,
    });
    if (!res.ok) throw new TranscribeRefused(502, "The speech-to-text service didn't answer. Try again or type instead.");
    const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
    if (!text) throw new TranscribeRefused(422, "Didn't catch any words. Try again a little closer to the microphone.");
    outcome = "ok";
    return text;
  } catch (e) {
    if (e instanceof TranscribeRefused) throw e;
    throw new TranscribeRefused(502, "The speech-to-text service didn't answer. Try again or type instead.");
  } finally {
    // one request against the monthly allowance, like a typed question; cost isn't estimated for audio
    await tenantTx(ctx, (tx) => tx.insert(aiUsage).values({
      orgId: ctx.principal.orgId, userId: ctx.principal.userId, turnId: randomUUID(), feature: "transcribe", provider: t.provider, model: t.model,
      modelCalls: 1, latencyMs: Date.now() - started, outcome,
    })).catch(() => {});
  }
}
