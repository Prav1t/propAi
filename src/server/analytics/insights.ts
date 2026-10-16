import "server-only";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { bookings, buildings, inspections, properties, workOrders } from "../db/schema";
import { tenantTx, type TenantCtx } from "../modules/context";
import { scopeCondition } from "../modules/scope";
import { OPEN_STATUSES } from "../modules/maintenance/rules";
import { vendorPerformance } from "../modules/analytics/vendors";
import { facilityStats } from "../modules/assets/service";
import { loadAnalyticsSettings } from "./settings";
import { addDays, localDate } from "./period";
import { WO_CATEGORY } from "@/lib/ops-labels";

// Proactive insights (Iteration 9): patterns found in recorded data, each with the numbers it rests on and a link
// to the records. Nothing here is a prediction; thresholds are fixed and stated in the text.

export type Insight = {
  key: string; tone: "danger" | "warning" | "accent" | "neutral";
  title: string; detail: string; href: string; // relative to /o/{org}
  numbers: Record<string, number>;
};

const DAY = 86_400_000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function computeInsights(ctx: TenantCtx, now = new Date()): Promise<Insight[]> {
  const p = ctx.principal;
  if (!p.permissions.has("analytics.read") && !p.permissions.has("workorder.manage")) return [];
  const tz = p.orgTimezone ?? "UTC";
  const out: Insight[] = [];

  if (p.permissions.has("workorder.read")) {
    await tenantTx(ctx, async (tx) => {
      const scope = scopeCondition(p, { property: workOrders.propertyId, building: workOrders.buildingId });
      const lead = (await loadAnalyticsSettings(tx, p.orgId)).slaWarningMinutes;

      // requests about to miss their resolution target
      const [soon] = await tx.select({ n: sql<number>`count(*)::int` }).from(workOrders)
        .where(and(eq(workOrders.orgId, p.orgId), scope, inArray(workOrders.status, OPEN_STATUSES), gte(workOrders.resolveDueAt, now), lt(workOrders.resolveDueAt, new Date(now.getTime() + lead * 60_000))));
      if (soon.n) out.push({
        key: "sla_approaching", tone: "warning", title: `${plural(soon.n, "request is", "requests are")} close to the resolution target`,
        detail: `Due within the next ${lead >= 120 ? `${Math.round(lead / 60)} hours` : `${lead} minutes`} and still open.`, href: "/maintenance?view=due_soon", numbers: { requests: soon.n, leadMinutes: lead },
      });

      // a category spiking in one building: last 7 days vs the weekly average of the 4 weeks before
      const since35 = new Date(now.getTime() - 35 * DAY);
      const since7 = new Date(now.getTime() - 7 * DAY);
      const spikes = await tx.select({
        propertyId: workOrders.propertyId, propertyName: properties.name, buildingId: workOrders.buildingId, buildingName: buildings.name, category: workOrders.category,
        cur: sql<number>`count(*) filter (where ${workOrders.createdAt} >= ${since7})::int`,
        prev: sql<number>`count(*) filter (where ${workOrders.createdAt} < ${since7})::int`,
      }).from(workOrders).innerJoin(properties, eq(properties.id, workOrders.propertyId)).leftJoin(buildings, eq(buildings.id, workOrders.buildingId))
        .where(and(eq(workOrders.orgId, p.orgId), scope, gte(workOrders.createdAt, since35), lt(workOrders.createdAt, now)))
        .groupBy(workOrders.propertyId, properties.name, workOrders.buildingId, buildings.name, workOrders.category);
      for (const s of spikes) {
        const weekly = s.prev / 4;
        if (s.cur >= 3 && s.cur >= 2 * weekly && s.cur - weekly >= 2) {
          const place = s.buildingName ? `${s.buildingName}, ${s.propertyName}` : s.propertyName;
          const cat = WO_CATEGORY[s.category] ?? s.category;
          out.push({
            key: `spike:${s.buildingId ?? s.propertyId}:${s.category}`, tone: "warning",
            title: `${cat} requests up at ${place}`,
            detail: `${s.cur} in the last 7 days, against an average of ${Math.round(weekly * 10) / 10} a week over the 4 weeks before.`,
            href: `/maintenance?view=all&property=${s.propertyId}${s.buildingId ? `&building=${s.buildingId}` : ""}&category=${s.category}&since=${addDays(localDate(now, tz), -6)}`,
            numbers: { last7Days: s.cur, weeklyAverageBefore: Math.round(weekly * 10) / 10 },
          });
        }
      }
    });
  }

  // vendors repeatedly missing their targets
  if (p.permissions.has("workorder.read") && p.permissions.has("vendor.read")) {
    const perf = await vendorPerformance(ctx, { from: new Date(now.getTime() - 30 * DAY), to: now });
    for (const v of perf.filter((x) => x.completedLate + x.overdueNow >= 3).sort((a, b) => (b.completedLate + b.overdueNow) - (a.completedLate + a.overdueNow)).slice(0, 3)) {
      out.push({
        key: `vendor:${v.vendorId}`, tone: "danger", title: `${v.name} is missing SLA targets`,
        detail: `${plural(v.completedLate, "job")} completed late in the last 30 days and ${plural(v.overdueNow, "job")} overdue right now.`,
        href: `/vendors/${v.vendorId}`, numbers: { completedLate: v.completedLate, overdueNow: v.overdueNow },
      });
    }
  }

  // inspection failures rising: last 30 days vs the 30 before
  if (p.permissions.has("inspection.read")) {
    const r = await tenantTx(ctx, (tx) => tx.select({
      cur: sql<number>`count(*) filter (where ${inspections.completedAt} >= ${new Date(now.getTime() - 30 * DAY)})::int`,
      prev: sql<number>`count(*) filter (where ${inspections.completedAt} < ${new Date(now.getTime() - 30 * DAY)})::int`,
    }).from(inspections).where(and(eq(inspections.orgId, p.orgId), eq(inspections.result, "fail"), gte(inspections.completedAt, new Date(now.getTime() - 60 * DAY)), lt(inspections.completedAt, now),
      scopeCondition(p, { property: inspections.propertyId, building: inspections.buildingId }))));
    const { cur, prev } = r[0];
    if (cur >= 2 && cur > prev) out.push({
      key: "inspections_failing", tone: "warning", title: "More inspections are failing",
      detail: `${plural(cur, "failed inspection")} in the last 30 days, up from ${prev} in the 30 days before.`, href: "/inspections?view=completed", numbers: { last30Days: cur, previous30Days: prev },
    });
  }

  // amenity bookings this month so far vs the same days last month
  if (p.permissions.has("booking.manage")) {
    const today = localDate(now, tz);
    const monthStart = `${today.slice(0, 7)}-01`;
    const day = Number(today.slice(8, 10));
    const [y, m] = today.split("-").map(Number);
    const lastStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const lastSameDay = addDays(lastStart, day - 1);
    const startOf = (iso: string) => new Date(`${iso}T00:00:00Z`);
    const r = await tenantTx(ctx, (tx) => tx.select({
      cur: sql<number>`count(*) filter (where (${bookings.startsAt} at time zone ${tz})::date between ${monthStart}::date and ${today}::date)::int`,
      prev: sql<number>`count(*) filter (where (${bookings.startsAt} at time zone ${tz})::date between ${lastStart}::date and ${lastSameDay}::date)::int`,
    }).from(bookings).where(and(eq(bookings.orgId, p.orgId), eq(bookings.status, "approved"), gte(bookings.startsAt, new Date(startOf(lastStart).getTime() - DAY)),
      scopeCondition(p, { property: bookings.propertyId, building: bookings.buildingId }))));
    const { cur, prev } = r[0];
    if (prev >= 5 && Math.abs(cur - prev) / prev >= 0.3) {
      const pct = Math.round(((cur - prev) / prev) * 100);
      out.push({
        key: "bookings_change", tone: "accent", title: `Amenity bookings are ${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% this month`,
        detail: `${cur} confirmed bookings so far this month, against ${prev} by the same day last month.`, href: "/amenities/bookings", numbers: { thisMonth: cur, lastMonthSameDays: prev, changePct: pct },
      });
    }
  }

  // equipment with repeat failures (3+ requests in 90 days)
  const fac = await facilityStats(ctx);
  for (const a of fac?.repeat.slice(0, 3) ?? []) {
    out.push({
      key: `asset:${a.id}`, tone: "warning", title: `${a.name} keeps needing repairs`,
      detail: `${a.count} maintenance requests in the last 90 days at ${a.propertyName}.`, href: `/assets/${a.id}`, numbers: { requests90Days: a.count },
    });
  }

  const rank = { danger: 0, warning: 1, accent: 2, neutral: 3 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
}
