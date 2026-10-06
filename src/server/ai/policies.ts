import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { aiPolicies, properties } from "../db/schema";
import type { Tx } from "../db/client";
import { authorize } from "../authz/authorize";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { isPolicyKey, POLICY_ACTIONS, POLICY_KEYS, validateMode, type PolicyKey, type PolicyMode, type PolicyRule } from "./policy";

export async function loadPolicyRules(tx: Tx, orgId: string): Promise<PolicyRule[]> {
  const rows = await tx.select({ action: aiPolicies.action, propertyId: aiPolicies.propertyId, mode: aiPolicies.mode }).from(aiPolicies).where(eq(aiPolicies.orgId, orgId));
  return rows.map((r) => ({ action: r.action, propertyId: r.propertyId, mode: r.mode as PolicyMode }));
}

export const policySchema = z.object({
  action: z.string().refine(isPolicyKey, "Unknown action."),
  propertyId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  mode: z.enum(["default", "auto", "confirm", "deny"]),
});

// admins set a rule per action, for the whole organization or one property; "default" removes the rule
export async function setPolicy(ctx: TenantCtx, input: z.infer<typeof policySchema>) {
  const p = ctx.principal;
  authorize(p, "ai.settings.manage");
  const key = input.action as PolicyKey;
  if (input.mode !== "default") {
    const problem = validateMode(key, input.mode);
    if (problem) throw new ValidationError(problem, "mode");
  }
  return tenantTx(ctx, async (tx) => {
    if (input.propertyId) {
      const [pr] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.id, input.propertyId), eq(properties.orgId, p.orgId)));
      if (!pr) throw new ValidationError("Choose a property.", "propertyId");
    }
    const where = and(eq(aiPolicies.orgId, p.orgId), eq(aiPolicies.action, key), input.propertyId ? eq(aiPolicies.propertyId, input.propertyId) : isNull(aiPolicies.propertyId));
    const [before] = await tx.select().from(aiPolicies).where(where);
    if (input.mode === "default") {
      if (before) await tx.delete(aiPolicies).where(eq(aiPolicies.id, before.id));
    } else if (before) {
      await tx.update(aiPolicies).set({ mode: input.mode, updatedByUserId: p.userId }).where(eq(aiPolicies.id, before.id));
    } else {
      await tx.insert(aiPolicies).values({ orgId: p.orgId, propertyId: input.propertyId, action: key, mode: input.mode, updatedByUserId: p.userId });
    }
    await auditAs(tx, ctx, "ai.policy.updated", "ai_policy", before?.id ?? null, before ? { action: key, propertyId: before.propertyId, mode: before.mode } : undefined,
      { action: key, propertyId: input.propertyId, mode: input.mode });
  });
}

export type PolicyRow = { key: PolicyKey; label: string; help: string; risk: number; orgMode: PolicyMode | null; overrides: { propertyId: string; propertyName: string; mode: PolicyMode }[] };

export async function listPolicies(ctx: TenantCtx): Promise<{ rows: PolicyRow[]; properties: { id: string; name: string }[] }> {
  authorize(ctx.principal, "ai.settings.manage");
  return tenantTx(ctx, async (tx) => {
    const rules = await tx.select({ action: aiPolicies.action, propertyId: aiPolicies.propertyId, mode: aiPolicies.mode, propertyName: properties.name })
      .from(aiPolicies).leftJoin(properties, eq(properties.id, aiPolicies.propertyId)).where(eq(aiPolicies.orgId, ctx.principal.orgId)).orderBy(sql`${properties.name} asc nulls first`);
    const props = await tx.select({ id: properties.id, name: properties.name }).from(properties).where(eq(properties.orgId, ctx.principal.orgId)).orderBy(asc(properties.name));
    return {
      properties: props,
      rows: POLICY_KEYS.map((key) => ({
        key, label: POLICY_ACTIONS[key].label, help: POLICY_ACTIONS[key].help, risk: POLICY_ACTIONS[key].risk,
        orgMode: (rules.find((r) => r.action === key && !r.propertyId)?.mode as PolicyMode | undefined) ?? null,
        overrides: rules.filter((r) => r.action === key && r.propertyId).map((r) => ({ propertyId: r.propertyId!, propertyName: r.propertyName ?? "", mode: r.mode as PolicyMode })),
      })),
    };
  });
}
