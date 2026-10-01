import "server-only";
import { and, count, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { complaints, incidents, inspections, properties, tasks, vendors, workOrders } from "../../db/schema";
import { tenantTx, type TenantCtx } from "../context";
import { scopeCondition } from "../scope";
import { OPEN_STATUSES } from "../maintenance/rules";

const DAY = 86_400_000;

// operational KPIs computed from live records, limited to the principal's scope
export async function getOpsKpis(ctx: TenantCtx) {
  const p = ctx.principal;
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * DAY);
  return tenantTx(ctx, async (tx) => {
    const out: Record<string, unknown> = {};
    if (p.permissions.has("workorder.read")) {
      const scope = scopeCondition(p, { property: workOrders.propertyId, building: workOrders.buildingId });
      const base = and(eq(workOrders.orgId, p.orgId), scope);
      const open = and(base, inArray(workOrders.status, OPEN_STATUSES));
      const [c] = await tx.select({
        open: count(),
        overdue: sql<number>`count(*) filter (where ${workOrders.resolveDueAt} < now())::int`,
        emergency: sql<number>`count(*) filter (where ${workOrders.isEmergency})::int`,
        unassigned: sql<number>`count(*) filter (where ${workOrders.assignedMembershipId} is null and ${workOrders.vendorId} is null)::int`,
      }).from(workOrders).where(open);
      const [perf] = await tx.select({
        completed: count(),
        avgResponseH: sql<number | null>`round((avg(extract(epoch from (${workOrders.firstResponseAt} - ${workOrders.createdAt}))) / 3600)::numeric, 1)::float`,
        avgResolveH: sql<number | null>`round((avg(extract(epoch from (${workOrders.completedAt} - ${workOrders.createdAt}))) / 3600)::numeric, 1)::float`,
        onTime: sql<number>`count(*) filter (where ${workOrders.completedAt} <= ${workOrders.resolveDueAt})::int`,
        spend: sql<number>`coalesce(sum(${workOrders.cost}), 0)::float`,
      }).from(workOrders).where(and(base, isNotNull(workOrders.completedAt), gte(workOrders.completedAt, since30)));
      const byCategory = await tx.select({ key: workOrders.category, n: count() }).from(workOrders).where(open).groupBy(workOrders.category).orderBy(desc(count())).limit(8);
      const byProperty = await tx.select({ key: properties.name, id: properties.id, n: count(), overdue: sql<number>`count(*) filter (where ${workOrders.resolveDueAt} < now())::int` })
        .from(workOrders).innerJoin(properties, eq(properties.id, workOrders.propertyId)).where(open).groupBy(properties.id, properties.name).orderBy(desc(count()));
      const byVendor = await tx.select({ key: vendors.name, id: vendors.id, n: count(), overdue: sql<number>`count(*) filter (where ${workOrders.resolveDueAt} < now())::int` })
        .from(workOrders).innerJoin(vendors, eq(vendors.id, workOrders.vendorId)).where(open).groupBy(vendors.id, vendors.name).orderBy(desc(count())).limit(6);
      out.workOrders = { ...c, ...perf, slaCompliance: perf.completed ? Math.round((perf.onTime / perf.completed) * 100) : null, byCategory, byProperty, byVendor };
    }
    if (p.permissions.has("complaint.read")) {
      const [r] = await tx.select({ open: count() }).from(complaints)
        .where(and(eq(complaints.orgId, p.orgId), scopeCondition(p, { property: complaints.propertyId, building: complaints.buildingId }), inArray(complaints.status, ["new", "acknowledged", "investigating"])));
      out.complaints = r;
    }
    if (p.permissions.has("incident.read")) {
      const [r] = await tx.select({
        last7: sql<number>`count(*) filter (where ${incidents.occurredAt} >= ${new Date(now.getTime() - 7 * DAY)})::int`,
        openSerious: sql<number>`count(*) filter (where ${incidents.status} in ('open','investigating') and ${incidents.severity} in ('high','critical'))::int`,
        open: sql<number>`count(*) filter (where ${incidents.status} in ('open','investigating'))::int`,
      }).from(incidents).where(and(eq(incidents.orgId, p.orgId), scopeCondition(p, { property: incidents.propertyId, building: incidents.buildingId })));
      out.incidents = r;
    }
    if (p.permissions.has("inspection.read")) {
      const today = now.toISOString().slice(0, 10);
      const in14 = new Date(now.getTime() + 14 * DAY).toISOString().slice(0, 10);
      const [r] = await tx.select({
        upcoming: sql<number>`count(*) filter (where ${inspections.scheduledFor} between ${today} and ${in14})::int`,
        overdue: sql<number>`count(*) filter (where ${inspections.scheduledFor} < ${today})::int`,
      }).from(inspections).where(and(eq(inspections.orgId, p.orgId), inArray(inspections.status, ["scheduled", "in_progress"]),
        scopeCondition(p, { property: inspections.propertyId, building: inspections.buildingId })));
      out.inspections = r;
    }
    const [mine] = await tx.select({ open: count(), overdue: sql<number>`count(*) filter (where ${tasks.dueAt} < now())::int` }).from(tasks)
      .where(and(eq(tasks.orgId, p.orgId), eq(tasks.assignedMembershipId, p.membershipId), inArray(tasks.status, ["open", "in_progress", "blocked"])));
    out.myTasks = mine;
    return out as {
      workOrders?: { open: number; overdue: number; emergency: number; unassigned: number; completed: number; avgResponseH: number | null; avgResolveH: number | null; slaCompliance: number | null; spend: number;
        byCategory: { key: string; n: number }[]; byProperty: { key: string; id: string; n: number; overdue: number }[]; byVendor: { key: string; id: string; n: number; overdue: number }[] };
      complaints?: { open: number }; incidents?: { last7: number; openSerious: number; open: number }; inspections?: { upcoming: number; overdue: number };
      myTasks: { open: number; overdue: number };
    };
  });
}


