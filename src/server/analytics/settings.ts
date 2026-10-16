import "server-only";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Tx } from "../db/client";
import { organizations } from "../db/schema";
import { authorize } from "../authz/authorize";
import { tenantTx, type TenantCtx } from "../modules/context";
import { writeAudit } from "../audit";
import { DEFAULT_HEALTH_WEIGHTS, HEALTH_FACTORS, type HealthFactor } from "@/lib/analytics-labels";

// organizations.settings.analytics — health-score weights, the "approaching SLA" lead time and the daily brief
export type AnalyticsSettings = {
  healthWeights: Record<HealthFactor, number>;
  slaWarningMinutes: number; // warn this long before a request's resolution target
  briefEnabled: boolean;
  briefTime: string; // HH:mm in the org's time zone
};

export const DEFAULT_ANALYTICS: AnalyticsSettings = { healthWeights: DEFAULT_HEALTH_WEIGHTS, slaWarningMinutes: 120, briefEnabled: true, briefTime: "07:00" };

export function analyticsSettings(orgSettings: unknown): AnalyticsSettings {
  const raw = (orgSettings && typeof orgSettings === "object" ? (orgSettings as { analytics?: Partial<AnalyticsSettings> }).analytics : undefined) ?? {};
  const w = { ...DEFAULT_HEALTH_WEIGHTS };
  for (const f of HEALTH_FACTORS) {
    const v = Number(raw.healthWeights?.[f]);
    if (Number.isFinite(v) && v >= 0 && v <= 100) w[f] = v;
  }
  const lead = Number(raw.slaWarningMinutes);
  return {
    healthWeights: w,
    slaWarningMinutes: Number.isFinite(lead) && lead >= 15 && lead <= 2880 ? lead : DEFAULT_ANALYTICS.slaWarningMinutes,
    briefEnabled: raw.briefEnabled ?? DEFAULT_ANALYTICS.briefEnabled,
    briefTime: typeof raw.briefTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.briefTime) ? raw.briefTime : DEFAULT_ANALYTICS.briefTime,
  };
}

const weight = z.coerce.number().int().min(0, "0–100").max(100, "0–100");
export const analyticsSettingsSchema = z.object({
  ...Object.fromEntries(HEALTH_FACTORS.map((f) => [`w_${f}`, weight])) as Record<`w_${HealthFactor}`, typeof weight>,
  slaWarningMinutes: z.coerce.number().int().min(15, "At least 15 minutes.").max(2880, "At most 48 hours."),
  briefEnabled: z.union([z.literal("on"), z.literal("true"), z.literal("")]).optional().transform((v) => v === "on" || v === "true"),
  briefTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 07:00."),
}).refine((v) => HEALTH_FACTORS.some((f) => v[`w_${f}`] > 0), { message: "At least one factor needs a weight above 0.", path: ["w_sla"] });

export async function loadAnalyticsSettings(tx: Tx, orgId: string): Promise<AnalyticsSettings> {
  const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  return analyticsSettings(o?.settings);
}

export function getAnalyticsSettings(ctx: TenantCtx) {
  return tenantTx(ctx, (tx) => loadAnalyticsSettings(tx, ctx.principal.orgId));
}

export async function saveAnalyticsSettings(ctx: TenantCtx, input: z.infer<typeof analyticsSettingsSchema>) {
  authorize(ctx.principal, "org.settings.manage");
  return tenantTx(ctx, async (tx) => {
    const [o] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, ctx.principal.orgId));
    const before = analyticsSettings(o.settings);
    const after: AnalyticsSettings = {
      healthWeights: Object.fromEntries(HEALTH_FACTORS.map((f) => [f, input[`w_${f}`]])) as Record<HealthFactor, number>,
      slaWarningMinutes: input.slaWarningMinutes, briefEnabled: input.briefEnabled, briefTime: input.briefTime,
    };
    const settings = { ...((o.settings as Record<string, unknown>) ?? {}), analytics: after };
    await tx.update(organizations).set({ settings }).where(eq(organizations.id, ctx.principal.orgId));
    await writeAudit(tx, { orgId: ctx.principal.orgId, actorUserId: ctx.principal.userId, action: "org.analytics_settings.updated", entityType: "organization", entityId: ctx.principal.orgId, before, after }, ctx.meta);
    return after;
  });
}
