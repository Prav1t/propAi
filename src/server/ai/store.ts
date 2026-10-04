import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { aiConversations, aiMessages, aiToolCalls, aiUsage } from "../db/schema";
import type { Tx } from "../db/client";
import { NotFoundError } from "../authz/authorize";
import { tenantTx, type TenantCtx } from "../modules/context";
import type { ChatMessage, ToolCall } from "./types";
import type { ToolDisplay } from "./tools/registry";
import type { AiMode } from "./modes";

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
export function toChatHistory(rows: (typeof aiMessages.$inferSelect)[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i];
    if (m.role === "user") out.push({ role: "user", content: m.content });
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
        if (m.content.trim()) out.push({ role: "assistant", content: m.content });
      } else {
        if (m.content.trim() || calls.length) out.push({ role: "assistant", content: m.content, ...(calls.length ? { toolCalls: calls } : {}) });
        if (calls.length) out.push(...results);
      }
      i = j - 1;
    }
  }
  // a replayed history must start with the user
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

export async function historyForModel(tx: Tx, conversationId: string, maxMessages = 40): Promise<ChatMessage[]> {
  const rows = await tx.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(desc(aiMessages.seq)).limit(maxMessages);
  return toChatHistory(rows.reverse());
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
        turns.push({ turnId: m.turnId, question: m.content, askedAt: m.createdAt, steps: [], answer: "", provider: null, model: null, outcome: usage.find((u) => u.turnId === m.turnId)?.outcome ?? null });
        continue;
      }
      const t = turns.findLast((x) => x.turnId === m.turnId);
      if (!t || m.role !== "assistant") continue;
      if (m.content.trim()) t.answer += (t.answer ? "\n\n" : "") + m.content.trim();
      t.provider = m.provider ?? t.provider;
      t.model = m.model ?? t.model;
    }
    for (const c of calls) {
      const t = turns.find((x) => x.turnId === c.turnId);
      t?.steps.push({ callId: c.callId, tool: c.tool, outcome: c.outcome, summary: c.summary, display: (c.display as ToolDisplay | null) ?? null });
    }
    return { conversation, turns };
  });
}

export async function archiveConversation(ctx: TenantCtx, id: string) {
  return tenantTx(ctx, async (tx) => {
    await loadConversation(tx, ctx, id);
    await tx.update(aiConversations).set({ archivedAt: new Date() }).where(eq(aiConversations.id, id));
  });
}
