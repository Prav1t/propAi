import { randomUUID } from "node:crypto";
import { capabilities, planDemo } from "../demo/intents";
import { ZERO_USAGE, type ChatEvent, type ChatHints, type ChatModel, type ChatRequest } from "../types";

// Demo mode: no language model. Plans tool calls with fixed rules and writes answers only from tool results.
// Every message it produces is stored with provider "demo" and labelled as such in the UI.

type ResultLike = {
  ok?: boolean; summary?: string; highlights?: string[]; note?: string; items?: unknown[];
  code?: string; message?: string; options?: string[];
};

export function composeFromResults(results: { name: string; content: string }[]): string {
  const parts: string[] = [];
  for (const r of results) {
    let d: ResultLike;
    try {
      d = JSON.parse(r.content);
    } catch {
      parts.push("Something went wrong reading that result.");
      continue;
    }
    if (d.ok) {
      const lines = [d.summary ?? ""];
      // record lists are shown as cards under the answer; spell out highlights only for results without records
      if (d.highlights?.length && !d.items?.length) lines.push(d.highlights.map((x) => `- ${x}`).join("\n"));
      if (d.note) lines.push(d.note);
      parts.push(lines.filter(Boolean).join("\n\n"));
    } else if (d.code === "AMBIGUOUS") {
      parts.push(`${d.message ?? "That matches more than one record."}\n\n${(d.options ?? []).map((o) => `- ${o}`).join("\n")}\n\nWhich one did you mean?`);
    } else if (d.code === "FORBIDDEN") {
      parts.push("I can't look that up with your access.");
    } else {
      parts.push(d.message ?? "I couldn't get that information.");
    }
  }
  return parts.join("\n\n");
}

export class DemoModel implements ChatModel {
  readonly provider = "demo";
  readonly model = "demo-rules-v1";
  readonly demo = true;

  async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    const hints: ChatHints = req.hints ?? { today: new Date().toISOString().slice(0, 10), timeZone: "UTC", resident: false, orgSlug: "" };
    const available = new Set(req.tools.map((t) => t.name));
    const lastUserIdx = req.messages.findLastIndex((m) => m.role === "user");
    const lastUser = req.messages[lastUserIdx];
    const after = req.messages.slice(lastUserIdx + 1);
    const text = lastUser && lastUser.role === "user" ? lastUser.content : "";
    const plan = planDemo(text, available, hints);

    // second pass: tool results for this turn are in → answer from them
    const results = after.flatMap((m) => (m.role === "tool" ? [{ name: m.name, content: m.content }] : []));
    if (after.some((m) => m.role === "assistant")) {
      let answer = composeFromResults(results);
      if (plan.kind === "tools" && plan.note) answer += `\n\n${plan.note}`;
      yield* this.say(answer || capabilities(hints, available));
      return;
    }
    if (plan.kind === "reply") {
      yield* this.say(plan.text);
      return;
    }
    for (const c of plan.calls) yield { type: "tool_call", call: { id: `demo_${randomUUID().slice(0, 8)}`, name: c.name, input: c.input } };
    yield { type: "end", stopReason: "tool_use", usage: { ...ZERO_USAGE } };
  }

  private async *say(text: string): AsyncGenerator<ChatEvent> {
    // stream in small pieces so the UI behaves as it does with a real model
    for (const piece of text.match(/[^\n]+\n*|\n+/g) ?? [text]) yield { type: "text", delta: piece };
    yield { type: "end", stopReason: "end", usage: { ...ZERO_USAGE } };
  }
}
