import "server-only";
import { and, count, desc, eq, gte, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { aiToolCalls, aiUsage, organizations, users } from "../db/schema";
import type { Tx } from "../db/client";
import { authorize } from "../authz/authorize";
import { tenantTx, type TenantCtx } from "../modules/context";
import { writeAudit } from "../audit";
import { aiConfig } from "./config";

// per-organization AI settings live in organizations.settings (jsonb) next to the other org settings
export type AiOrgSettings = { enabled: boolean; monthlyRequestCap: number | null };

export function readAiSettings(raw: unknown, defaultCap = aiConfig().defaultMonthlyCap): AiOrgSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as { aiEnabled?: boolean; aiMonthlyRequestCap?: number | null };
  return {
    enabled: s.aiEnabled !== false,
    monthlyRequestCap: s.aiMonthlyRequestCap === undefined ? defaultCap : s.aiMonthlyRequestCap,
  };
}

// first instant of the current calendar month in the org's time zone
export const monthStartSql = (tz: string) => sql`(date_trunc('month', now() at time zone ${tz}) at time zone ${tz})`;

// requests that count against the cap (refused requests don't)
export async function requestsThisMonth(tx: Tx, orgId: string, tz: string): Promise<number> {
  const [r] = await tx.select({ n: count() }).from(aiUsage)
    .where(and(eq(aiUsage.orgId, orgId), gte(aiUsage.createdAt, monthStartSql(tz)), notInArray(aiUsage.outcome, ["cap_reached", "disabled"])));
  return r.n;
}

export const aiSettingsSchema = z.object({
  enabled: z.union([z.literal("on"), z.literal("")]).optional().transform((v) => v === "on"),
  monthlyRequestCap: z.union([z.literal(""), z.coerce.number().int().min(1, "Use at least 1, or leave blank for no cap.").max(10_000_000)]).optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
});

export async function updateAiSettings(ctx: TenantCtx, input: z.infer<typeof aiSettingsSchema>) {
  authorize(ctx.principal, "ai.settings.manage");
  return tenantTx(ctx, async (tx) => {
    const [before] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, ctx.principal.orgId));
    const prev = (before.settings ?? {}) as Record<string, unknown>;
    const settings = { ...prev, aiEnabled: input.enabled, aiMonthlyRequestCap: input.monthlyRequestCap };
    await tx.update(organizations).set({ settings }).where(eq(organizations.id, ctx.principal.orgId));
    await writeAudit(tx, {
      orgId: ctx.principal.orgId, actorUserId: ctx.principal.userId, action: "ai.settings.updated", entityType: "organization", entityId: ctx.principal.orgId,
      before: { aiEnabled: prev.aiEnabled ?? true, aiMonthlyRequestCap: prev.aiMonthlyRequestCap ?? null }, after: { aiEnabled: input.enabled, aiMonthlyRequestCap: input.monthlyRequestCap },
    }, ctx.meta);
  });
}

// the admin usage page: this month's requests, tokens and estimated cost, by person and by tool, plus recent tool calls
export async function usageOverview(ctx: TenantCtx) {
  const p = ctx.principal;
  authorize(p, "ai.settings.manage");
  const tz = p.orgTimezone ?? "America/Vancouver";
  return tenantTx(ctx, async (tx) => {
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, p.orgId));
    const since = monthStartSql(tz);
    const base = and(eq(aiUsage.orgId, p.orgId), gte(aiUsage.createdAt, since));
    const [totals] = await tx.select({
      requests: sql<number>`count(*) filter (where ${aiUsage.outcome} not in ('cap_reached','disabled'))::int`,
      refused: sql<number>`count(*) filter (where ${aiUsage.outcome} in ('cap_reached','disabled'))::int`,
      failed: sql<number>`count(*) filter (where ${aiUsage.outcome} in ('error','timeout','step_limit'))::int`,
      demo: sql<number>`count(*) filter (where ${aiUsage.provider} = 'demo')::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.cachedInputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
      cost: sql<number | null>`sum(${aiUsage.estCostUsd})::float`,
      unpriced: sql<number>`count(*) filter (where ${aiUsage.estCostUsd} is null and ${aiUsage.provider} <> 'demo' and ${aiUsage.modelCalls} > 0)::int`,
      avgLatencyMs: sql<number | null>`round(avg(${aiUsage.latencyMs}))::int`,
    }).from(aiUsage).where(base);
    const byUser = await tx.select({
      name: users.name, email: users.email, requests: count(),
      tokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.cachedInputTokens} + ${aiUsage.outputTokens}), 0)::int`,
      cost: sql<number | null>`sum(${aiUsage.estCostUsd})::float`,
    }).from(aiUsage).leftJoin(users, eq(users.id, aiUsage.userId)).where(base)
      .groupBy(users.id, users.name, users.email).orderBy(desc(count())).limit(25);
    const byModel = await tx.select({ provider: aiUsage.provider, model: aiUsage.model, requests: count() }).from(aiUsage).where(base)
      .groupBy(aiUsage.provider, aiUsage.model).orderBy(desc(count()));
    const toolBase = and(eq(aiToolCalls.orgId, p.orgId), gte(aiToolCalls.createdAt, since));
    const byTool = await tx.select({
      tool: aiToolCalls.tool, calls: count(),
      problems: sql<number>`count(*) filter (where ${aiToolCalls.outcome} in ('error','invalid','unknown_tool'))::int`,
      denied: sql<number>`count(*) filter (where ${aiToolCalls.outcome} = 'denied')::int`,
      avgMs: sql<number>`round(avg(${aiToolCalls.durationMs}))::int`,
    }).from(aiToolCalls).where(toolBase).groupBy(aiToolCalls.tool).orderBy(desc(count()));
    const recent = await tx.select({
      id: aiToolCalls.id, tool: aiToolCalls.tool, outcome: aiToolCalls.outcome, summary: aiToolCalls.summary, args: aiToolCalls.args, durationMs: aiToolCalls.durationMs,
      createdAt: aiToolCalls.createdAt, userName: users.name, turnId: aiToolCalls.turnId,
    }).from(aiToolCalls).leftJoin(users, eq(users.id, aiToolCalls.userId)).where(eq(aiToolCalls.orgId, p.orgId)).orderBy(desc(aiToolCalls.createdAt)).limit(40);
    const settings = readAiSettings(org?.settings);
    return { settings, totals, byUser, byModel, byTool, recent, tz };
  });
}
