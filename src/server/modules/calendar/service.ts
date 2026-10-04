import "server-only";
import { and, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import {
  amenities, assets, bookings, inspections, memberships, pmSchedules, properties, shifts, tasks, units, users, visitors, workOrders,
} from "../../db/schema";
import type { Principal } from "../../authz/authorize";
import { tenantTx, type TenantCtx } from "../context";
import { scopeCondition } from "../scope";
import { OPEN_STATUSES } from "../maintenance/rules";
import { woVisibleWhere } from "../maintenance/service";
import { taskVisibleWhere } from "../tasks/service";

export const CAL_SOURCES = ["work", "inspections", "pm", "bookings", "visitors", "shifts", "tasks"] as const;
export type CalSource = (typeof CAL_SOURCES)[number];
export const CAL_SOURCE_LABEL: Record<CalSource, string> = {
  work: "Scheduled work", inspections: "Inspections", pm: "Preventive maintenance", bookings: "Amenity bookings", visitors: "Visitors", shifts: "Shifts", tasks: "Task due dates",
};

export type CalEvent = {
  id: string; source: CalSource; title: string; sub: string | null; start: Date; end: Date | null; allDay: boolean; href: string; pending?: boolean;
};

const has = (p: Principal, ...perms: string[]) => perms.some((x) => p.permissions.has(x));

// sources this principal may see at all (each query below still applies record-level scope)
export function availableSources(p: Principal): CalSource[] {
  const out: CalSource[] = [];
  if (has(p, "workorder.read", "workorder.read.assigned", "workorder.read.own")) out.push("work");
  if (has(p, "inspection.read", "inspection.manage")) out.push("inspections");
  if (has(p, "asset.read", "asset.manage")) out.push("pm");
  if (has(p, "booking.manage") || (has(p, "booking.create") && p.unitIds.size)) out.push("bookings");
  if (has(p, "visitor.manage") || (has(p, "visitor.invite") && p.unitIds.size)) out.push("visitors");
  if (has(p, "shift.read", "shift.manage")) out.push("shifts");
  if (has(p, "task.read", "task.manage") || p.role.category === "staff") out.push("tasks");
  return out;
}

const LIMIT = 500;
const day = (d: Date) => d.toISOString().slice(0, 10);

// every dated thing in [from, to) the principal is allowed to see, merged and sorted
export async function calendarEvents(ctx: TenantCtx, opts: { from: Date; to: Date; sources?: CalSource[]; propertyId?: string }): Promise<CalEvent[]> {
  const p = ctx.principal;
  const allowed = availableSources(p);
  const want = (s: CalSource) => allowed.includes(s) && (!opts.sources?.length || opts.sources.includes(s));
  const base = `/o/${p.orgSlug}`;
  const prop = <T,>(col: T) => (opts.propertyId ? eq(col as never, opts.propertyId) : undefined);
  const { from, to } = opts;
  return tenantTx(ctx, async (tx) => {
    const out: CalEvent[] = [];
    if (want("work")) {
      const rows = await tx.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, start: workOrders.scheduledStart, end: workOrders.scheduledEnd, property: properties.name, unit: units.number })
        .from(workOrders).innerJoin(properties, eq(properties.id, workOrders.propertyId)).leftJoin(units, eq(units.id, workOrders.unitId))
        .where(and(eq(workOrders.orgId, p.orgId), woVisibleWhere(p), inArray(workOrders.status, OPEN_STATUSES), prop(workOrders.propertyId),
          lt(workOrders.scheduledStart, to), sql`coalesce(${workOrders.scheduledEnd}, ${workOrders.scheduledStart} + interval '1 hour') > ${from}`))
        .limit(LIMIT);
      for (const r of rows) out.push({ id: r.id, source: "work", title: `#${r.number} ${r.title}`, sub: [r.property, r.unit ? `Unit ${r.unit}` : null].filter(Boolean).join(" · "), start: r.start!, end: r.end, allDay: false, href: `${base}/maintenance/${r.id}` });
    }
    if (want("inspections")) {
      const rows = await tx.select({ id: inspections.id, title: inspections.title, on: inspections.scheduledFor, status: inspections.status, property: properties.name })
        .from(inspections).innerJoin(properties, eq(properties.id, inspections.propertyId))
        .where(and(eq(inspections.orgId, p.orgId), inArray(inspections.status, ["scheduled", "in_progress"]), prop(inspections.propertyId),
          sql`(${scopeCondition(p, { property: inspections.propertyId, building: inspections.buildingId }) ?? sql`true`} or ${inspections.inspectorMembershipId} = ${p.membershipId})`,
          gte(inspections.scheduledFor, day(from)), lt(inspections.scheduledFor, day(to))))
        .limit(LIMIT);
      for (const r of rows) out.push({ id: r.id, source: "inspections", title: r.title, sub: r.property, start: new Date(`${r.on}T12:00:00Z`), end: null, allDay: true, href: `${base}/inspections/${r.id}` });
    }
    if (want("pm")) {
      const rows = await tx.select({ id: pmSchedules.id, title: pmSchedules.title, on: pmSchedules.nextDueOn, assetId: assets.id, asset: assets.name, property: properties.name })
        .from(pmSchedules).innerJoin(assets, eq(assets.id, pmSchedules.assetId)).innerJoin(properties, eq(properties.id, assets.propertyId))
        .where(and(eq(pmSchedules.orgId, p.orgId), eq(pmSchedules.active, true), prop(assets.propertyId),
          scopeCondition(p, { property: assets.propertyId, building: assets.buildingId }) ?? sql`true`,
          gte(pmSchedules.nextDueOn, day(from)), lt(pmSchedules.nextDueOn, day(to))))
        .limit(LIMIT);
      for (const r of rows) out.push({ id: r.id, source: "pm", title: `${r.title} — ${r.asset}`, sub: r.property, start: new Date(`${r.on}T12:00:00Z`), end: null, allDay: true, href: `${base}/assets/${r.assetId}` });
    }
    if (want("bookings")) {
      const staff = has(p, "booking.manage");
      const rows = await tx.select({ id: bookings.id, start: bookings.startsAt, end: bookings.endsAt, status: bookings.status, amenity: amenities.name, unit: units.number })
        .from(bookings).innerJoin(amenities, eq(amenities.id, bookings.amenityId)).leftJoin(units, eq(units.id, bookings.unitId))
        .where(and(eq(bookings.orgId, p.orgId), inArray(bookings.status, ["requested", "approved"]), prop(bookings.propertyId), lt(bookings.startsAt, to), gt(bookings.endsAt, from),
          staff ? scopeCondition(p, { property: bookings.propertyId, building: bookings.buildingId }) ?? sql`true` : inArray(bookings.unitId, [...p.unitIds])))
        .limit(LIMIT);
      for (const r of rows) out.push({ id: r.id, source: "bookings", title: r.amenity, sub: staff && r.unit ? `Unit ${r.unit}` : null, start: r.start, end: r.end, allDay: false, href: `${base}/amenities/bookings/${r.id}`, pending: r.status === "requested" });
    }
    if (want("visitors")) {
      const staff = has(p, "visitor.manage");
      const rows = await tx.select({ id: visitors.id, name: visitors.name, kind: visitors.kind, start: visitors.expectedFrom, end: visitors.expectedUntil, status: visitors.status, unit: units.number })
        .from(visitors).leftJoin(units, eq(units.id, visitors.unitId))
        .where(and(eq(visitors.orgId, p.orgId), inArray(visitors.status, ["expected", "checked_in"]), prop(visitors.propertyId), lt(visitors.expectedFrom, to), gt(visitors.expectedUntil, from),
          staff ? scopeCondition(p, { property: visitors.propertyId, building: visitors.buildingId }) ?? sql`true` : inArray(visitors.unitId, [...p.unitIds])))
        .limit(LIMIT);
      for (const r of rows) out.push({ id: r.id, source: "visitors", title: r.name, sub: [r.kind !== "guest" ? r.kind : null, staff && r.unit ? `Unit ${r.unit}` : null, r.status === "checked_in" ? "on site" : null].filter(Boolean).join(" · ") || null, start: r.start, end: r.end, allDay: false, href: `${base}/visitors/${r.id}` });
    }
    if (want("shifts")) {
      const rows = await tx.select({ id: shifts.id, start: shifts.startsAt, end: shifts.endsAt, position: shifts.position, onCall: shifts.onCall, name: users.name, property: properties.name })
        .from(shifts).innerJoin(memberships, eq(memberships.id, shifts.membershipId)).innerJoin(users, eq(users.id, memberships.userId)).innerJoin(properties, eq(properties.id, shifts.propertyId))
        .where(and(eq(shifts.orgId, p.orgId), eq(shifts.status, "scheduled"), prop(shifts.propertyId), lt(shifts.startsAt, to), gt(shifts.endsAt, from),
          scopeCondition(p, { property: shifts.propertyId, building: shifts.buildingId }) ?? sql`true`))
        .limit(LIMIT);
      for (const r of rows) out.push({ id: r.id, source: "shifts", title: `${r.name}${r.onCall ? " (on call)" : ""}`, sub: `${r.position.replace(/_/g, " ")} · ${r.property}`, start: r.start, end: r.end, allDay: false, href: `${base}/shifts?week=${day(r.start)}` });
    }
    if (want("tasks")) {
      const rows = await tx.select({ id: tasks.id, title: tasks.title, due: tasks.dueAt, property: properties.name })
        .from(tasks).leftJoin(properties, eq(properties.id, tasks.propertyId))
        .where(and(eq(tasks.orgId, p.orgId), taskVisibleWhere(p), inArray(tasks.status, ["open", "in_progress", "blocked"]), prop(tasks.propertyId), gte(tasks.dueAt, from), lt(tasks.dueAt, to)))
        .limit(LIMIT);
      for (const r of rows) out.push({ id: r.id, source: "tasks", title: r.title, sub: r.property, start: r.due!, end: null, allDay: false, href: `${base}/tasks/${r.id}` });
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.allDay) - Number(a.allDay));
  });
}
