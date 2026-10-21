import "server-only";
import { and, asc, desc, eq, gte, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { amenities, bookings, buildings, complaints, incidents, packages, properties, residents, unitOccupancies, units, vendors, workOrders } from "../../db/schema";
import { can, NotFoundError, ForbiddenError, scopeFilter, type Principal } from "../../authz/authorize";
import { tenantTx, type TenantCtx } from "../../modules/context";
import { scopeCondition, visiblePropertyIds } from "../../modules/scope";
import { woVisibleWhere } from "../../modules/maintenance/service";
import {
  serializeBooking, serializeComplaint, serializeIncident, serializePackage, serializeProperty, serializeResident, serializeUnit, serializeVendor, serializeWorkOrder,
} from "./serializers";
import { ApiError } from "./errors";

// Read side of API v1: cursor-paginated, permission- and scope-filtered queries. Writes go through the app's own
// services (see routes.ts) so they get the same validation, audit, events, automation and webhooks as the UI.

export type ListQuery = { limit: number; cursor: string | null; order: "asc" | "desc" };
export type ListResult<T> = { object: "list"; data: T[]; has_more: boolean; next_cursor: string | null };

type Cursor = { t: string; i: string };

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), i: id })).toString("base64url");
}

export function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (typeof c.t !== "string" || Number.isNaN(Date.parse(c.t)) || typeof c.i !== "string" || !/^[0-9a-f-]{36}$/i.test(c.i)) throw new Error();
    return c;
  } catch {
    throw new ApiError(400, "invalid_request", "The cursor isn't valid. Use next_cursor from the previous page.", [{ field: "cursor", message: "Invalid cursor." }]);
  }
}

// keyset pagination on (created_at, id): stable under inserts, no offsets
function keyset(cols: { createdAt: SQLWrapper; id: SQLWrapper }, q: ListQuery): { where?: SQL; orderBy: SQL[] } {
  const c = decodeCursor(q.cursor);
  const where = c ? (q.order === "desc"
    ? sql`(${cols.createdAt}, ${cols.id}) < (${c.t}::timestamptz, ${c.i}::uuid)`
    : sql`(${cols.createdAt}, ${cols.id}) > (${c.t}::timestamptz, ${c.i}::uuid)`) : undefined;
  const dir = q.order === "desc" ? desc : asc;
  return { where, orderBy: [dir(cols.createdAt as never), dir(cols.id as never)] };
}

function pageOf<R extends { createdAt: Date; id: string }, T>(rows: R[], q: ListQuery, map: (r: R) => T): ListResult<T> {
  const more = rows.length > q.limit;
  const slice = more ? rows.slice(0, q.limit) : rows;
  const last = slice.at(-1);
  return { object: "list", data: slice.map(map), has_more: more, next_cursor: more && last ? encodeCursor(last.createdAt, last.id) : null };
}

const need = (p: Principal, perm: string) => {
  if (!p.permissions.has(perm)) throw new ForbiddenError(`This API key doesn't have the ${perm} permission.`);
};

// records outside the key's reach are reported as not found (their existence isn't confirmed)
const visibleOr404 = (ok: boolean) => {
  if (!ok) throw new NotFoundError();
};

/* ───────────── properties ───────────── */

export async function listProperties(ctx: TenantCtx, q: ListQuery): Promise<ListResult<ReturnType<typeof serializeProperty>>> {
  const p = ctx.principal;
  need(p, "property.read");
  const visible = visiblePropertyIds(p);
  const k = keyset(properties, q);
  return tenantTx(ctx, async (tx) => pageOf(await tx.select().from(properties)
    .where(and(eq(properties.orgId, p.orgId), visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined, k.where))
    .orderBy(...k.orderBy).limit(q.limit + 1), q, (r) => serializeProperty(r)));
}

export async function getProperty(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  need(p, "property.read");
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(properties).where(and(eq(properties.id, id), eq(properties.orgId, p.orgId)));
    const visible = visiblePropertyIds(p);
    visibleOr404(!!r && (!visible || visible.includes(r.id)));
    const b = await tx.select({ id: buildings.id, name: buildings.name, code: buildings.code }).from(buildings).where(eq(buildings.propertyId, id)).orderBy(asc(buildings.name));
    return serializeProperty(r, b);
  });
}

/* ───────────── units ───────────── */

export async function listUnits(ctx: TenantCtx, q: ListQuery & { propertyId?: string; buildingId?: string; status?: string }) {
  const p = ctx.principal;
  need(p, "unit.read");
  const k = keyset(units, q);
  return tenantTx(ctx, async (tx) => pageOf(await tx.select().from(units).where(and(
    eq(units.orgId, p.orgId), scopeCondition(p, { property: units.propertyId, building: units.buildingId }),
    q.propertyId ? eq(units.propertyId, q.propertyId) : undefined, q.buildingId ? eq(units.buildingId, q.buildingId) : undefined,
    q.status ? eq(units.status, q.status) : undefined, k.where,
  )).orderBy(...k.orderBy).limit(q.limit + 1), q, serializeUnit));
}

export async function getUnit(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  need(p, "unit.read");
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(units).where(and(eq(units.id, id), eq(units.orgId, p.orgId)));
    visibleOr404(!!r && can(p, "unit.read", { orgId: r.orgId, propertyId: r.propertyId, buildingId: r.buildingId }));
    return serializeUnit(r);
  });
}

/* ───────────── residents ───────────── */

// a resident is visible when one of their current or past homes is in scope
function residentScope(p: Principal): SQL | undefined {
  const f = scopeFilter(p);
  if (f.kind === "all") return undefined;
  if (f.kind !== "some") return sql`false`;
  const props = f.propertyIds.length ? sql`u.property_id in (${sql.join(f.propertyIds.map((x) => sql`${x}::uuid`), sql`, `)})` : sql`false`;
  const blds = f.buildingIds.length ? sql`u.building_id in (${sql.join(f.buildingIds.map((x) => sql`${x}::uuid`), sql`, `)})` : sql`false`;
  return sql`exists (select 1 from unit_occupancies o join units u on u.id = o.unit_id where o.resident_id = ${residents.id} and (${props} or ${blds}))`;
}

async function occupanciesFor(tx: Tx, residentIds: string[]) {
  if (!residentIds.length) return new Map<string, Parameters<typeof serializeResident>[1]>();
  const rows = await tx.select({ residentId: unitOccupancies.residentId, unitId: unitOccupancies.unitId, propertyId: units.propertyId, relationship: unitOccupancies.relationship,
    isPrimary: unitOccupancies.isPrimary, startsOn: unitOccupancies.startsOn, endsOn: unitOccupancies.endsOn })
    .from(unitOccupancies).innerJoin(units, eq(units.id, unitOccupancies.unitId)).where(inArray(unitOccupancies.residentId, residentIds));
  const m = new Map<string, Parameters<typeof serializeResident>[1]>();
  for (const r of rows) m.set(r.residentId, [...(m.get(r.residentId) ?? []), r]);
  return m;
}

export async function listResidents(ctx: TenantCtx, q: ListQuery & { propertyId?: string; unitId?: string }) {
  const p = ctx.principal;
  need(p, "resident.read");
  const k = keyset(residents, q);
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select().from(residents).where(and(
      eq(residents.orgId, p.orgId), residentScope(p),
      q.propertyId ? sql`exists (select 1 from unit_occupancies o join units u on u.id = o.unit_id where o.resident_id = ${residents.id} and u.property_id = ${q.propertyId})` : undefined,
      q.unitId ? sql`exists (select 1 from unit_occupancies o where o.resident_id = ${residents.id} and o.unit_id = ${q.unitId})` : undefined,
      k.where,
    )).orderBy(...k.orderBy).limit(q.limit + 1);
    const occ = await occupanciesFor(tx, rows.slice(0, q.limit).map((r) => r.id));
    return pageOf(rows, q, (r) => serializeResident(r, occ.get(r.id) ?? []));
  });
}

export async function getResident(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  need(p, "resident.read");
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(residents).where(and(eq(residents.id, id), eq(residents.orgId, p.orgId), residentScope(p)));
    visibleOr404(!!r);
    return serializeResident(r, (await occupanciesFor(tx, [r.id])).get(r.id) ?? []);
  });
}

/* ───────────── work orders ───────────── */

export async function listWorkOrders(ctx: TenantCtx, q: ListQuery & { status?: string[]; propertyId?: string; priority?: string; category?: string; updatedSince?: Date }) {
  const p = ctx.principal;
  need(p, "workorder.read");
  const k = keyset(workOrders, q);
  return tenantTx(ctx, async (tx) => pageOf(await tx.select().from(workOrders).where(and(
    eq(workOrders.orgId, p.orgId), woVisibleWhere(p),
    q.status?.length ? inArray(workOrders.status, q.status) : undefined, q.propertyId ? eq(workOrders.propertyId, q.propertyId) : undefined,
    q.priority ? eq(workOrders.priority, q.priority) : undefined, q.category ? eq(workOrders.category, q.category) : undefined,
    q.updatedSince ? gte(workOrders.updatedAt, q.updatedSince) : undefined, k.where,
  )).orderBy(...k.orderBy).limit(q.limit + 1), q, serializeWorkOrder));
}

export async function loadWorkOrderFor(tx: Tx, p: Principal, id: string) {
  const [r] = await tx.select().from(workOrders).where(and(eq(workOrders.id, id), eq(workOrders.orgId, p.orgId)));
  visibleOr404(!!r && can(p, "workorder.read", { orgId: r.orgId, propertyId: r.propertyId, buildingId: r.buildingId }));
  return r;
}

export async function getWorkOrder(ctx: TenantCtx, id: string) {
  need(ctx.principal, "workorder.read");
  return tenantTx(ctx, async (tx) => serializeWorkOrder(await loadWorkOrderFor(tx, ctx.principal, id)));
}

/* ───────────── vendors, incidents, complaints, bookings, packages ───────────── */

export async function listVendors(ctx: TenantCtx, q: ListQuery & { status?: string; category?: string }) {
  const p = ctx.principal;
  need(p, "vendor.read");
  const k = keyset(vendors, q);
  return tenantTx(ctx, async (tx) => pageOf(await tx.select().from(vendors).where(and(
    eq(vendors.orgId, p.orgId), q.status ? eq(vendors.status, q.status) : undefined, q.category ? sql`${q.category} = any(${vendors.categories})` : undefined, k.where,
  )).orderBy(...k.orderBy).limit(q.limit + 1), q, serializeVendor));
}

export async function getVendor(ctx: TenantCtx, id: string) {
  need(ctx.principal, "vendor.read");
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(vendors).where(and(eq(vendors.id, id), eq(vendors.orgId, ctx.principal.orgId)));
    visibleOr404(!!r);
    return serializeVendor(r);
  });
}

export async function listIncidents(ctx: TenantCtx, q: ListQuery & { status?: string; severity?: string; propertyId?: string; since?: Date }) {
  const p = ctx.principal;
  need(p, "incident.read");
  const k = keyset(incidents, q);
  return tenantTx(ctx, async (tx) => pageOf(await tx.select().from(incidents).where(and(
    eq(incidents.orgId, p.orgId), scopeCondition(p, { property: incidents.propertyId, building: incidents.buildingId }),
    q.status ? eq(incidents.status, q.status) : undefined, q.severity ? eq(incidents.severity, q.severity) : undefined,
    q.propertyId ? eq(incidents.propertyId, q.propertyId) : undefined, q.since ? gte(incidents.occurredAt, q.since) : undefined, k.where,
  )).orderBy(...k.orderBy).limit(q.limit + 1), q, serializeIncident));
}

export async function getIncident(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  need(p, "incident.read");
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(incidents).where(and(eq(incidents.id, id), eq(incidents.orgId, p.orgId)));
    visibleOr404(!!r && can(p, "incident.read", { orgId: r.orgId, propertyId: r.propertyId, buildingId: r.buildingId }));
    return serializeIncident(r);
  });
}

export async function listComplaints(ctx: TenantCtx, q: ListQuery & { status?: string; propertyId?: string }) {
  const p = ctx.principal;
  need(p, "complaint.read");
  const k = keyset(complaints, q);
  return tenantTx(ctx, async (tx) => pageOf(await tx.select().from(complaints).where(and(
    eq(complaints.orgId, p.orgId), scopeCondition(p, { property: complaints.propertyId, building: complaints.buildingId }),
    q.status ? eq(complaints.status, q.status) : undefined, q.propertyId ? eq(complaints.propertyId, q.propertyId) : undefined, k.where,
  )).orderBy(...k.orderBy).limit(q.limit + 1), q, serializeComplaint));
}

export async function getComplaint(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  need(p, "complaint.read");
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(complaints).where(and(eq(complaints.id, id), eq(complaints.orgId, p.orgId)));
    visibleOr404(!!r && can(p, "complaint.read", { orgId: r.orgId, propertyId: r.propertyId, buildingId: r.buildingId }));
    return serializeComplaint(r);
  });
}

export async function listBookings(ctx: TenantCtx, q: ListQuery & { status?: string; amenityId?: string; propertyId?: string; from?: Date; to?: Date }) {
  const p = ctx.principal;
  need(p, "booking.manage");
  const k = keyset(bookings, q);
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({ b: bookings, amenityName: amenities.name, createdAt: bookings.createdAt, id: bookings.id }).from(bookings)
      .innerJoin(amenities, eq(amenities.id, bookings.amenityId)).where(and(
        eq(bookings.orgId, p.orgId), scopeCondition(p, { property: bookings.propertyId, building: bookings.buildingId }),
        q.status ? eq(bookings.status, q.status) : undefined, q.amenityId ? eq(bookings.amenityId, q.amenityId) : undefined,
        q.propertyId ? eq(bookings.propertyId, q.propertyId) : undefined, q.from ? gte(bookings.endsAt, q.from) : undefined,
        q.to ? sql`${bookings.startsAt} < ${q.to}` : undefined, k.where,
      )).orderBy(...k.orderBy).limit(q.limit + 1);
    return pageOf(rows, q, (r) => serializeBooking(r.b, r.amenityName));
  });
}

export async function listPackages(ctx: TenantCtx, q: ListQuery & { status?: string; propertyId?: string; unitId?: string }) {
  const p = ctx.principal;
  need(p, "package.manage");
  const k = keyset(packages, q);
  return tenantTx(ctx, async (tx) => pageOf(await tx.select().from(packages).where(and(
    eq(packages.orgId, p.orgId), scopeCondition(p, { property: packages.propertyId, building: packages.buildingId }),
    q.status ? eq(packages.status, q.status) : undefined, q.propertyId ? eq(packages.propertyId, q.propertyId) : undefined,
    q.unitId ? eq(packages.unitId, q.unitId) : undefined, k.where,
  )).orderBy(...k.orderBy).limit(q.limit + 1), q, serializePackage));
}
