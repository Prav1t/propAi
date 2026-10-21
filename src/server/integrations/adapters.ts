import "server-only";
import { safePost, type SafeResponse } from "../net/safe-fetch";
import type { ChatProvider } from "@/lib/integrations";

// Provider adapters (Iteration 10). Each builds the provider's request and reports success; the HTTP call is injected
// so the request shapes are unit-tested without the network.

export type Poster = (url: string, body: string, headers: Record<string, string>) => Promise<SafeResponse>;
const defaultPoster: Poster = (url, body, headers) => safePost(url, body, headers, { timeoutMs: 10_000 });

export function chatPayload(provider: ChatProvider, text: string): Record<string, unknown> {
  if (provider === "slack") return { text };
  // Teams workflows accept an Adaptive Card message
  return {
    type: "message",
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4", body: [{ type: "TextBlock", text, wrap: true }] } }],
  };
}

export async function postChatMessage(provider: ChatProvider, webhookUrl: string, text: string, post: Poster = defaultPoster): Promise<void> {
  const res = await post(webhookUrl, JSON.stringify(chatPayload(provider, text.slice(0, 3000))), { "content-type": "application/json" });
  if (res.status < 200 || res.status >= 300) throw new Error(`${provider === "slack" ? "Slack" : "Teams"} answered ${res.status}${res.body ? `: ${res.body.slice(0, 120)}` : ""}`);
}

export type SmsCreds = { accountSid: string; authToken: string; fromNumber: string };
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function twilioRequest(c: SmsCreds, to: string, body: string) {
  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`,
    init: {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: c.fromNumber, Body: body.slice(0, 1600) }).toString(),
    },
  };
}

// the Twilio host is fixed and public, so a plain fetch is safe here
export async function sendSms(c: SmsCreds, to: string, body: string, f: FetchLike = fetch as unknown as FetchLike): Promise<{ sid: string }> {
  const { url, init } = twilioRequest(c, to, body);
  const res = await f(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
  if (!res.ok) throw new Error(`Twilio answered ${res.status}${json.message ? `: ${json.message}` : ""}`);
  return { sid: json.sid ?? "" };
}

// Calendar sync (Google / Outlook) is planned. This is the contract an adapter will implement; nothing calls it yet.
export interface CalendarSync {
  readonly provider: "google_calendar" | "outlook_calendar";
  upsertEvent(e: { externalId?: string; title: string; startsAt: Date; endsAt: Date; location?: string; description?: string }): Promise<{ externalId: string }>;
  deleteEvent(externalId: string): Promise<void>;
}
