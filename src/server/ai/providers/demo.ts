import { randomUUID } from "node:crypto";
import { capabilities, planDemo } from "../demo/intents";
import { ACTION_TOOL_NAMES } from "../tools/names";
import { ZERO_USAGE, type ChatEvent, type ChatHints, type ChatModel, type ChatRequest } from "../types";

// Demo mode: no language model. Plans tool calls with fixed rules and writes answers only from tool results.
// Every message it produces is stored with provider "demo" and labelled as such in the UI.

type ResultLike = {
  ok?: boolean; cite?: boolean; summary?: string; highlights?: string[]; note?: string; items?: unknown[]; count?: number;
  code?: string; message?: string; options?: string[]; status?: "awaiting_approval" | "executed";
  facts?: { draft?: { title?: string; body: string } };
};

const PREPARED = /^Prepared, not done yet: (.*?)\. It runs only if/;

export function composeFromResults(results: { name: string; content: string }[]): string {
  const parsed = results.map((r) => {
    try {
      return { name: r.name, d: JSON.parse(r.content) as ResultLike };
    } catch {
      return { name: r.name, d: null };
    }
  });
  const pending = parsed.filter((r) => r.d?.ok && r.d.status === "awaiting_approval");
  const creatingWo = pending.some((r) => r.name === "create_work_order");
  const parts: string[] = [];
  for (const { name, d } of parsed) {
    if (!d) {
      parts.push("Something went wrong reading that result.");
      continue;
    }
    if (d.ok && d.status === "awaiting_approval") continue; // summarised together below
    if (d.ok && name === "search_work_orders" && creatingWo) {
      // the duplicate check that runs before a new work order
      parts.push(d.count ? `Heads-up — there ${d.count === 1 ? "is already a similar open request" : `are already ${d.count} similar open requests`} (below). Check it isn't the same problem before you approve a new one.` : "No similar open requests, so this won't be a duplicate.");
      continue;
    }
    if (d.ok && d.cite) {
      // knowledge answers are quotes from the passages with their citations; nothing is paraphrased
      parts.push(d.items?.length && d.highlights?.length ? d.highlights.join("\n\n")
        : `I couldn't find anything about that in the documents and knowledge base you can access. The management office can help, and an administrator can add it to the knowledge base.`);
      continue;
    }
    if (d.ok) {
      const lines = [d.summary ?? ""];
      // record lists are shown as cards under the answer; spell out highlights only for results without records
      if (d.highlights?.length && !d.items?.length && d.status !== "executed") lines.push(d.highlights.map((x) => `- ${x}`).join("\n"));
      if (d.note) lines.push(d.note);
      parts.push(lines.filter(Boolean).join("\n\n"));
    } else if (d.code === "AMBIGUOUS") {
      parts.push(`${d.message ?? "That matches more than one record."}\n\n${(d.options ?? []).map((o) => `- ${o}`).join("\n")}\n\nWhich one did you mean?`);
    } else if (d.code === "FORBIDDEN") {
      parts.push(ACTION_TOOL_NAMES.includes(name as never) ? `I can't do that with your access: ${d.message ?? ""}`.trim() : "I can't look that up with your access.");
    } else {
      parts.push(d.message ?? "I couldn't get that information.");
    }
  }
  if (pending.length) {
    const titles = pending.map((r) => r.d!.summary!.match(PREPARED)?.[1] ?? r.d!.summary!);
    const drafts = pending.some((r) => r.name === "send_announcement" || r.name === "message_resident");
    parts.push(
      (titles.length === 1 ? `I've prepared this for you to approve: **${titles[0]}**.` : `I've prepared ${titles.length} changes for you to approve:\n${titles.map((t) => `- ${t}`).join("\n")}`) +
      `\n\nNothing has changed yet — review the plan below, then **Approve**, **Edit** or **Cancel**.` +
      (drafts ? " I can also redraft the message to be friendlier, more formal, shorter or more urgent." : ""),
    );
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
    const plan = planDemo(text, available, hints, req.messages.slice(0, Math.max(0, lastUserIdx)));

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
