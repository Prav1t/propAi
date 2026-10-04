import "server-only";
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lte, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import {
  buildings, files, organizations, parkingPermits, parkingSpaces, parkingViolations, properties, units, users, vehicles, visitors,
  PARKING_SPACE_KINDS, PARKING_VIOLATION_KINDS,
} from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import { withContext, type Tx } from "../../db/client";
import { auditAs, blankToNull, friendlyUnique, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { emit, emitSystem, nextNumber } from "../ops/core";
import { fileRows, prepareFiles, withStoredBlobs } from "../../files/service";
import { zonedToUtc } from "@/lib/time";
import { orgSettings } from "../organizations/service";
import { isPlausiblePlate, normalizePlate, permitState } from "./plate";

type ViolationRow = typeof parkingViolations.$inferSelect;

export const canManageParking = (p: Principal) => p.permissions.has("parking.manage");
export const canUseParking = (p: Principal) => canManageParking(p) || (p.permissions.has("parking.use") && p.unitIds.size > 0);
export const MAX_VEHICLES_PER_UNIT = 4;

const optUuid = z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null);
const opt = (max: number) => z.string().trim().max(max).optional().transform(blankToNull);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time.");
const plateField = z.string().transform(normalizePlate).refine(isPlausiblePlate, "Enter a licence plate (2–8 letters and digits).");
const isExclusion = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23P01" || err?.cause?.code === "23P01";
};

const manageAt = (p: Principal, propertyId: string, buildingId?: string | null) => can(p, "parking.manage", { orgId: p.orgId, propertyId, buildingId: buildingId ?? null });
const scopeWhere = (p: Principal, property: SQLWrapper, building?: SQLWrapper) => scopeCondition(p, { property, building }) ?? sql`true`;

async function propertyOf(tx: Tx, orgId: string, propertyId: string) {
  const [pr] = await tx.select({ id: properties.id, name: properties.name, timezone: properties.timezone }).from(properties).where(and(eq(properties.orgId, orgId), eq(properties.id, propertyId)));
  if (!pr) throw new ValidationError("Property not found.", "propertyId");
  return pr;
}

// a unit by building + number (unit numbers are unique within a building)
export async function findUnitInBuilding(tx: Tx, orgId: string, buildingId: string, number: string) {
  const [u] = await tx.select({ id: units.id, number: units.number, propertyId: units.propertyId, buildingId: units.buildingId }).from(units)
    .where(and(eq(units.orgId, orgId), eq(units.buildingId, buildingId), sql`lower(${units.number}) = lower(${number})`));
  return u ?? null;
}

/* ───────────── spaces ───────────── */

export const spaceSchema = z.object({
  propertyId: z.string().uuid("Choose the property."),
  buildingId: optUuid,
  code: z.string().trim().min(1, "Enter the space number.").max(20).transform((v) => v.toUpperCase()),
  level: opt(40),
  kind: z.enum(PARKING_SPACE_KINDS),
  assignBuildingId: optUuid,
  assignUnitNumber: opt(20),
  status: z.enum(["available", "out_of_service"]).default("available"),
  notes: opt(300),
});

async function assignedUnit(tx: Tx, p: Principal, propertyId: string, input: { assignBuildingId: string | null; assignUnitNumber: string | null }) {
  if (!input.assignUnitNumber) return null;
  if (!input.assignBuildingId) throw new ValidationError("Choose the unit's building.", "assignBuildingId");
  const u = await findUnitInBuilding(tx, p.orgId, input.assignBuildingId, input.assignUnitNumber);
  if (!u || u.propertyId !== propertyId) throw new ValidationError(`No unit ${input.assignUnitNumber} in that building.`, "assignUnitNumber");
  return u.id;
}

export async function createSpace(ctx: TenantCtx, input: z.infer<typeof spaceSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    await propertyOf(tx, p.orgId, input.propertyId);
    authorize(p, "parking.manage", { orgId: p.orgId, propertyId: input.propertyId, buildingId: input.buildingId });
    const unitId = await assignedUnit(tx, p, input.propertyId, input);
    if (unitId && input.kind === "visitor") throw new ValidationError("Visitor spaces can't be assigned to a unit.", "kind");
    const [row] = await friendlyUnique(() => tx.insert(parkingSpaces).values({
      orgId: p.orgId, propertyId: input.propertyId, buildingId: input.buildingId, code: input.code, level: input.level, kind: input.kind,
      assignedUnitId: unitId, status: input.status, notes: input.notes,
    }).returning(), { parking_spaces_code_uq: [`Space ${input.code} already exists at this property.`, "code"] });
    await auditAs(tx, ctx, "parking.space_created", "parking_space", row.id, undefined, row);
    return row;
  });
}

export async function updateSpace(ctx: TenantCtx, id: string, input: z.infer<typeof spaceSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [s] = await tx.select().from(parkingSpaces).where(and(eq(parkingSpaces.id, id), eq(parkingSpaces.orgId, p.orgId)));
    if (!s) throw new NotFoundError();
    if (!manageAt(p, s.propertyId, s.buildingId)) throw new ForbiddenError();
    const unitId = await assignedUnit(tx, p, s.propertyId, input);
    if (unitId && input.kind === "visitor") throw new ValidationError("Visitor spaces can't be assigned to a unit.", "kind");
    const [row] = await friendlyUnique(() => tx.update(parkingSpaces).set({
      code: input.code, level: input.level, kind: input.kind, assignedUnitId: unitId, status: input.status, notes: input.notes,
    }).where(eq(parkingSpaces.id, id)).returning(), { parking_spaces_code_uq: [`Space ${input.code} already exists at this property.`, "code"] });
    await auditAs(tx, ctx, "parking.space_updated", "parking_space", id, s, row);
    return row;
  });
}

export const bulkSpaceSchema = z.object({
  propertyId: z.string().uuid("Choose the property."),
  buildingId: optUuid,
  prefix: z.string().trim().max(10).default("").transform((v) => v.toUpperCase()),
  from: z.coerce.number().int().min(0).max(9999),
  to: z.coerce.number().int().min(0).max(9999),
  pad: z.coerce.number().int().min(0).max(4).default(3),
  level: opt(40),
  kind: z.enum(PARKING_SPACE_KINDS),
}).superRefine((v, c) => {
  if (v.to < v.from) c.addIssue({ code: "custom", path: ["to"], message: "Must be at least the first number." });
  else if (v.to - v.from >= 500) c.addIssue({ code: "custom", path: ["to"], message: "Add at most 500 spaces at a time." });
});

// adds a numbered run of spaces (P1-001 … P1-060); existing codes are left alone
export async function createSpaces(ctx: TenantCtx, input: z.infer<typeof bulkSpaceSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    await propertyOf(tx, p.orgId, input.propertyId);
    authorize(p, "parking.manage", { orgId: p.orgId, propertyId: input.propertyId, buildingId: input.buildingId });
    const codes = Array.from({ length: input.to - input.from + 1 }, (_, i) => `${input.prefix}${String(input.from + i).padStart(input.pad, "0")}`);
    const rows = await tx.insert(parkingSpaces).values(codes.map((code) => ({
      orgId: p.orgId, propertyId: input.propertyId, buildingId: input.buildingId, code, level: input.level, kind: input.kind,
    }))).onConflictDoNothing().returning({ id: parkingSpaces.id });
    await auditAs(tx, ctx, "parking.spaces_created", "property", input.propertyId, undefined, { from: codes[0], to: codes.at(-1), created: rows.length });
    return { created: rows.length, skipped: codes.length - rows.length };
  });
}

export type SpaceRow = {
  id: string; code: string; level: string | null; kind: string; status: string; propertyId: string; propertyName: string; buildingName: string | null;
  assignedUnit: string | null; permitPlate: string | null; permitUntil: Date | null; permitKind: string | null;
};

export async function listSpaces(ctx: TenantCtx, opts: { propertyId?: string; kind?: string; q?: string; page?: number; pageSize?: number }): Promise<Page<SpaceRow>> {
  const p = ctx.principal;
  if (!canManageParking(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page, opts.pageSize ?? 50);
  const now = new Date();
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(parkingSpaces.orgId, p.orgId), scopeWhere(p, parkingSpaces.propertyId, parkingSpaces.buildingId),
      opts.propertyId ? eq(parkingSpaces.propertyId, opts.propertyId) : undefined,
      opts.kind && (PARKING_SPACE_KINDS as readonly string[]).includes(opts.kind) ? eq(parkingSpaces.kind, opts.kind) : undefined,
      opts.q ? ilike(parkingSpaces.code, `%${opts.q.replace(/[%_\\]/g, "\\$&")}%`) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(parkingSpaces).where(where);
    const rows = await tx.select({
      id: parkingSpaces.id, code: parkingSpaces.code, level: parkingSpaces.level, kind: parkingSpaces.kind, status: parkingSpaces.status,
      propertyId: parkingSpaces.propertyId, propertyName: properties.name, buildingName: buildings.name, assignedUnit: units.number,
      permitPlate: parkingPermits.plate, permitUntil: parkingPermits.validUntil, permitKind: parkingPermits.kind,
    }).from(parkingSpaces).innerJoin(properties, eq(properties.id, parkingSpaces.propertyId))
      .leftJoin(buildings, eq(buildings.id, parkingSpaces.buildingId)).leftJoin(units, eq(units.id, parkingSpaces.assignedUnitId))
      .leftJoin(parkingPermits, and(eq(parkingPermits.spaceId, parkingSpaces.id), eq(parkingPermits.status, "active"), lte(parkingPermits.validFrom, now),
        or(isNull(parkingPermits.validUntil), gt(parkingPermits.validUntil, now))))
      .where(where).orderBy(asc(properties.name), asc(parkingSpaces.code)).limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

// visitor spaces at a property that nobody holds right now (for check-in)
export async function freeVisitorSpaces(tx: Tx, orgId: string, propertyId: string, until: Date) {
  const now = new Date();
  return tx.select({ id: parkingSpaces.id, code: parkingSpaces.code }).from(parkingSpaces)
    .where(and(eq(parkingSpaces.orgId, orgId), eq(parkingSpaces.propertyId, propertyId), eq(parkingSpaces.kind, "visitor"), eq(parkingSpaces.status, "available"),
      sql`not exists (select 1 from parking_permits pp where pp.space_id = parking_spaces.id and pp.status = 'active'
        and tstzrange(pp.valid_from, pp.valid_until, '[)') && tstzrange(${now}, ${until}, '[)'))`))
    .orderBy(asc(parkingSpaces.code));
}

/* ───────────── vehicles ───────────── */

export const vehicleSchema = z.object({
  plate: plateField,
  region: opt(20),
  make: opt(40),
  model: opt(40),
  color: opt(30),
  unitId: optUuid,
  buildingId: optUuid,
  unitNumber: opt(20),
});

export async function addVehicle(ctx: TenantCtx, input: z.infer<typeof vehicleSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    let unit: { id: string; propertyId: string } | null = null;
    if (canManageParking(p) && input.buildingId && input.unitNumber) {
      unit = await findUnitInBuilding(tx, p.orgId, input.buildingId, input.unitNumber);
      if (!unit) throw new ValidationError(`No unit ${input.unitNumber} in that building.`, "unitNumber");
      authorize(p, "parking.manage", { orgId: p.orgId, propertyId: unit.propertyId, buildingId: input.buildingId });
    } else if (p.permissions.has("parking.use")) {
      const id = input.unitId ?? (p.unitIds.size === 1 ? [...p.unitIds][0] : null);
      if (!id) throw new ValidationError("Choose your unit.", "unitId");
      if (!p.unitIds.has(id)) throw new ForbiddenError("You can only register vehicles for your own unit.");
      [unit] = await tx.select({ id: units.id, propertyId: units.propertyId }).from(units).where(and(eq(units.orgId, p.orgId), eq(units.id, id)));
      if (!unit) throw new NotFoundError();
      const [{ n }] = await tx.select({ n: count() }).from(vehicles).where(and(eq(vehicles.unitId, unit.id), eq(vehicles.active, true)));
      if (n >= MAX_VEHICLES_PER_UNIT) throw new ValidationError(`A unit can register up to ${MAX_VEHICLES_PER_UNIT} vehicles. Remove one first, or ask the front desk.`);
    } else if (canManageParking(p)) {
      throw new ValidationError("Choose the building and unit.", "unitNumber");
    } else throw new ForbiddenError();
    const [v] = await friendlyUnique(() => tx.insert(vehicles).values({
      orgId: p.orgId, propertyId: unit.propertyId, unitId: unit.id, residentId: canManageParking(p) ? null : p.residentId,
      plate: input.plate, region: input.region, make: input.make, model: input.model, color: input.color, createdByUserId: p.userId,
    }).returning(), { vehicles_plate_active_uq: ["That plate is already registered. Contact the front desk if it's yours.", "plate"] });
    await auditAs(tx, ctx, "parking.vehicle_added", "vehicle", v.id, undefined, { plate: v.plate, unitId: v.unitId });
    return v;
  });
}

// deactivates a vehicle and revokes its resident permits
export async function removeVehicle(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(vehicles).where(and(eq(vehicles.id, id), eq(vehicles.orgId, p.orgId)));
    if (!v || !v.active) throw new NotFoundError();
    const own = p.permissions.has("parking.use") && p.unitIds.has(v.unitId);
    if (!own && !manageAt(p, v.propertyId)) throw own ? new ForbiddenError() : new NotFoundError();
    await tx.update(vehicles).set({ active: false }).where(eq(vehicles.id, id));
    const revoked = await tx.update(parkingPermits).set({ status: "revoked", revokedAt: new Date(), revokedByUserId: p.userId, revokeReason: "Vehicle removed" })
      .where(and(eq(parkingPermits.vehicleId, id), eq(parkingPermits.status, "active"))).returning({ id: parkingPermits.id });
    await auditAs(tx, ctx, "parking.vehicle_removed", "vehicle", id, { plate: v.plate, active: true }, { active: false, permitsRevoked: revoked.length });
    return { revoked: revoked.length };
  });
}

export async function listVehicles(ctx: TenantCtx, opts: { q?: string; propertyId?: string; page?: number }) {
  const p = ctx.principal;
  if (!canManageParking(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page, 50);
  const plate = normalizePlate(opts.q);
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(vehicles.orgId, p.orgId), eq(vehicles.active, true), scopeWhere(p, vehicles.propertyId),
      opts.propertyId ? eq(vehicles.propertyId, opts.propertyId) : undefined,
      opts.q ? or(plate ? ilike(vehicles.plate, `%${plate}%`) : undefined, sql`lower(${units.number}) = lower(${opts.q.trim()})`) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(vehicles).innerJoin(units, eq(units.id, vehicles.unitId)).where(where);
    const rows = await tx.select({ id: vehicles.id, plate: vehicles.plate, region: vehicles.region, make: vehicles.make, model: vehicles.model, color: vehicles.color,
      unitNumber: units.number, buildingName: buildings.name, propertyName: properties.name, createdAt: vehicles.createdAt })
      .from(vehicles).innerJoin(units, eq(units.id, vehicles.unitId)).innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, vehicles.propertyId))
      .where(where).orderBy(asc(vehicles.plate)).limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

/* ───────────── permits ───────────── */

export const permitSchema = z.object({
  propertyId: z.string().uuid("Choose the property."),
  kind: z.enum(["resident", "visitor", "contractor", "staff"]),
  plate: plateField,
  buildingId: optUuid,
  unitNumber: opt(20),
  spaceCode: opt(20),
  fromDate: dateStr,
  fromTime: hhmm.default("00:00"),
  untilDate: z.union([z.literal(""), dateStr]).optional().transform((v) => v || null),
  untilTime: hhmm.default("23:59"),
  notes: opt(300),
});

export async function issuePermit(ctx: TenantCtx, input: z.infer<typeof permitSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const pr = await propertyOf(tx, p.orgId, input.propertyId);
    authorize(p, "parking.manage", { orgId: p.orgId, propertyId: pr.id });
    let unitId: string | null = null;
    if (input.unitNumber) {
      if (!input.buildingId) throw new ValidationError("Choose the unit's building.", "buildingId");
      const u = await findUnitInBuilding(tx, p.orgId, input.buildingId, input.unitNumber);
      if (!u || u.propertyId !== pr.id) throw new ValidationError(`No unit ${input.unitNumber} in that building.`, "unitNumber");
      unitId = u.id;
    } else if (input.kind === "resident") throw new ValidationError("Resident permits belong to a unit.", "unitNumber");
    let spaceId: string | null = null;
    if (input.spaceCode) {
      const [s] = await tx.select().from(parkingSpaces).where(and(eq(parkingSpaces.propertyId, pr.id), eq(parkingSpaces.code, input.spaceCode.toUpperCase())));
      if (!s) throw new ValidationError(`No space ${input.spaceCode.toUpperCase()} at ${pr.name}.`, "spaceCode");
      if (s.status !== "available") throw new ValidationError(`Space ${s.code} is out of service.`, "spaceCode");
      if (input.kind === "visitor" && s.kind !== "visitor") throw new ValidationError("Visitor permits use visitor spaces.", "spaceCode");
      if (input.kind !== "visitor" && s.kind === "visitor") throw new ValidationError("Visitor spaces are for visitor permits.", "spaceCode");
      if (s.assignedUnitId && unitId && s.assignedUnitId !== unitId) throw new ValidationError(`Space ${s.code} is assigned to another unit.`, "spaceCode");
      spaceId = s.id;
    }
    const validFrom = zonedToUtc(`${input.fromDate}T${input.fromTime}`, pr.timezone);
    const validUntil = input.untilDate ? zonedToUtc(`${input.untilDate}T${input.untilTime}`, pr.timezone) : null;
    if (validUntil && validUntil <= validFrom) throw new ValidationError("The permit must end after it starts.", "untilDate");
    if (input.kind === "visitor" && !validUntil) throw new ValidationError("Visitor permits need an end date.", "untilDate");
    const [veh] = await tx.select({ id: vehicles.id }).from(vehicles).where(and(eq(vehicles.orgId, p.orgId), eq(vehicles.plate, input.plate), eq(vehicles.active, true)));
    const number = await nextNumber(tx, p.orgId, "parking_permit");
    try {
      const [row] = await tx.insert(parkingPermits).values({
        orgId: p.orgId, number, propertyId: pr.id, kind: input.kind, plate: input.plate, vehicleId: veh?.id ?? null, unitId, spaceId,
        validFrom, validUntil, notes: input.notes, issuedByUserId: p.userId,
      }).returning();
      await auditAs(tx, ctx, "parking.permit_issued", "parking_permit", row.id, undefined, row);
      return row;
    } catch (e) {
      if (isExclusion(e)) throw new ValidationError("That space already has a permit for part of that time.", "spaceCode");
      throw e;
    }
  });
}

// visitor parking assigned at check-in (runs inside the visitor transaction)
export async function issueVisitorPermitTx(tx: Tx, ctx: TenantCtx, v: { id: string; propertyId: string; unitId: string | null; plate: string | null; expectedUntil: Date }, spaceId: string) {
  const p = ctx.principal;
  if (!v.plate) throw new ValidationError("Enter the visitor's licence plate to give them parking.", "plate");
  const [s] = await tx.select().from(parkingSpaces).where(and(eq(parkingSpaces.id, spaceId), eq(parkingSpaces.orgId, p.orgId)));
  if (!s || s.propertyId !== v.propertyId || s.kind !== "visitor") throw new ValidationError("Choose a visitor space at this property.", "spaceId");
  if (s.status !== "available") throw new ValidationError(`Space ${s.code} is out of service.`, "spaceId");
  const now = new Date();
  const until = v.expectedUntil > now ? v.expectedUntil : new Date(now.getTime() + 2 * 3_600_000);
  const number = await nextNumber(tx, p.orgId, "parking_permit");
  try {
    // a savepoint keeps the visitor transaction usable when the space was just taken
    const [row] = await tx.transaction((sp) => sp.insert(parkingPermits).values({
      orgId: p.orgId, number, propertyId: v.propertyId, kind: "visitor", plate: v.plate!, unitId: v.unitId, spaceId: s.id, visitorId: v.id,
      validFrom: now, validUntil: until, issuedByUserId: p.userId,
    }).returning());
    await auditAs(tx, ctx, "parking.permit_issued", "parking_permit", row.id, undefined, { number, plate: row.plate, space: s.code, visitorId: v.id });
    return { permit: row, spaceCode: s.code };
  } catch (e) {
    if (isExclusion(e)) throw new ValidationError(`Space ${s.code} was just taken. Choose another.`, "spaceId");
    throw e;
  }
}

// ends visitor permits when the guest leaves
export async function endVisitorPermitsTx(tx: Tx, visitorId: string) {
  const now = new Date();
  await tx.update(parkingPermits).set({ validUntil: now }).where(and(eq(parkingPermits.visitorId, visitorId), eq(parkingPermits.status, "active"),
    or(isNull(parkingPermits.validUntil), gt(parkingPermits.validUntil, now)), lte(parkingPermits.validFrom, now)));
}

export const revokeSchema = z.object({ reason: z.string().trim().min(3, "Say why.").max(300) });

export async function revokePermit(ctx: TenantCtx, id: string, input: z.infer<typeof revokeSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(parkingPermits).where(and(eq(parkingPermits.id, id), eq(parkingPermits.orgId, p.orgId)));
    if (!r) throw new NotFoundError();
    if (!manageAt(p, r.propertyId)) throw new NotFoundError();
    if (r.status === "revoked") throw new ValidationError("Already revoked.");
    await tx.update(parkingPermits).set({ status: "revoked", revokedAt: new Date(), revokedByUserId: p.userId, revokeReason: input.reason }).where(eq(parkingPermits.id, id));
    await auditAs(tx, ctx, "parking.permit_revoked", "parking_permit", id, { status: r.status }, { status: "revoked", reason: input.reason });
  });
}

export type PermitView = "active" | "expired" | "revoked" | "all";

export async function listPermits(ctx: TenantCtx, opts: { view?: PermitView; q?: string; propertyId?: string; page?: number }) {
  const p = ctx.principal;
  if (!canManageParking(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page, 50);
  const now = new Date();
  const view = opts.view ?? "active";
  const live = or(isNull(parkingPermits.validUntil), gt(parkingPermits.validUntil, now));
  const cond: Record<PermitView, SQL | undefined> = {
    active: and(eq(parkingPermits.status, "active"), live),
    expired: and(eq(parkingPermits.status, "active"), lte(parkingPermits.validUntil, now)),
    revoked: eq(parkingPermits.status, "revoked"),
    all: undefined,
  };
  const plate = normalizePlate(opts.q);
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(parkingPermits.orgId, p.orgId), scopeWhere(p, parkingPermits.propertyId), cond[view],
      opts.propertyId ? eq(parkingPermits.propertyId, opts.propertyId) : undefined,
      opts.q ? or(plate ? ilike(parkingPermits.plate, `%${plate}%`) : undefined, sql`lower(${units.number}) = lower(${opts.q.trim()})`, sql`${parkingPermits.number}::text = ${opts.q.trim()}`) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(parkingPermits).leftJoin(units, eq(units.id, parkingPermits.unitId)).where(where);
    const rows = await tx.select({
      id: parkingPermits.id, number: parkingPermits.number, kind: parkingPermits.kind, plate: parkingPermits.plate, status: parkingPermits.status,
      validFrom: parkingPermits.validFrom, validUntil: parkingPermits.validUntil, unitNumber: units.number, spaceCode: parkingSpaces.code, propertyName: properties.name,
      visitorId: parkingPermits.visitorId, tz: properties.timezone,
    }).from(parkingPermits).innerJoin(properties, eq(properties.id, parkingPermits.propertyId))
      .leftJoin(units, eq(units.id, parkingPermits.unitId)).leftJoin(parkingSpaces, eq(parkingSpaces.id, parkingPermits.spaceId))
      .where(where).orderBy(desc(parkingPermits.validFrom)).limit(pageSize).offset(offset);
    return toPage(rows.map((r) => ({ ...r, state: permitState(r, now) })), n, page, pageSize);
  });
}

/* ───────────── plate lookup (patrols, front desk) ───────────── */

// everything known about a plate in the principal's scope; information for a person to act on, never a verdict
export async function lookupPlate(ctx: TenantCtx, raw: string) {
  const p = ctx.principal;
  if (!canManageParking(p)) throw new ForbiddenError();
  const plate = normalizePlate(raw);
  if (!isPlausiblePlate(plate)) throw new ValidationError("Enter a licence plate.", "plate");
  const now = new Date();
  return tenantTx(ctx, async (tx) => {
    const vehicleRows = await tx.select({ id: vehicles.id, make: vehicles.make, model: vehicles.model, color: vehicles.color, unitNumber: units.number, buildingName: buildings.name, propertyName: properties.name })
      .from(vehicles).innerJoin(units, eq(units.id, vehicles.unitId)).innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, vehicles.propertyId))
      .where(and(eq(vehicles.orgId, p.orgId), eq(vehicles.plate, plate), eq(vehicles.active, true), scopeWhere(p, vehicles.propertyId)));
    const permitRows = await tx.select({ id: parkingPermits.id, number: parkingPermits.number, kind: parkingPermits.kind, status: parkingPermits.status, validFrom: parkingPermits.validFrom,
      validUntil: parkingPermits.validUntil, spaceCode: parkingSpaces.code, unitNumber: units.number, propertyName: properties.name, tz: properties.timezone })
      .from(parkingPermits).innerJoin(properties, eq(properties.id, parkingPermits.propertyId)).leftJoin(parkingSpaces, eq(parkingSpaces.id, parkingPermits.spaceId)).leftJoin(units, eq(units.id, parkingPermits.unitId))
      .where(and(eq(parkingPermits.orgId, p.orgId), eq(parkingPermits.plate, plate), scopeWhere(p, parkingPermits.propertyId)))
      .orderBy(desc(parkingPermits.validFrom)).limit(10);
    const visitorRows = await tx.select({ id: visitors.id, name: visitors.name, status: visitors.status, expectedUntil: visitors.expectedUntil, unitNumber: units.number })
      .from(visitors).leftJoin(units, eq(units.id, visitors.unitId))
      .where(and(eq(visitors.orgId, p.orgId), eq(visitors.plate, plate), inArray(visitors.status, ["expected", "checked_in"]), gt(visitors.expectedUntil, new Date(now.getTime() - 12 * 3_600_000)),
        scopeCondition(p, { property: visitors.propertyId, building: visitors.buildingId }) ?? sql`true`))
      .limit(5);
    const violationRows = await tx.select({ id: parkingViolations.id, number: parkingViolations.number, kind: parkingViolations.kind, status: parkingViolations.status, observedAt: parkingViolations.observedAt })
      .from(parkingViolations).where(and(eq(parkingViolations.orgId, p.orgId), eq(parkingViolations.plate, plate), scopeWhere(p, parkingViolations.propertyId)))
      .orderBy(desc(parkingViolations.observedAt)).limit(5);
    const permits = permitRows.map((r) => ({ ...r, state: permitState(r, now) }));
    return { plate, vehicles: vehicleRows, permits, visitors: visitorRows, violations: violationRows, validPermitNow: permits.some((x) => x.state === "active") };
  });
}

/* ───────────── violations ───────────── */

export const violationSchema = z.object({
  propertyId: z.string().uuid("Choose the property."),
  buildingId: optUuid,
  plate: plateField,
  spaceCode: opt(20),
  location: opt(120),
  kind: z.enum(PARKING_VIOLATION_KINDS),
  description: opt(1000),
  observedAt: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)]).optional().transform((v) => v || null),
});

// facts at the time of the report: the registered vehicle (if any) and whether a permit was valid
async function matchPlate(tx: Tx, orgId: string, propertyId: string, plate: string, at: Date) {
  const [veh] = await tx.select({ id: vehicles.id, unitId: vehicles.unitId }).from(vehicles).where(and(eq(vehicles.orgId, orgId), eq(vehicles.plate, plate), eq(vehicles.active, true)));
  const [permit] = await tx.select({ id: parkingPermits.id }).from(parkingPermits).where(and(eq(parkingPermits.orgId, orgId), eq(parkingPermits.propertyId, propertyId), eq(parkingPermits.plate, plate),
    eq(parkingPermits.status, "active"), lte(parkingPermits.validFrom, at), or(isNull(parkingPermits.validUntil), gt(parkingPermits.validUntil, at)))).limit(1);
  return { vehicleId: veh?.id ?? null, unitId: veh?.unitId ?? null, hadValidPermit: !!permit };
}

export async function reportViolation(ctx: TenantCtx, input: z.infer<typeof violationSchema>, photos: File[] = []) {
  const p = ctx.principal;
  const prepared = photos.length ? await prepareFiles(p.orgId, "parking_violation", photos) : [];
  return withStoredBlobs(prepared, () => tenantTx(ctx, async (tx) => {
    const pr = await propertyOf(tx, p.orgId, input.propertyId);
    authorize(p, "parking.manage", { orgId: p.orgId, propertyId: pr.id, buildingId: input.buildingId });
    let spaceId: string | null = null;
    if (input.spaceCode) {
      const [s] = await tx.select({ id: parkingSpaces.id }).from(parkingSpaces).where(and(eq(parkingSpaces.propertyId, pr.id), eq(parkingSpaces.code, input.spaceCode.toUpperCase())));
      if (!s) throw new ValidationError(`No space ${input.spaceCode.toUpperCase()} at ${pr.name}.`, "spaceCode");
      spaceId = s.id;
    }
    const observedAt = input.observedAt ? zonedToUtc(input.observedAt, pr.timezone) : new Date();
    if (observedAt.getTime() > Date.now() + 5 * 60_000) throw new ValidationError("That time is in the future.", "observedAt");
    const match = await matchPlate(tx, p.orgId, pr.id, input.plate, observedAt);
    const number = await nextNumber(tx, p.orgId, "parking_violation");
    const [v] = await tx.insert(parkingViolations).values({
      orgId: p.orgId, number, propertyId: pr.id, buildingId: input.buildingId, spaceId, plate: input.plate, location: input.location, kind: input.kind,
      description: input.description, observedAt, source: "staff", reportedByUserId: p.userId, ...match,
    }).returning();
    if (prepared.length) await tx.insert(files).values(fileRows(prepared, p, "parking_violation", v.id, "internal"));
    await auditAs(tx, ctx, "parking.violation_reported", "parking_violation", v.id, undefined, { number, plate: v.plate, kind: v.kind, ...match });
    await emit(tx, ctx, "parking.violation_reported", { violationId: v.id });
    return v;
  }));
}

// entry point for a camera / licence-plate-recognition integration: always lands as a detection awaiting human review
export async function ingestDetection(orgId: string, input: { propertyId: string; plate: string; kind: (typeof PARKING_VIOLATION_KINDS)[number]; confidence: number; observedAt: Date; location?: string | null; spaceCode?: string | null }) {
  const plate = normalizePlate(input.plate);
  if (!isPlausiblePlate(plate)) throw new ValidationError("Unreadable plate.");
  if (!(input.confidence >= 0 && input.confidence <= 1)) throw new ValidationError("Confidence must be between 0 and 1.");
  return withContext({ orgId, system: true }, async (tx) => {
    await propertyOf(tx, orgId, input.propertyId);
    const [s] = input.spaceCode ? await tx.select({ id: parkingSpaces.id }).from(parkingSpaces).where(and(eq(parkingSpaces.propertyId, input.propertyId), eq(parkingSpaces.code, input.spaceCode.toUpperCase()))) : [];
    const match = await matchPlate(tx, orgId, input.propertyId, plate, input.observedAt);
    const number = await nextNumber(tx, orgId, "parking_violation");
    const [v] = await tx.insert(parkingViolations).values({
      orgId, number, propertyId: input.propertyId, spaceId: s?.id ?? null, plate, location: input.location ?? null, kind: input.kind, observedAt: input.observedAt,
      source: "detection", confidence: input.confidence.toFixed(3), ...match,
    }).returning();
    await emitSystem(tx, orgId, "parking.violation_reported", { violationId: v.id });
    return v;
  });
}

function violationAccess(p: Principal, v: ViolationRow) {
  const manage = v.orgId === p.orgId && manageAt(p, v.propertyId, v.buildingId);
  // residents only ever see notices that were actually issued about their unit's vehicle
  const notice = v.orgId === p.orgId && p.permissions.has("parking.use") && !!v.unitId && p.unitIds.has(v.unitId) && !!v.warnedAt;
  return { manage, notice, read: manage || notice };
}

export const reviewSchema = z.object({
  decision: z.enum(["confirm", "dismiss"]),
  note: opt(1000),
}).superRefine((v, c) => {
  if (v.decision === "dismiss" && !v.note) c.addIssue({ code: "custom", path: ["note"], message: "Say why it's being dismissed." });
});

// the human review step: nothing reaches a resident until someone confirms what was reported or detected
export async function reviewViolation(ctx: TenantCtx, id: string, input: z.infer<typeof reviewSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(parkingViolations).where(and(eq(parkingViolations.id, id), eq(parkingViolations.orgId, p.orgId))).for("update");
    if (!v || !violationAccess(p, v).manage) throw new NotFoundError();
    if (v.status !== "reported") throw new ValidationError("This report has already been reviewed.");
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, p.orgId));
    if (orgSettings(org?.settings).parkingSecondReviewer && v.reportedByUserId === p.userId) {
      throw new ForbiddenError("Another staff member has to review your own report.");
    }
    const status = input.decision === "confirm" ? "confirmed" : "dismissed";
    const [row] = await tx.update(parkingViolations).set({ status, reviewedByUserId: p.userId, reviewedAt: new Date(), reviewNote: input.note, resolvedAt: status === "dismissed" ? new Date() : null })
      .where(eq(parkingViolations.id, id)).returning();
    await auditAs(tx, ctx, `parking.violation_${status}`, "parking_violation", id, { status: v.status }, { status, note: input.note, source: v.source });
    return row;
  });
}

export const warnSchema = z.object({ message: z.string().trim().min(10, "Write the notice the resident will receive.").max(1000) });

export async function warnViolation(ctx: TenantCtx, id: string, input: z.infer<typeof warnSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(parkingViolations).where(and(eq(parkingViolations.id, id), eq(parkingViolations.orgId, p.orgId))).for("update");
    if (!v || !violationAccess(p, v).manage) throw new NotFoundError();
    if (v.status !== "confirmed") throw new ValidationError(v.status === "reported" ? "Review and confirm the report before issuing a notice." : "A notice can't be issued at this stage.");
    const [row] = await tx.update(parkingViolations).set({ status: "warned", warnedAt: new Date(), warningText: input.message }).where(eq(parkingViolations.id, id)).returning();
    await auditAs(tx, ctx, "parking.notice_issued", "parking_violation", id, { status: v.status }, { status: "warned", unitId: v.unitId });
    if (v.unitId) await emit(tx, ctx, "parking.notice_issued", { violationId: id });
    return { violation: row, notified: !!v.unitId };
  });
}

export const resolveSchema = z.object({ resolution: z.string().trim().min(3, "Describe the outcome.").max(1000) });

export async function resolveViolation(ctx: TenantCtx, id: string, input: z.infer<typeof resolveSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(parkingViolations).where(and(eq(parkingViolations.id, id), eq(parkingViolations.orgId, p.orgId))).for("update");
    if (!v || !violationAccess(p, v).manage) throw new NotFoundError();
    if (!["confirmed", "warned"].includes(v.status)) throw new ValidationError("Only confirmed reports can be resolved.");
    await tx.update(parkingViolations).set({ status: "resolved", resolvedAt: new Date(), resolution: input.resolution }).where(eq(parkingViolations.id, id));
    await auditAs(tx, ctx, "parking.violation_resolved", "parking_violation", id, { status: v.status }, { status: "resolved", resolution: input.resolution });
  });
}

export type ViolationView = "review" | "open" | "closed" | "all";

export async function listViolations(ctx: TenantCtx, opts: { view?: ViolationView; q?: string; propertyId?: string; page?: number }) {
  const p = ctx.principal;
  if (!canManageParking(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page, 50);
  const view = opts.view ?? "review";
  const cond: Record<ViolationView, SQL | undefined> = {
    review: eq(parkingViolations.status, "reported"),
    open: inArray(parkingViolations.status, ["confirmed", "warned"]),
    closed: inArray(parkingViolations.status, ["dismissed", "resolved"]),
    all: undefined,
  };
  const plate = normalizePlate(opts.q);
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(parkingViolations.orgId, p.orgId), scopeWhere(p, parkingViolations.propertyId), cond[view],
      opts.propertyId ? eq(parkingViolations.propertyId, opts.propertyId) : undefined,
      opts.q ? or(plate ? ilike(parkingViolations.plate, `%${plate}%`) : undefined, sql`${parkingViolations.number}::text = ${opts.q.trim()}`) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(parkingViolations).where(where);
    const rows = await tx.select({
      id: parkingViolations.id, number: parkingViolations.number, plate: parkingViolations.plate, kind: parkingViolations.kind, status: parkingViolations.status,
      source: parkingViolations.source, confidence: parkingViolations.confidence, observedAt: parkingViolations.observedAt, location: parkingViolations.location,
      spaceCode: parkingSpaces.code, propertyName: properties.name, unitNumber: units.number, hadValidPermit: parkingViolations.hadValidPermit, tz: properties.timezone,
    }).from(parkingViolations).innerJoin(properties, eq(properties.id, parkingViolations.propertyId))
      .leftJoin(parkingSpaces, eq(parkingSpaces.id, parkingViolations.spaceId)).leftJoin(units, eq(units.id, parkingViolations.unitId))
      .where(where).orderBy(desc(parkingViolations.observedAt)).limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

export async function getViolation(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(parkingViolations).where(and(eq(parkingViolations.id, id), eq(parkingViolations.orgId, p.orgId)));
    if (!v) throw new NotFoundError();
    const access = violationAccess(p, v);
    if (!access.read) throw new NotFoundError();
    const [labels] = await tx.select({ propertyName: properties.name, tz: properties.timezone }).from(properties).where(eq(properties.id, v.propertyId));
    const [space] = v.spaceId ? await tx.select({ code: parkingSpaces.code }).from(parkingSpaces).where(eq(parkingSpaces.id, v.spaceId)) : [];
    const [unit] = v.unitId ? await tx.select({ number: units.number, buildingName: buildings.name }).from(units).innerJoin(buildings, eq(buildings.id, units.buildingId)).where(eq(units.id, v.unitId)) : [];
    if (!access.manage) {
      // the resident's view: the notice and the facts it's about, nothing about who reported it or the evidence
      return { access, labels, spaceCode: space?.code ?? null, unit: unit ?? null, violation: { id: v.id, number: v.number, plate: v.plate, kind: v.kind, status: v.status, observedAt: v.observedAt, location: v.location, warnedAt: v.warnedAt, warningText: v.warningText, resolution: v.status === "resolved" ? v.resolution : null } };
    }
    const names = async (uid: string | null) => (uid ? (await tx.select({ name: users.name }).from(users).where(eq(users.id, uid)))[0]?.name ?? null : null);
    const evidence = await tx.select().from(files).where(and(eq(files.entityType, "parking_violation"), eq(files.entityId, id))).orderBy(asc(files.createdAt));
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, p.orgId));
    const secondReviewer = !!orgSettings(org?.settings).parkingSecondReviewer;
    return {
      access, labels, spaceCode: space?.code ?? null, unit: unit ?? null, violation: v, evidence,
      reportedByName: await names(v.reportedByUserId), reviewedByName: await names(v.reviewedByUserId),
      mustDeferReview: secondReviewer && v.status === "reported" && v.reportedByUserId === p.userId,
    };
  });
}

/* ───────────── resident view & stats ───────────── */

export async function myParking(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.permissions.has("parking.use") || !p.unitIds.size) throw new ForbiddenError();
  const unitIds = [...p.unitIds];
  const now = new Date();
  return tenantTx(ctx, async (tx) => {
    const spaces = await tx.select({ id: parkingSpaces.id, code: parkingSpaces.code, level: parkingSpaces.level, kind: parkingSpaces.kind, propertyName: properties.name, unitNumber: units.number })
      .from(parkingSpaces).innerJoin(properties, eq(properties.id, parkingSpaces.propertyId)).innerJoin(units, eq(units.id, parkingSpaces.assignedUnitId))
      .where(and(eq(parkingSpaces.orgId, p.orgId), inArray(parkingSpaces.assignedUnitId, unitIds))).orderBy(asc(parkingSpaces.code));
    const cars = await tx.select({ id: vehicles.id, plate: vehicles.plate, region: vehicles.region, make: vehicles.make, model: vehicles.model, color: vehicles.color, unitNumber: units.number })
      .from(vehicles).innerJoin(units, eq(units.id, vehicles.unitId))
      .where(and(eq(vehicles.orgId, p.orgId), inArray(vehicles.unitId, unitIds), eq(vehicles.active, true))).orderBy(asc(vehicles.plate));
    const permits = await tx.select({ id: parkingPermits.id, number: parkingPermits.number, kind: parkingPermits.kind, plate: parkingPermits.plate, status: parkingPermits.status,
      validFrom: parkingPermits.validFrom, validUntil: parkingPermits.validUntil, spaceCode: parkingSpaces.code, tz: properties.timezone })
      .from(parkingPermits).innerJoin(properties, eq(properties.id, parkingPermits.propertyId)).leftJoin(parkingSpaces, eq(parkingSpaces.id, parkingPermits.spaceId))
      .where(and(eq(parkingPermits.orgId, p.orgId), inArray(parkingPermits.unitId, unitIds), eq(parkingPermits.status, "active"), or(isNull(parkingPermits.validUntil), gt(parkingPermits.validUntil, now))))
      .orderBy(asc(parkingPermits.validFrom));
    const notices = await tx.select({ id: parkingViolations.id, number: parkingViolations.number, plate: parkingViolations.plate, kind: parkingViolations.kind, status: parkingViolations.status, warnedAt: parkingViolations.warnedAt })
      .from(parkingViolations).where(and(eq(parkingViolations.orgId, p.orgId), inArray(parkingViolations.unitId, unitIds), sql`${parkingViolations.warnedAt} is not null`,
        gt(parkingViolations.warnedAt, new Date(now.getTime() - 180 * 86_400_000))))
      .orderBy(desc(parkingViolations.warnedAt));
    return { spaces, vehicles: cars, permits: permits.map((x) => ({ ...x, state: permitState(x, now) })), notices, unitCount: unitIds.length };
  });
}

export async function parkingStats(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!canManageParking(p)) return null;
  const now = new Date();
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select({
      review: sql<number>`count(*) filter (where ${parkingViolations.status} = 'reported')::int`,
      open: sql<number>`count(*) filter (where ${parkingViolations.status} in ('confirmed','warned'))::int`,
      detections: sql<number>`count(*) filter (where ${parkingViolations.status} = 'reported' and ${parkingViolations.source} = 'detection')::int`,
    }).from(parkingViolations).where(and(eq(parkingViolations.orgId, p.orgId), scopeWhere(p, parkingViolations.propertyId)));
    const [s] = await tx.select({
      spaces: sql<number>`count(*)::int`,
      visitor: sql<number>`count(*) filter (where ${parkingSpaces.kind} = 'visitor' and ${parkingSpaces.status} = 'available')::int`,
      visitorTaken: sql<number>`count(*) filter (where ${parkingSpaces.kind} = 'visitor' and exists (select 1 from parking_permits pp where pp.space_id = parking_spaces.id and pp.status = 'active' and pp.valid_from <= ${now} and (pp.valid_until is null or pp.valid_until > ${now})))::int`,
    }).from(parkingSpaces).where(and(eq(parkingSpaces.orgId, p.orgId), scopeWhere(p, parkingSpaces.propertyId, parkingSpaces.buildingId)));
    const [pm] = await tx.select({ n: count() }).from(parkingPermits).where(and(eq(parkingPermits.orgId, p.orgId), scopeWhere(p, parkingPermits.propertyId), eq(parkingPermits.status, "active"),
      lte(parkingPermits.validFrom, now), or(isNull(parkingPermits.validUntil), gt(parkingPermits.validUntil, now))));
    return { ...v, ...s, visitorFree: Math.max(0, s.visitor - s.visitorTaken), activePermits: pm.n };
  });
}

// properties and buildings where the principal manages parking (form options)
export async function parkingFormOptions(ctx: TenantCtx) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({ id: buildings.id, name: buildings.name, propertyId: properties.id, propertyName: properties.name }).from(buildings)
      .innerJoin(properties, eq(properties.id, buildings.propertyId))
      .where(and(eq(buildings.orgId, p.orgId), scopeCondition(p, { property: buildings.propertyId, building: buildings.id }) ?? sql`true`))
      .orderBy(asc(properties.name), asc(buildings.name));
    const ok = rows.filter((b) => manageAt(p, b.propertyId, b.id));
    const props = [...new Map(ok.map((b) => [b.propertyId, { id: b.propertyId, name: b.propertyName }])).values()].filter((x) => manageAt(p, x.id));
    return { buildings: ok, properties: props };
  });
}

export async function getSpace(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [s] = await tx.select().from(parkingSpaces).where(and(eq(parkingSpaces.id, id), eq(parkingSpaces.orgId, p.orgId)));
    if (!s || !manageAt(p, s.propertyId, s.buildingId)) throw new NotFoundError();
    const [u] = s.assignedUnitId ? await tx.select({ number: units.number, buildingId: units.buildingId }).from(units).where(eq(units.id, s.assignedUnitId)) : [];
    const [pr] = await tx.select({ name: properties.name, tz: properties.timezone }).from(properties).where(eq(properties.id, s.propertyId));
    const history = await tx.select({ id: parkingPermits.id, number: parkingPermits.number, kind: parkingPermits.kind, plate: parkingPermits.plate, status: parkingPermits.status, validFrom: parkingPermits.validFrom, validUntil: parkingPermits.validUntil })
      .from(parkingPermits).where(eq(parkingPermits.spaceId, id)).orderBy(desc(parkingPermits.validFrom)).limit(20);
    return { space: s, unit: u ?? null, property: pr, permits: history.map((x) => ({ ...x, state: permitState(x) })) };
  });
}
