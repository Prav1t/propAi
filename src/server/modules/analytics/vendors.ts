import "server-only";
import { and, eq, gte, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import { vendors, workOrders } from "../../db/schema";
import { ForbiddenError } from "../../authz/authorize";
import { tenantTx, type TenantCtx } from "../context";
import { scopeCondition } from "../scope";
import { OPEN_STATUSES } from "../maintenance/rules";

export type VendorPerf = {
  vendorId: string; name: string;
  completed: number; avgResolveHours: number | null; avgResponseHours: number | null; onTimePct: number | null; completedLate: number;
  openNow: number; overdueNow: number; spend: number | null;
};

// vendor scorecard from work orders in the principal's scope: jobs completed in [from, to) plus what is open right now
export async function vendorPerformance(ctx: TenantCtx, opts: { from: Date; to: Date; propertyId?: string; buildingId?: string; category?: string }): Promise<VendorPerf[]> {
  const p = ctx.principal;
  if (!p.permissions.has("workorder.read") || !p.permissions.has("vendor.read")) throw new ForbiddenError();
  const showSpend = p.permissions.has("finance.read");
  const base: SQL | undefined = and(
    eq(workOrders.orgId, p.orgId), isNotNull(workOrders.vendorId),
    scopeCondition(p, { property: workOrders.propertyId, building: workOrders.buildingId }),
    opts.propertyId ? eq(workOrders.propertyId, opts.propertyId) : undefined,
    opts.buildingId ? eq(workOrders.buildingId, opts.buildingId) : undefined,
    opts.category ? eq(workOrders.category, opts.category) : undefined,
  );
  const inPeriod = sql`(${workOrders.completedAt} >= ${opts.from} and ${workOrders.completedAt} < ${opts.to})`;
  const open = sql`${workOrders.status} in (${sql.join(OPEN_STATUSES.map((s) => sql`${s}`), sql`, `)})`;
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({
      vendorId: vendors.id, name: vendors.name,
      completed: sql<number>`count(*) filter (where ${inPeriod})::int`,
      avgResolveHours: sql<number | null>`round((avg(extract(epoch from (${workOrders.completedAt} - ${workOrders.createdAt}))) filter (where ${inPeriod}) / 3600)::numeric, 1)::float`,
      avgResponseHours: sql<number | null>`round((avg(extract(epoch from (${workOrders.firstResponseAt} - ${workOrders.createdAt}))) filter (where ${inPeriod} and ${workOrders.firstResponseAt} is not null) / 3600)::numeric, 1)::float`,
      onTime: sql<number>`count(*) filter (where ${inPeriod} and ${workOrders.resolveDueAt} is not null and ${workOrders.completedAt} <= ${workOrders.resolveDueAt})::int`,
      withDue: sql<number>`count(*) filter (where ${inPeriod} and ${workOrders.resolveDueAt} is not null)::int`,
      openNow: sql<number>`count(*) filter (where ${open})::int`,
      overdueNow: sql<number>`count(*) filter (where ${open} and ${workOrders.resolveDueAt} < now())::int`,
      spend: sql<number>`coalesce(sum(${workOrders.cost}) filter (where ${inPeriod}), 0)::float`,
    })
      .from(workOrders).innerJoin(vendors, eq(vendors.id, workOrders.vendorId))
      .where(and(base, or(and(gte(workOrders.completedAt, opts.from), lt(workOrders.completedAt, opts.to)), inArray(workOrders.status, OPEN_STATUSES))))
      .groupBy(vendors.id, vendors.name);
    return rows.map((r) => ({
      vendorId: r.vendorId, name: r.name, completed: r.completed, avgResolveHours: r.avgResolveHours, avgResponseHours: r.avgResponseHours,
      onTimePct: r.withDue ? Math.round((r.onTime / r.withDue) * 100) : null, completedLate: r.withDue - r.onTime,
      openNow: r.openNow, overdueNow: r.overdueNow, spend: showSpend ? Math.round(r.spend * 100) / 100 : null,
    })).sort((a, b) => (b.avgResolveHours ?? -1) - (a.avgResolveHours ?? -1) || a.name.localeCompare(b.name));
  });
}
