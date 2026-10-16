import "server-only";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { assets, properties, units } from "../db/schema";
import { tenantTx, type TenantCtx } from "../modules/context";
import { visiblePropertyIds } from "../modules/scope";
import { canReadMetric, fmtValue, metricBreakdown, type MetricKey, type Unit } from "./metrics";
import { resolvePeriod, type Period } from "./period";
import { loadAnalyticsSettings } from "./settings";
import { combineHealth, healthGrade, HEALTH_FACTOR_INFO, HEALTH_FACTORS, scoreFactor, type HealthFactor, type HealthGrade } from "@/lib/analytics-labels";

// Property health score (Iteration 9): a weighted average of factor scores, each computed from recorded data with
// a fixed, documented rule. Every factor carries its raw value, its score, its weight and a link to the records behind it.

export type HealthFactorResult = {
  factor: HealthFactor; label: string; measures: string; scoring: string;
  value: number | null; valueText: string; score: number | null; weight: number; points: number | null;
  href: string | null; unavailable?: string; // why a factor has no score (no data, or not visible to this reader)
};
export type PropertyHealth = {
  propertyId: string; name: string; units: number; score: number | null; grade: HealthGrade | null;
  factors: HealthFactorResult[]; weakest: HealthFactorResult | null;
};

const METRIC_FOR: Partial<Record<HealthFactor, MetricKey[]>> = {
  sla: ["sla_compliance"], response: ["response_compliance"], overdue: ["overdue_now", "open_backlog"], backlog: ["open_backlog"],
  complaints: ["complaints_created"], incidents: ["serious_incidents"], inspections: ["inspection_failure_rate"], availability: ["downtime_hours"],
};

export async function propertyHealth(ctx: TenantCtx, opts: { propertyId?: string | null; now?: Date } = {}): Promise<PropertyHealth[]> {
  const p = ctx.principal;
  const tz = p.orgTimezone ?? "UTC";
  const now = opts.now ?? new Date();
  const d30 = resolvePeriod("30d", tz, now);
  const d90 = resolvePeriod("90d", tz, now);
  const visible = visiblePropertyIds(p);
  const { props, weights, unitCounts, assetCounts } = await tenantTx(ctx, async (tx) => {
    const props = await tx.select({ id: properties.id, name: properties.name }).from(properties)
      .where(and(eq(properties.orgId, p.orgId), visible === null ? undefined : visible.length ? inArray(properties.id, visible) : sql`false`, opts.propertyId ? eq(properties.id, opts.propertyId) : undefined))
      .orderBy(asc(properties.name));
    const ids = props.map((x) => x.id);
    const unitCounts = ids.length ? await tx.select({ id: units.propertyId, n: count() }).from(units).where(and(eq(units.orgId, p.orgId), inArray(units.propertyId, ids))).groupBy(units.propertyId) : [];
    const assetCounts = ids.length ? await tx.select({ id: assets.propertyId, n: count() }).from(assets).where(and(eq(assets.orgId, p.orgId), inArray(assets.propertyId, ids), sql`${assets.status} <> 'retired'`)).groupBy(assets.propertyId) : [];
    return { props, weights: (await loadAnalyticsSettings(tx, p.orgId)).healthWeights, unitCounts, assetCounts };
  });
  if (!props.length) return [];

  // one breakdown-by-property query per metric, shared by every property
  const byProp = async (key: MetricKey, period: Period | null) => {
    const rows = canReadMetric(p, key) ? await metricBreakdown(ctx, key, "property", period, opts.propertyId ? { propertyId: opts.propertyId } : {}, 50) : null;
    return rows ? new Map(rows.map((r) => [r.key, r.value])) : null;
  };
  const [sla, resp, overdue, open, complaints, serious, failRate, downtime] = await Promise.all([
    byProp("sla_compliance", d30), byProp("response_compliance", d30), byProp("overdue_now", null), byProp("open_backlog", null),
    byProp("complaints_created", d30), byProp("serious_incidents", d30), byProp("inspection_failure_rate", d90), byProp("downtime_hours", d30),
  ]);
  const unitsOf = new Map(unitCounts.map((u) => [u.id, u.n]));
  const assetsOf = new Map(assetCounts.map((a) => [a.id, a.n]));
  const hoursIn30 = d30.days * 24;

  return props.map((prop) => {
    const nUnits = unitsOf.get(prop.id) ?? 0;
    const nAssets = assetsOf.get(prop.id) ?? 0;
    const get = (m: Map<string, number | null> | null) => (m ? m.get(prop.id) ?? null : undefined);
    const per100 = (n: number | null | undefined) => (n === undefined ? undefined : nUnits ? ((n ?? 0) / nUnits) * 100 : null);
    const o = get(open);
    const raw: Record<HealthFactor, { value: number | null | undefined; unit: Unit | "per100"; href: string | null; empty?: string }> = {
      sla: { value: get(sla), unit: "percent", href: `/maintenance?view=completed&property=${prop.id}`, empty: "No requests with a target were completed in 30 days." },
      response: { value: get(resp), unit: "percent", href: `/maintenance?view=all&property=${prop.id}`, empty: "No requests with a response target in 30 days." },
      overdue: { value: o === undefined ? undefined : (o ?? 0) === 0 ? 0 : (((get(overdue) ?? 0) as number) / (o as number)) * 100, unit: "percent", href: `/maintenance?view=overdue&property=${prop.id}` },
      backlog: { value: per100(o), unit: "per100", href: `/maintenance?property=${prop.id}`, empty: "No units recorded." },
      complaints: { value: per100(get(complaints)), unit: "per100", href: `/complaints?view=all&property=${prop.id}`, empty: "No units recorded." },
      incidents: { value: (() => { const v = get(serious); return v === undefined ? undefined : v ?? 0; })(), unit: "count", href: `/incidents?property=${prop.id}` },
      inspections: { value: get(failRate), unit: "percent", href: `/inspections?view=completed&property=${prop.id}`, empty: "No inspections completed in 90 days." },
      availability: { value: (() => { const v = get(downtime); return v === undefined ? undefined : nAssets ? Math.max(0, 100 - ((v ?? 0) / (nAssets * hoursIn30)) * 100) : null; })(), unit: "percent", href: `/assets?property=${prop.id}`, empty: "No equipment registered." },
    };
    const parts = HEALTH_FACTORS.map((f) => ({ factor: f, score: raw[f].value === undefined ? null : scoreFactor(f, raw[f].value ?? null), weight: weights[f] }));
    const { score, contributions } = combineHealth(parts);
    const factors: HealthFactorResult[] = contributions.map((c) => {
      const r = raw[c.factor];
      const info = HEALTH_FACTOR_INFO[c.factor];
      const v = r.value ?? null;
      const valueText = v === null ? "—" : r.unit === "per100" ? `${(Math.round(v * 10) / 10).toLocaleString("en-CA")} per 100 units` : fmtValue(Math.round(v * 10) / 10, r.unit);
      return {
        factor: c.factor, label: info.label, measures: info.measures, scoring: info.scoring, value: v === null ? null : Math.round(v * 10) / 10, valueText,
        score: c.score, weight: c.weight, points: c.points, href: r.href,
        ...(r.value === undefined ? { unavailable: "Not included: your role can't see this data." } : c.score === null ? { unavailable: r.empty ?? "No data in the period." } : c.weight <= 0 ? { unavailable: "Weight is 0 in settings." } : {}),
      };
    });
    const scored = factors.filter((f) => f.score !== null && f.weight > 0);
    const weakest = scored.length ? scored.reduce((a, b) => ((b.score as number) < (a.score as number) ? b : a)) : null;
    return { propertyId: prop.id, name: prop.name, units: nUnits, score, grade: healthGrade(score), factors, weakest };
  });
}

export const canSeeHealth = (ctx: TenantCtx) => ctx.principal.permissions.has("analytics.read") && Object.values(METRIC_FOR).flat().some((k) => canReadMetric(ctx.principal, k as MetricKey));
