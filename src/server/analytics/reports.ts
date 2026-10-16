import "server-only";
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQLWrapper } from "drizzle-orm";
import { amenities, bookings, buildings, complaints, incidents, inspectionItems, inspections, memberships, packages, properties, roles, tasks, units, users, vendors, workOrders } from "../db/schema";
import { ForbiddenError } from "../authz/authorize";
import { tenantTx, auditAs, type TenantCtx } from "../modules/context";
import { scopeCondition } from "../modules/scope";
import { vendorPerformance } from "../modules/analytics/vendors";
import { OPEN_STATUSES } from "../modules/maintenance/rules";
import { canReadMetric, metricBreakdown, type MetricKey, type Unit } from "./metrics";
import { propertyHealth } from "./health";
import type { Period } from "./period";
import { WO_CATEGORY, WO_STATUS, PRIORITY, COMPLAINT_CATEGORY, COMPLAINT_STATUS, INCIDENT_TYPE, INCIDENT_STATUS, SEVERITY, INSPECTION_KIND } from "@/lib/ops-labels";
import { AMENITY_KIND } from "@/lib/community-labels";
import { HEALTH_GRADE, HEALTH_FACTOR_INFO, HEALTH_FACTORS } from "@/lib/analytics-labels";
import { REPORT_LABEL } from "@/lib/automation";

// Reports (Iteration 9): tables computed from recorded rows for a period, shown on screen and exported as CSV.

export const REPORT_KEYS = ["maintenance", "sla", "vendors", "complaints", "incidents", "inspections", "amenities", "packages", "workload", "health"] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];
export const isReportKey = (v: string): v is ReportKey => (REPORT_KEYS as readonly string[]).includes(v);

export type Column = { key: string; label: string; unit?: Unit | "text" | "date" | "datetime" };
export type Cell = string | number | null;
export type Report = { key: ReportKey; title: string; description: string; columns: Column[]; rows: Record<string, Cell>[]; truncated: boolean; hrefKey?: string };

const REPORT_INFO: Record<ReportKey, { description: string; perms: string[] }> = {
  maintenance: { description: "Every maintenance request created in the period, with its response, completion and SLA outcome.", perms: ["workorder.read"] },
  sla: { description: "Resolution and response targets met, by property, for the period; open and overdue counts are as of now.", perms: ["workorder.read"] },
  vendors: { description: "Jobs completed in the period by each vendor, how fast, and how many met their target; open and overdue counts are as of now.", perms: ["workorder.read", "vendor.read"] },
  complaints: { description: "Complaints submitted in the period.", perms: ["complaint.read"] },
  incidents: { description: "Incidents that occurred in the period.", perms: ["incident.read"] },
  inspections: { description: "Inspections completed in the period and how many items failed.", perms: ["inspection.read"] },
  amenities: { description: "Confirmed bookings starting in the period. Utilisation compares booked hours with opening hours, for amenities booked for exclusive use.", perms: ["booking.manage"] },
  packages: { description: "Packages received and picked up in the period, by property; waiting counts are as of now.", perms: ["package.manage"] },
  workload: { description: "Open and overdue work per staff member right now, and what each completed in the period.", perms: ["workorder.read", "task.read"] },
  health: { description: "Each property's health score and the factors behind it (last 30 days; inspections over 90 days).", perms: ["workorder.read"] },
};

export function availableReports(ctx: TenantCtx): ReportKey[] {
  const p = ctx.principal;
  if (!p.permissions.has("analytics.read")) return [];
  return REPORT_KEYS.filter((k) => REPORT_INFO[k].perms.every((x) => p.permissions.has(x)));
}

const MAX_ROWS = 5000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const hrs = (a: Date | null, b: Date | null) => (a && b ? Math.round(((b.getTime() - a.getTime()) / 3_600_000) * 10) / 10 : null);
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

export async function buildReport(ctx: TenantCtx, key: ReportKey, period: Period, f: { propertyId?: string | null } = {}): Promise<Report> {
  const p = ctx.principal;
  if (!availableReports(ctx).includes(key)) throw new ForbiddenError();
  const base = { key, title: REPORT_LABEL[key] ?? key, description: REPORT_INFO[key].description, truncated: false };
  const inPeriod = (col: SQLWrapper) => sql`${col} >= ${period.from} and ${col} < ${period.to}`;

  switch (key) {
    case "maintenance": {
      const finance = p.permissions.has("finance.read");
      const rows = await tenantTx(ctx, (tx) => tx.select({ w: workOrders, property: properties.name, building: buildings.name, unit: units.number, vendor: vendors.name, assignee: users.name })
        .from(workOrders).innerJoin(properties, eq(properties.id, workOrders.propertyId)).leftJoin(buildings, eq(buildings.id, workOrders.buildingId))
        .leftJoin(units, eq(units.id, workOrders.unitId)).leftJoin(vendors, eq(vendors.id, workOrders.vendorId))
        .leftJoin(memberships, eq(memberships.id, workOrders.assignedMembershipId)).leftJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(workOrders.orgId, p.orgId), scopeCondition(p, { property: workOrders.propertyId, building: workOrders.buildingId }), f.propertyId ? eq(workOrders.propertyId, f.propertyId) : undefined, inPeriod(workOrders.createdAt)))
        .orderBy(asc(workOrders.createdAt)).limit(MAX_ROWS + 1));
      const now = Date.now();
      return {
        ...base, truncated: rows.length > MAX_ROWS, hrefKey: "number",
        columns: [
          { key: "number", label: "Request" }, { key: "title", label: "Title" }, { key: "property", label: "Property" }, { key: "building", label: "Building" }, { key: "unit", label: "Unit" },
          { key: "category", label: "Category" }, { key: "priority", label: "Priority" }, { key: "emergency", label: "Emergency" }, { key: "status", label: "Status" },
          { key: "created", label: "Created", unit: "datetime" }, { key: "responseHours", label: "Hours to first response", unit: "hours" }, { key: "completed", label: "Completed", unit: "datetime" },
          { key: "resolutionHours", label: "Hours to complete", unit: "hours" }, { key: "sla", label: "Resolution target" }, { key: "vendor", label: "Vendor" }, { key: "assignee", label: "Assigned to" },
          ...(finance ? [{ key: "cost", label: "Cost", unit: "currency" as const }] : []),
        ],
        rows: rows.slice(0, MAX_ROWS).map(({ w, ...r }) => ({
          id: w.id, number: `WO-${w.number}`, title: w.title, property: r.property, building: r.building, unit: r.unit, category: WO_CATEGORY[w.category] ?? w.category,
          priority: PRIORITY[w.priority]?.label ?? w.priority, emergency: w.isEmergency ? "Yes" : "No", status: WO_STATUS[w.status]?.label ?? w.status,
          created: iso(w.createdAt), responseHours: hrs(w.createdAt, w.firstResponseAt), completed: iso(w.completedAt), resolutionHours: hrs(w.createdAt, w.completedAt),
          sla: !w.resolveDueAt ? "No target" : w.completedAt ? (w.completedAt <= w.resolveDueAt ? "Met" : "Missed") : w.resolveDueAt.getTime() < now && OPEN_STATUSES.includes(w.status as never) ? "Overdue" : "Open",
          vendor: r.vendor, assignee: r.assignee, ...(finance ? { cost: w.cost === null ? null : Number(w.cost) } : {}),
        })),
      };
    }
    case "sla": {
      const get = async (k: MetricKey, per: Period | null) => new Map((canReadMetric(p, k) ? (await metricBreakdown(ctx, k, "property", per, f, 50)) ?? [] : []).map((r) => [r.key, r]));
      const [completed, met, resp, resolve, first, open, overdue] = await Promise.all([
        get("requests_completed", period), get("sla_compliance", period), get("response_compliance", period), get("resolution_hours", period), get("first_response_hours", period), get("open_backlog", null), get("overdue_now", null),
      ]);
      const ids = [...new Set([...completed.keys(), ...open.keys(), ...resp.keys()])];
      return {
        ...base,
        columns: [{ key: "property", label: "Property" }, { key: "completed", label: "Completed", unit: "count" }, { key: "sla", label: "Resolved within SLA", unit: "percent" },
          { key: "response", label: "Responded within SLA", unit: "percent" }, { key: "firstResponse", label: "Avg. first response", unit: "hours" }, { key: "resolution", label: "Avg. resolution time", unit: "hours" },
          { key: "open", label: "Open now", unit: "count" }, { key: "overdue", label: "Overdue now", unit: "count" }],
        rows: ids.map((id) => ({
          id, property: (completed.get(id) ?? open.get(id) ?? resp.get(id))!.label, completed: completed.get(id)?.value ?? 0, sla: met.get(id)?.value ?? null, response: resp.get(id)?.value ?? null,
          firstResponse: first.get(id)?.value ?? null, resolution: resolve.get(id)?.value ?? null, open: open.get(id)?.value ?? 0, overdue: overdue.get(id)?.value ?? 0,
        })).sort((a, b) => String(a.property).localeCompare(String(b.property))),
      };
    }
    case "vendors": {
      const rows = await vendorPerformance(ctx, { from: period.from, to: period.to, propertyId: f.propertyId ?? undefined });
      const finance = p.permissions.has("finance.read");
      return {
        ...base,
        columns: [{ key: "vendor", label: "Vendor" }, { key: "completed", label: "Jobs completed", unit: "count" }, { key: "avgResponse", label: "Avg. first response", unit: "hours" },
          { key: "avgResolve", label: "Avg. time to complete", unit: "hours" }, { key: "onTime", label: "Completed on time", unit: "percent" }, { key: "late", label: "Completed late", unit: "count" },
          { key: "open", label: "Open now", unit: "count" }, { key: "overdue", label: "Overdue now", unit: "count" }, ...(finance ? [{ key: "spend", label: "Spend", unit: "currency" as const }] : [])],
        rows: rows.map((r) => ({ id: r.vendorId, vendor: r.name, completed: r.completed, avgResponse: r.avgResponseHours, avgResolve: r.avgResolveHours, onTime: r.onTimePct, late: r.completedLate, open: r.openNow, overdue: r.overdueNow, ...(finance ? { spend: r.spend } : {}) })),
      };
    }
    case "complaints": {
      const rows = await tenantTx(ctx, (tx) => tx.select({ c: complaints, property: properties.name, building: buildings.name, unit: units.number }).from(complaints)
        .innerJoin(properties, eq(properties.id, complaints.propertyId)).leftJoin(buildings, eq(buildings.id, complaints.buildingId)).leftJoin(units, eq(units.id, complaints.unitId))
        .where(and(eq(complaints.orgId, p.orgId), scopeCondition(p, { property: complaints.propertyId, building: complaints.buildingId }), f.propertyId ? eq(complaints.propertyId, f.propertyId) : undefined, inPeriod(complaints.createdAt)))
        .orderBy(asc(complaints.createdAt)).limit(MAX_ROWS + 1));
      return {
        ...base, truncated: rows.length > MAX_ROWS, hrefKey: "number",
        columns: [{ key: "number", label: "Complaint" }, { key: "subject", label: "Subject" }, { key: "property", label: "Property" }, { key: "building", label: "Building" }, { key: "unit", label: "Unit" },
          { key: "category", label: "Category" }, { key: "priority", label: "Priority" }, { key: "status", label: "Status" }, { key: "created", label: "Submitted", unit: "datetime" },
          { key: "resolved", label: "Resolved", unit: "datetime" }, { key: "hours", label: "Hours to resolve", unit: "hours" }],
        rows: rows.slice(0, MAX_ROWS).map(({ c, ...r }) => ({
          id: c.id, number: `C-${c.number}`, subject: c.subject, ...r, category: COMPLAINT_CATEGORY[c.category] ?? c.category, priority: PRIORITY[c.priority]?.label ?? c.priority,
          status: COMPLAINT_STATUS[c.status]?.label ?? c.status, created: iso(c.createdAt), resolved: iso(c.resolvedAt), hours: hrs(c.createdAt, c.resolvedAt),
        })),
      };
    }
    case "incidents": {
      const rows = await tenantTx(ctx, (tx) => tx.select({ i: incidents, property: properties.name, building: buildings.name }).from(incidents)
        .innerJoin(properties, eq(properties.id, incidents.propertyId)).leftJoin(buildings, eq(buildings.id, incidents.buildingId))
        .where(and(eq(incidents.orgId, p.orgId), scopeCondition(p, { property: incidents.propertyId, building: incidents.buildingId }), f.propertyId ? eq(incidents.propertyId, f.propertyId) : undefined, inPeriod(incidents.occurredAt)))
        .orderBy(asc(incidents.occurredAt)).limit(MAX_ROWS + 1));
      return {
        ...base, truncated: rows.length > MAX_ROWS, hrefKey: "number",
        columns: [{ key: "number", label: "Incident" }, { key: "title", label: "Title" }, { key: "property", label: "Property" }, { key: "building", label: "Building" }, { key: "type", label: "Type" },
          { key: "severity", label: "Severity" }, { key: "status", label: "Status" }, { key: "occurred", label: "Occurred", unit: "datetime" }, { key: "resolved", label: "Resolved", unit: "datetime" }],
        rows: rows.slice(0, MAX_ROWS).map(({ i, ...r }) => ({
          id: i.id, number: `INC-${i.number}`, title: i.title, ...r, type: INCIDENT_TYPE[i.type] ?? i.type, severity: SEVERITY[i.severity]?.label ?? i.severity,
          status: INCIDENT_STATUS[i.status]?.label ?? i.status, occurred: iso(i.occurredAt), resolved: iso(i.resolvedAt),
        })),
      };
    }
    case "inspections": {
      const rows = await tenantTx(ctx, (tx) => tx.select({
        n: inspections, property: properties.name, building: buildings.name,
        failed: sql<number>`(select count(*)::int from ${inspectionItems} ii where ii.inspection_id = ${inspections.id} and ii.result = 'fail')`,
        items: sql<number>`(select count(*)::int from ${inspectionItems} ii where ii.inspection_id = ${inspections.id})`,
      }).from(inspections).innerJoin(properties, eq(properties.id, inspections.propertyId)).leftJoin(buildings, eq(buildings.id, inspections.buildingId))
        .where(and(eq(inspections.orgId, p.orgId), eq(inspections.status, "completed"), scopeCondition(p, { property: inspections.propertyId, building: inspections.buildingId }), f.propertyId ? eq(inspections.propertyId, f.propertyId) : undefined, inPeriod(inspections.completedAt)))
        .orderBy(asc(inspections.completedAt)).limit(MAX_ROWS + 1));
      return {
        ...base, truncated: rows.length > MAX_ROWS,
        columns: [{ key: "title", label: "Inspection" }, { key: "property", label: "Property" }, { key: "building", label: "Building" }, { key: "kind", label: "Kind" },
          { key: "completed", label: "Completed", unit: "datetime" }, { key: "result", label: "Result" }, { key: "items", label: "Items", unit: "count" }, { key: "failed", label: "Failed items", unit: "count" }],
        rows: rows.slice(0, MAX_ROWS).map(({ n, ...r }) => ({ id: n.id, title: n.title, property: r.property, building: r.building, kind: INSPECTION_KIND[n.kind] ?? n.kind, completed: iso(n.completedAt), result: n.result === "fail" ? "Fail" : n.result === "pass" ? "Pass" : "—", items: r.items, failed: r.failed })),
      };
    }
    case "amenities": {
      const rows = await tenantTx(ctx, (tx) => tx.select({
        id: amenities.id, name: amenities.name, kind: amenities.kind, property: properties.name, exclusive: sql<boolean>`${amenities.maxConcurrent} = 1`,
        openMinutes: sql<number>`${amenities.closesAtMinute} - ${amenities.opensAtMinute}`,
        n: sql<number>`count(${bookings.id})::int`,
        hours: sql<number>`coalesce(sum(extract(epoch from (${bookings.endsAt} - ${bookings.startsAt})) / 3600), 0)::float`,
      }).from(amenities).innerJoin(properties, eq(properties.id, amenities.propertyId))
        .leftJoin(bookings, and(eq(bookings.amenityId, amenities.id), eq(bookings.status, "approved"), gte(bookings.startsAt, period.from), lt(bookings.startsAt, period.to)))
        .where(and(eq(amenities.orgId, p.orgId), eq(amenities.active, true), scopeCondition(p, { property: amenities.propertyId, building: amenities.buildingId }), f.propertyId ? eq(amenities.propertyId, f.propertyId) : undefined))
        .groupBy(amenities.id, properties.name).orderBy(desc(sql`count(${bookings.id})`), asc(amenities.name)));
      return {
        ...base,
        columns: [{ key: "amenity", label: "Amenity" }, { key: "kind", label: "Kind" }, { key: "property", label: "Property" }, { key: "bookings", label: "Bookings", unit: "count" },
          { key: "hours", label: "Hours booked", unit: "hours" }, { key: "openHours", label: "Opening hours in period", unit: "hours" }, { key: "utilisation", label: "Utilisation", unit: "percent" }],
        rows: rows.map((r) => {
          const openHours = Math.max(0, (r.openMinutes / 60) * period.days);
          return { id: r.id, amenity: r.name, kind: AMENITY_KIND[r.kind] ?? r.kind, property: r.property, bookings: r.n, hours: round1(r.hours), openHours: round1(openHours),
            utilisation: r.exclusive && openHours > 0 ? round1(Math.min(100, (r.hours / openHours) * 100)) : null };
        }),
      };
    }
    case "packages": {
      const rows = await tenantTx(ctx, (tx) => tx.select({
        id: properties.id, property: properties.name,
        received: sql<number>`count(*) filter (where ${packages.receivedAt} >= ${period.from} and ${packages.receivedAt} < ${period.to})::int`,
        pickedUp: sql<number>`count(*) filter (where ${packages.pickedUpAt} >= ${period.from} and ${packages.pickedUpAt} < ${period.to})::int`,
        avgHours: sql<number | null>`(avg(extract(epoch from (${packages.pickedUpAt} - ${packages.receivedAt})) / 3600) filter (where ${packages.pickedUpAt} >= ${period.from} and ${packages.pickedUpAt} < ${period.to}))::float`,
        waiting: sql<number>`count(*) filter (where ${packages.status} = 'waiting')::int`,
        waiting7: sql<number>`count(*) filter (where ${packages.status} = 'waiting' and ${packages.receivedAt} < now() - interval '7 days')::int`,
      }).from(packages).innerJoin(properties, eq(properties.id, packages.propertyId))
        .where(and(eq(packages.orgId, p.orgId), scopeCondition(p, { property: packages.propertyId, building: packages.buildingId }), f.propertyId ? eq(packages.propertyId, f.propertyId) : undefined))
        .groupBy(properties.id, properties.name).orderBy(asc(properties.name)));
      return {
        ...base,
        columns: [{ key: "property", label: "Property" }, { key: "received", label: "Received", unit: "count" }, { key: "pickedUp", label: "Picked up", unit: "count" },
          { key: "avgHours", label: "Avg. time to pickup", unit: "hours" }, { key: "waiting", label: "Waiting now", unit: "count" }, { key: "waiting7", label: "Waiting over 7 days", unit: "count" }],
        rows: rows.map((r) => ({ ...r, avgHours: round1(r.avgHours) })),
      };
    }
    case "workload": {
      const rows = await tenantTx(ctx, async (tx) => {
        const staff = await tx.select({ id: memberships.id, name: users.name, role: roles.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).innerJoin(roles, eq(roles.id, memberships.roleId))
          .where(and(eq(memberships.orgId, p.orgId), eq(memberships.status, "active"), eq(roles.category, "staff"))).orderBy(asc(users.name));
        const ids = staff.map((s) => s.id);
        if (!ids.length) return [];
        const wo = await tx.select({
          id: workOrders.assignedMembershipId,
          open: sql<number>`count(*) filter (where ${inArray(workOrders.status, OPEN_STATUSES)})::int`,
          overdue: sql<number>`count(*) filter (where ${inArray(workOrders.status, OPEN_STATUSES)} and ${workOrders.resolveDueAt} < now())::int`,
          done: sql<number>`count(*) filter (where ${workOrders.completedAt} >= ${period.from} and ${workOrders.completedAt} < ${period.to})::int`,
        }).from(workOrders).where(and(eq(workOrders.orgId, p.orgId), inArray(workOrders.assignedMembershipId, ids), scopeCondition(p, { property: workOrders.propertyId, building: workOrders.buildingId }), f.propertyId ? eq(workOrders.propertyId, f.propertyId) : undefined))
          .groupBy(workOrders.assignedMembershipId);
        const tk = await tx.select({
          id: tasks.assignedMembershipId,
          open: sql<number>`count(*) filter (where ${tasks.status} in ('open','in_progress','blocked'))::int`,
          overdue: sql<number>`count(*) filter (where ${tasks.status} in ('open','in_progress','blocked') and ${tasks.dueAt} < now())::int`,
          done: sql<number>`count(*) filter (where ${tasks.completedAt} >= ${period.from} and ${tasks.completedAt} < ${period.to})::int`,
        }).from(tasks).where(and(eq(tasks.orgId, p.orgId), inArray(tasks.assignedMembershipId, ids), scopeCondition(p, { property: tasks.propertyId, building: tasks.buildingId }), f.propertyId ? eq(tasks.propertyId, f.propertyId) : undefined))
          .groupBy(tasks.assignedMembershipId);
        return staff.map((s) => {
          const w = wo.find((x) => x.id === s.id);
          const t = tk.find((x) => x.id === s.id);
          return { id: s.id, name: s.name, role: s.role, woOpen: w?.open ?? 0, woOverdue: w?.overdue ?? 0, woDone: w?.done ?? 0, taskOpen: t?.open ?? 0, taskOverdue: t?.overdue ?? 0, taskDone: t?.done ?? 0 };
        }).filter((r) => r.woOpen + r.woDone + r.taskOpen + r.taskDone > 0);
      });
      return {
        ...base,
        columns: [{ key: "name", label: "Staff member" }, { key: "role", label: "Role" }, { key: "woOpen", label: "Open requests", unit: "count" }, { key: "woOverdue", label: "Overdue requests", unit: "count" },
          { key: "woDone", label: "Requests completed", unit: "count" }, { key: "taskOpen", label: "Open tasks", unit: "count" }, { key: "taskOverdue", label: "Overdue tasks", unit: "count" }, { key: "taskDone", label: "Tasks done", unit: "count" }],
        rows: rows.sort((a, b) => b.woOpen + b.taskOpen - (a.woOpen + a.taskOpen)),
      };
    }
    case "health": {
      const rows = await propertyHealth(ctx, { propertyId: f.propertyId });
      return {
        ...base,
        columns: [{ key: "property", label: "Property" }, { key: "score", label: "Score", unit: "count" }, { key: "grade", label: "Status" },
          ...HEALTH_FACTORS.map((k) => ({ key: k, label: HEALTH_FACTOR_INFO[k].label }))],
        rows: rows.map((h) => ({ id: h.propertyId, property: h.name, score: h.score, grade: h.grade ? HEALTH_GRADE[h.grade].label : "—", ...Object.fromEntries(h.factors.map((x) => [x.factor, x.score === null ? "—" : `${x.valueText} → ${x.score}`])) })),
      };
    }
  }
}

/* ───────────── CSV ───────────── */

// RFC 4180 quoting; cells that a spreadsheet would run as a formula are prefixed with an apostrophe
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: Column[], rows: Record<string, Cell>[]): string {
  return [columns.map((c) => csvCell(c.label)).join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c.key] ?? null)).join(","))].join("\r\n") + "\r\n";
}

// exports are audited: who downloaded which report for which period
export async function exportReportCsv(ctx: TenantCtx, key: ReportKey, period: Period, f: { propertyId?: string | null } = {}) {
  const r = await buildReport(ctx, key, period, f);
  await tenantTx(ctx, (tx) => auditAs(tx, ctx, "report.exported", "report", null, undefined, { report: key, from: period.fromDate, to: period.toDate, propertyId: f.propertyId ?? null, rows: r.rows.length }));
  return { filename: `${key}-${period.fromDate}-to-${period.toDate}.csv`, csv: toCsv(r.columns, r.rows), report: r };
}
