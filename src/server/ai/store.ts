import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { aiConversations, aiMessages, aiToolCalls, aiUsage } from "../db/schema";
import type { Tx } from "../db/client";
import { NotFoundError } from "../authz/authorize";
import { tenantTx, type TenantCtx } from "../modules/context";
import type { ChatMessage, ToolCall } from "./types";
import type { ToolDisplay } from "./tools/registry";
import type { AiMode } from "./modes";
import { plansForConversation, type PlanView } from "./approvals";

export type ConversationRow = typeof aiConversations.$inferSelect;

// conversations are private: RLS limits rows to the acting user, and every query here says so explicitly too
export async function loadConversation(tx: Tx, ctx: TenantCtx, id: string): Promise<ConversationRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
  const [c] = await tx.select().from(aiConversations)
    .where(and(eq(aiConversations.id, id), eq(aiConversations.orgId, ctx.principal.orgId), eq(aiConversations.userId, ctx.principal.userId), isNull(aiConversations.archivedAt)));
  if (!c) throw new NotFoundError();
  return c;
}

export async function createConversation(tx: Tx, ctx: TenantCtx, input: { mode: AiMode; title: string }): Promise<ConversationRow> {
  const [c] = await tx.insert(aiConversations).values({ orgId: ctx.principal.orgId, userId: ctx.principal.userId, mode: input.mode, title: input.title }).returning();
  return c;
}

export async function maxSeq(tx: Tx, conversationId: string): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`coalesce(max(${aiMessages.seq}), 0)::int` }).from(aiMessages).where(eq(aiMessages.conversationId, conversationId));
  return r.n;
}

const MAX_REPLAY_CHARS = 6000;

// the stored transcript → provider-neutral messages, with anything a provider would reject repaired:
// tool calls without results (an interrupted turn) are dropped, as are results without their call
// notes (keyed by turn) are appended to that turn's last assistant message: how a prepared plan was decided since
export function toChatHistory(rows: (typeof aiMessages.$inferSelect)[], notes?: Map<string, string>): ChatMessage[] {
  const out: ChatMessage[] = [];
  const turnOf: string[] = [];
  const push = (msg: ChatMessage, turnId: string) => {
    out.push(msg);
    turnOf.push(turnId);
  };
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    if (m.role === "user") push({ role: "user", content: m.content }, m.turnId);
    else if (m.role === "assistant") {
      const calls = (m.toolCalls as ToolCall[] | null) ?? [];
      const results: ChatMessage[] = [];
      let j = i + 1;
      while (j < rows.length && rows[j].role === "tool") {
        const t = rows[j];
        if (calls.some((c) => c.id === t.toolCallId)) {
          results.push({ role: "tool", toolCallId: t.toolCallId!, name: t.toolName ?? "", isError: t.isError,
            content: t.content.length > MAX_REPLAY_CHARS ? `${t.content.slice(0, MAX_REPLAY_CHARS)}…(truncated)` : t.content });
        }
        j++;
      }
      const answered = calls.filter((c) => results.some((r) => r.role === "tool" && r.toolCallId === c.id));
      if (answered.length !== calls.length) {
        if (m.content.trim()) push({ role: "assistant", content: m.content }, m.turnId);
      } else {
        if (m.content.trim() || calls.length) push({ role: "assistant", content: m.content, ...(calls.length ? { toolCalls: calls } : {}) }, m.turnId);
        if (calls.length) for (const r of results) push(r, m.turnId);
      }
      i = j - 1;
    }
  }
  if (notes?.size) {
    for (const [turnId, note] of notes) {
      const at = out.findLastIndex((msg, k) => turnOf[k] === turnId);
      if (at < 0) continue;
      const last = out[at];
      if (last.role === "assistant") out[at] = { ...last, content: last.content ? `${last.content}\n\n${note}` : note };
      else {
        out.splice(at + 1, 0, { role: "assistant", content: note });
        turnOf.splice(at + 1, 0, turnId);
      }
    }
  }
  // a replayed history must start with the user
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export async function historyForModel(tx: Tx, conversationId: string, maxMessages = 40, notes?: Map<string, string>): Promise<ChatMessage[]> {
  const rows = await tx.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(desc(aiMessages.seq)).limit(maxMessages);
  return toChatHistory(rows.reverse(), notes);
}

/* ───────────── reading for the UI ───────────── */

export async function listConversations(ctx: TenantCtx, limit = 30) {
  return tenantTx(ctx, (tx) =>
    tx.select({ id: aiConversations.id, title: aiConversations.title, mode: aiConversations.mode, lastMessageAt: aiConversations.lastMessageAt })
      .from(aiConversations)
      .where(and(eq(aiConversations.orgId, ctx.principal.orgId), eq(aiConversations.userId, ctx.principal.userId), isNull(aiConversations.archivedAt)))
      .orderBy(desc(aiConversations.lastMessageAt)).limit(limit),
  );
}

export type TurnView = {
  turnId: string;
  question: string;
  askedAt: Date;
  steps: { callId: string; tool: string; outcome: string; summary: string | null; display: ToolDisplay | null }[];
  answer: string;
  provider: string | null;
  model: string | null;
  outcome: string | null; // from ai_usage: ok | error | timeout | step_limit | cap_reached | disabled
  plan: PlanView | null; // changes prepared in this turn, waiting for (or after) the user's decision
};

export async function getConversationView(ctx: TenantCtx, id: string): Promise<{ conversation: ConversationRow; turns: TurnView[] }> {
  return tenantTx(ctx, async (tx) => {
    const conversation = await loadConversation(tx, ctx, id);
    const msgs = await tx.select().from(aiMessages).where(eq(aiMessages.conversationId, id)).orderBy(asc(aiMessages.seq)).limit(400);
    const turnIds = [...new Set(msgs.map((m) => m.turnId))];
    const calls = turnIds.length
      ? await tx.select().from(aiToolCalls).where(and(eq(aiToolCalls.orgId, ctx.principal.orgId), inArray(aiToolCalls.turnId, turnIds))).orderBy(asc(aiToolCalls.createdAt))
      : [];
    const usage = turnIds.length
      ? await tx.select({ turnId: aiUsage.turnId, outcome: aiUsage.outcome }).from(aiUsage).where(and(eq(aiUsage.orgId, ctx.principal.orgId), inArray(aiUsage.turnId, turnIds)))
      : [];
    const turns: TurnView[] = [];
    for (const m of msgs) {
      if (m.role === "user") {
        turns.push({ turnId: m.turnId, question: m.content, askedAt: m.createdAt, steps: [], answer: "", provider: null, model: null, outcome: usage.find((u) => u.turnId === m.turnId)?.outcome ?? null, plan: null });
        continue;
      }
      const t = turns.findLast((x) => x.turnId === m.turnId);
      if (!t || m.role !== "assistant") continue;
      if (m.content.trim()) t.answer += (t.answer ? "\n\n" : "") + m.content.trim();
      t.provider = m.provider ?? t.provider;
      t.model = m.model ?? t.model;
    }
    for (const c of calls) {
      // execution rows of an approved plan are shown on the plan card, not in the trail
      if (c.callId.endsWith(":run")) continue;
      const t = turns.find((x) => x.turnId === c.turnId);
      t?.steps.push({ callId: c.callId, tool: c.tool, outcome: c.outcome, summary: c.summary, display: (c.display as ToolDisplay | null) ?? null });
    }
    const plans = await plansForConversation(tx, ctx, id);
    for (const t of turns) t.plan = plans.get(t.turnId) ?? null;
    return { conversation, turns };
  });
}

export async function archiveConversation(ctx: TenantCtx, id: string) {
  return tenantTx(ctx, async (tx) => {
    await loadConversation(tx, ctx, id);
    await tx.update(aiConversations).set({ archivedAt: new Date() }).where(eq(aiConversations.id, id));
  });
}
