import "server-only";
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { amenities, amenityBlackouts, bookings, buildings, properties, units, users, AMENITY_KINDS } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { emit, nextNumber } from "../ops/core";
import { zonedToUtc } from "@/lib/time";
import { createWorkOrder } from "../maintenance/service";
import { canResidentCancel, dayWindow, describeRules, evaluateBooking, nextDate, parseMinute, type AmenityRules } from "./rules";

type AmenityRow = typeof amenities.$inferSelect;
type BookingRow = typeof bookings.$inferSelect;
const LIVE = ["requested", "approved"] as const;
const checkbox = z.union([z.literal("on"), z.literal(""), z.literal("true"), z.literal("false")]).optional().transform((v) => v === "on" || v === "true");
const optUuid = z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null);
const optInt = (min: number, max: number) => z.union([z.literal(""), z.coerce.number().int().min(min).max(max)]).optional().transform((v) => (v === "" || v === undefined ? null : v));
const dollars = z.union([z.literal(""), z.coerce.number().min(0).max(100_000)]).optional().transform((v) => (v === "" || v === undefined ? 0 : Math.round(v * 100)));

export const toRules = (a: AmenityRow): AmenityRules => ({
  active: a.active, opensAtMinute: a.opensAtMinute, closesAtMinute: a.closesAtMinute, slotMinutes: a.slotMinutes,
  minDurationMinutes: a.minDurationMinutes, maxDurationMinutes: a.maxDurationMinutes, minNoticeHours: a.minNoticeHours, maxAdvanceDays: a.maxAdvanceDays,
  maxConcurrent: a.maxConcurrent, capacity: a.capacity, limitCount: a.limitCount, limitPeriodDays: a.limitPeriodDays,
  requiresApproval: a.requiresApproval, feeCents: a.feeCents, depositCents: a.depositCents, eligibleRoles: a.eligibleRoles, cancellationHours: a.cancellationHours,
});

/* ───────────── access ───────────── */

const res = (a: { orgId: string; propertyId: string; buildingId: string | null }) => ({ orgId: a.orgId, propertyId: a.propertyId, buildingId: a.buildingId });

// residents see active amenities of their property (and of their own building when building-specific)
function residentCanSee(p: Principal, a: AmenityRow) {
  return p.role.category === "resident" && a.active && p.occupantPropertyIds.has(a.propertyId) && (!a.buildingId || p.occupantBuildingIds.has(a.buildingId));
}
export const canManageAmenity = (p: Principal, a: AmenityRow) => can(p, "amenity.manage", res(a));
const canManageBookings = (p: Principal, a: { orgId: string; propertyId: string; buildingId: string | null }) => can(p, "booking.manage", res(a));
function canSeeAmenity(p: Principal, a: AmenityRow) {
  if (a.orgId !== p.orgId) return false;
  if (p.role.category === "staff") return can(p, "amenity.read", res(a)) || canManageAmenity(p, a) || canManageBookings(p, a);
  return residentCanSee(p, a) && p.permissions.has("amenity.read");
}

export function amenityVisibleWhere(p: Principal): SQL {
  if (p.role.category === "staff") {
    if (!["amenity.read", "amenity.manage", "booking.manage"].some((x) => p.permissions.has(x))) return sql`false`;
    return scopeCondition(p, { property: amenities.propertyId, building: amenities.buildingId }) ?? sql`true`;
  }
  if (p.role.category !== "resident" || !p.permissions.has("amenity.read")) return sql`false`;
  const props = [...p.occupantPropertyIds], blds = [...p.occupantBuildingIds];
  if (!props.length) return sql`false`;
  return and(eq(amenities.active, true), inArray(amenities.propertyId, props), or(isNull(amenities.buildingId), blds.length ? inArray(amenities.buildingId, blds) : sql`false`))!;
}

async function loadAmenity(tx: Tx, orgId: string, id: string, lock = false) {
  const q = tx.select().from(amenities).where(and(eq(amenities.id, id), eq(amenities.orgId, orgId)));
  const [a] = lock ? await q.for("update") : await q;
  if (!a) throw new NotFoundError();
  return a;
}

async function propertyTz(tx: Tx, propertyId: string) {
  const [pr] = await tx.select({ tz: properties.timezone, name: properties.name }).from(properties).where(eq(properties.id, propertyId));
  return pr?.tz ?? "America/Vancouver";
}

/* ───────────── amenities ───────────── */

export async function listAmenities(ctx: TenantCtx, opts: { propertyId?: string; includeInactive?: boolean } = {}) {
  const p = ctx.principal;
  return tenantTx(ctx, (tx) =>
    tx.select({
      a: amenities, propertyName: properties.name, buildingName: buildings.name,
      upcoming: sql<number>`(select count(*)::int from bookings b where b.amenity_id = amenities.id and b.status in ('requested','approved') and b.ends_at > now())`,
      pending: sql<number>`(select count(*)::int from bookings b where b.amenity_id = amenities.id and b.status = 'requested' and b.ends_at > now())`,
    }).from(amenities).innerJoin(properties, eq(properties.id, amenities.propertyId)).leftJoin(buildings, eq(buildings.id, amenities.buildingId))
      .where(and(eq(amenities.orgId, p.orgId), amenityVisibleWhere(p), opts.propertyId ? eq(amenities.propertyId, opts.propertyId) : undefined,
        opts.includeInactive && p.role.category === "staff" ? undefined : eq(amenities.active, true)))
      .orderBy(asc(properties.name), asc(amenities.name)),
  );
}

export async function getAmenity(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const a = await loadAmenity(tx, p.orgId, id);
    if (!canSeeAmenity(p, a)) throw new NotFoundError();
    const tz = await propertyTz(tx, a.propertyId);
    const [labels] = await tx.select({ propertyName: properties.name, buildingName: buildings.name }).from(properties)
      .leftJoin(buildings, eq(buildings.id, sql`${a.buildingId}`)).where(eq(properties.id, a.propertyId));
    const blackouts = await tx.select().from(amenityBlackouts).where(and(eq(amenityBlackouts.amenityId, id), gt(amenityBlackouts.endsAt, new Date()))).orderBy(asc(amenityBlackouts.startsAt)).limit(20);
    return { amenity: a, labels, tz, blackouts, rules: describeRules(toRules(a)), canManage: canManageAmenity(p, a), canManageBookings: canManageBookings(p, a), canBook: p.role.category === "resident" ? p.permissions.has("booking.create") : canManageBookings(p, a) };
  });
}

export const amenitySchema = z.object({
  name: z.string().trim().min(2, "Name the amenity.").max(80),
  kind: z.enum(AMENITY_KINDS),
  propertyId: z.string().uuid("Choose a property."),
  buildingId: optUuid,
  description: z.string().trim().max(2000).optional().transform(blankToNull),
  location: z.string().trim().max(120).optional().transform(blankToNull),
  rules: z.string().trim().max(4000).optional().transform(blankToNull),
  capacity: optInt(1, 10_000),
  maxConcurrent: z.coerce.number().int().min(1).max(500).default(1),
  opensAt: z.string().refine((v) => parseMinute(v) !== null, "Use HH:MM."),
  closesAt: z.string().refine((v) => parseMinute(v) !== null, "Use HH:MM."),
  slotMinutes: z.coerce.number().int().min(5).max(240).default(30),
  minDurationMinutes: z.coerce.number().int().min(5).max(1440).default(30),
  maxDurationMinutes: z.coerce.number().int().min(5).max(1440).default(240),
  minNoticeHours: z.coerce.number().int().min(0).max(24 * 30).default(0),
  maxAdvanceDays: z.coerce.number().int().min(1).max(365).default(60),
  limitCount: optInt(1, 100),
  limitPeriodDays: optInt(1, 365),
  cancellationHours: z.coerce.number().int().min(0).max(24 * 30).default(24),
  requiresApproval: checkbox,
  fee: dollars,
  deposit: dollars,
  eligibility: z.enum(["all", "owners", "owners_tenants"]).default("all"),
  active: checkbox,
}).superRefine((v, c) => {
  const o = parseMinute(v.opensAt), cl = parseMinute(v.closesAt);
  if (o !== null && cl !== null && cl <= o) c.addIssue({ code: "custom", message: "Closing must be after opening.", path: ["closesAt"] });
  if (v.maxDurationMinutes < v.minDurationMinutes) c.addIssue({ code: "custom", message: "Maximum can't be shorter than minimum.", path: ["maxDurationMinutes"] });
  if ((v.limitCount === null) !== (v.limitPeriodDays === null)) c.addIssue({ code: "custom", message: "Set both the limit and its period, or neither.", path: ["limitPeriodDays"] });
});
export type AmenityInput = z.infer<typeof amenitySchema>;

const ELIGIBILITY: Record<string, string[]> = { all: [], owners: ["owner"], owners_tenants: ["owner", "tenant"] };
export const eligibilityKey = (roles: string[]) => (roles.length === 1 && roles[0] === "owner" ? "owners" : roles.length === 2 ? "owners_tenants" : "all");

function amenityValues(input: AmenityInput) {
  return {
    name: input.name, kind: input.kind, propertyId: input.propertyId, buildingId: input.buildingId, description: input.description, location: input.location, rules: input.rules,
    capacity: input.capacity, maxConcurrent: input.maxConcurrent, opensAtMinute: parseMinute(input.opensAt)!, closesAtMinute: parseMinute(input.closesAt)!,
    slotMinutes: input.slotMinutes, minDurationMinutes: input.minDurationMinutes, maxDurationMinutes: input.maxDurationMinutes, minNoticeHours: input.minNoticeHours,
    maxAdvanceDays: input.maxAdvanceDays, limitCount: input.limitCount, limitPeriodDays: input.limitPeriodDays, cancellationHours: input.cancellationHours,
    requiresApproval: input.requiresApproval, feeCents: input.fee, depositCents: input.deposit, eligibleRoles: ELIGIBILITY[input.eligibility], active: input.active,
  };
}

async function checkPlacement(tx: Tx, p: Principal, input: AmenityInput) {
  authorize(p, "amenity.manage", { orgId: p.orgId, propertyId: input.propertyId, buildingId: input.buildingId });
  if (input.buildingId) {
    const [b] = await tx.select({ id: buildings.id }).from(buildings).where(and(eq(buildings.id, input.buildingId), eq(buildings.propertyId, input.propertyId), eq(buildings.orgId, p.orgId)));
    if (!b) throw new ValidationError("That building isn't part of the property.", "buildingId");
  }
}

export async function createAmenity(ctx: TenantCtx, input: AmenityInput) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    await checkPlacement(tx, p, input);
    const [a] = await tx.insert(amenities).values({ orgId: p.orgId, ...amenityValues(input) }).returning();
    await auditAs(tx, ctx, "amenity.created", "amenity", a.id, undefined, a);
    return a;
  });
}

export async function updateAmenity(ctx: TenantCtx, id: string, input: AmenityInput) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const before = await loadAmenity(tx, p.orgId, id);
    if (!canManageAmenity(p, before)) throw canSeeAmenity(p, before) ? new ForbiddenError() : new NotFoundError();
    await checkPlacement(tx, p, input);
    const [a] = await tx.update(amenities).set(amenityValues(input)).where(eq(amenities.id, id)).returning();
    await auditAs(tx, ctx, "amenity.updated", "amenity", id, before, a);
    return a;
  });
}

export const blackoutSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Choose a start."),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Choose an end."),
  reason: z.string().trim().min(3, "Say why it's closed.").max(200),
});

// closures; existing live bookings in the window are listed so staff can follow up
export async function addBlackout(ctx: TenantCtx, amenityId: string, input: z.infer<typeof blackoutSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const a = await loadAmenity(tx, p.orgId, amenityId);
    if (!canManageAmenity(p, a) && !canManageBookings(p, a)) throw new ForbiddenError();
    const tz = await propertyTz(tx, a.propertyId);
    const startsAt = zonedToUtc(input.from, tz), endsAt = zonedToUtc(input.to, tz);
    if (!(endsAt > startsAt)) throw new ValidationError("The end must be after the start.", "to");
    const [b] = await tx.insert(amenityBlackouts).values({ orgId: p.orgId, amenityId, startsAt, endsAt, reason: input.reason, createdByUserId: p.userId }).returning();
    const affected = await tx.select({ n: count() }).from(bookings).where(and(eq(bookings.amenityId, amenityId), inArray(bookings.status, [...LIVE]), lt(bookings.startsAt, endsAt), gt(bookings.endsAt, startsAt)));
    await auditAs(tx, ctx, "amenity.blackout_added", "amenity", amenityId, undefined, b);
    return { blackout: b, affected: affected[0].n };
  });
}

export async function deleteBlackout(ctx: TenantCtx, blackoutId: string) {
  const p = ctx.principal;
  await tenantTx(ctx, async (tx) => {
    const [b] = await tx.select().from(amenityBlackouts).where(and(eq(amenityBlackouts.id, blackoutId), eq(amenityBlackouts.orgId, p.orgId)));
    if (!b) throw new NotFoundError();
    const a = await loadAmenity(tx, p.orgId, b.amenityId);
    if (!canManageAmenity(p, a) && !canManageBookings(p, a)) throw new ForbiddenError();
    await tx.delete(amenityBlackouts).where(eq(amenityBlackouts.id, blackoutId));
    await auditAs(tx, ctx, "amenity.blackout_removed", "amenity", a.id, b);
  });
}

/* ───────────── availability ───────────── */

// a day's opening window and busy intervals; residents see "Booked", not who booked
export async function dayAvailability(ctx: TenantCtx, amenityId: string, date: string) {
  const p = ctx.principal;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ValidationError("Invalid date.");
  return tenantTx(ctx, async (tx) => {
    const a = await loadAmenity(tx, p.orgId, amenityId);
    if (!canSeeAmenity(p, a)) throw new NotFoundError();
    const tz = await propertyTz(tx, a.propertyId);
    const window = dayWindow(a, date, tz);
    const busy = await tx.select({ id: bookings.id, startsAt: bookings.startsAt, endsAt: bookings.endsAt, status: bookings.status, unitId: bookings.unitId, bookedBy: bookings.bookedByUserId, unitNumber: units.number })
      .from(bookings).leftJoin(units, eq(units.id, bookings.unitId))
      .where(and(eq(bookings.amenityId, amenityId), inArray(bookings.status, [...LIVE]), lt(bookings.startsAt, window.end), gt(bookings.endsAt, window.start)))
      .orderBy(asc(bookings.startsAt));
    const staff = canManageBookings(p, a);
    const blackouts = await tx.select().from(amenityBlackouts).where(and(eq(amenityBlackouts.amenityId, amenityId), lt(amenityBlackouts.startsAt, window.end), gt(amenityBlackouts.endsAt, window.start)));
    return {
      tz, window,
      busy: busy.map((b) => ({ start: b.startsAt, end: b.endsAt, status: b.status, mine: b.bookedBy === p.userId || (!!b.unitId && p.unitIds.has(b.unitId)), label: staff ? (b.unitNumber ? `Unit ${b.unitNumber}` : "Staff booking") : null, id: staff ? b.id : null })),
      blackouts: blackouts.map((b) => ({ start: b.startsAt, end: b.endsAt, reason: b.reason })),
    };
  });
}

/* ───────────── bookings ───────────── */

export const bookingSchema = z.object({
  amenityId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date."),
  start: z.string().refine((v) => parseMinute(v) !== null, "Choose a start time."),
  durationMinutes: z.coerce.number().int().min(5, "Choose how long.").max(1440),
  guests: z.coerce.number().int().min(1, "At least 1 person.").max(10_000).default(1),
  purpose: z.string().trim().max(300).optional().transform(blankToNull),
  unitId: optUuid,
  unitNumber: z.string().trim().max(20).optional().transform(blankToNull),
  buildingId: optUuid, // staff: disambiguates the unit number for property-wide amenities
});
export type BookingInput = z.infer<typeof bookingSchema>;

class BookingRulesError extends ValidationError {}

const isExclusionViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23P01" || err?.cause?.code === "23P01";
};

// the booking rules evaluated exactly as a real booking would be; shared by createBooking and previewBooking
async function evaluateBookingTx(tx: Tx, ctx: TenantCtx, input: BookingInput, lock: boolean) {
  const p = ctx.principal;
  // serialize bookings per amenity so capacity checks can't race (exclusive ones also have a DB constraint)
  const a = await loadAmenity(tx, p.orgId, input.amenityId, lock);
  if (!canSeeAmenity(p, a)) throw new NotFoundError();
  const staff = canManageBookings(p, a);
  let unitId: string | null = null;
  if (staff) {
    if (input.unitNumber) {
      const matches = await tx.select({ id: units.id, building: buildings.name }).from(units).innerJoin(buildings, eq(buildings.id, units.buildingId))
        .where(and(eq(units.orgId, p.orgId), eq(units.propertyId, a.propertyId), a.buildingId ? eq(units.buildingId, a.buildingId) : undefined,
          input.buildingId ? eq(units.buildingId, input.buildingId) : undefined, sql`lower(${units.number}) = lower(${input.unitNumber})`)).limit(5);
      if (!matches.length) throw new ValidationError(`No unit ${input.unitNumber} at this amenity's ${a.buildingId ? "building" : "property"}.`, "unitNumber");
      // never guess between towers that share unit numbers
      if (matches.length > 1) throw new ValidationError(`Unit ${input.unitNumber} exists in ${matches.map((m) => m.building).join(" and ")} — choose the building.`, "buildingId");
      unitId = matches[0].id;
    }
  } else {
    if (!p.permissions.has("booking.create")) throw new ForbiddenError("Your role can't book amenities. Ask the primary resident of your unit.");
    const mine = [...p.unitIds];
    unitId = input.unitId && p.unitIds.has(input.unitId) ? input.unitId : mine.length === 1 ? mine[0] : null;
    if (!unitId) throw new ValidationError("Choose which of your units this booking is for.", "unitId");
    const [u] = await tx.select({ propertyId: units.propertyId, buildingId: units.buildingId }).from(units).where(eq(units.id, unitId));
    if (!u || u.propertyId !== a.propertyId || (a.buildingId && a.buildingId !== u.buildingId)) throw new ForbiddenError("This amenity isn't available to your unit.");
  }
  const tz = await propertyTz(tx, a.propertyId);
  const start = zonedToUtc(`${input.date}T${input.start.padStart(5, "0")}`, tz);
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  if (Number.isNaN(start.getTime())) throw new ValidationError("Invalid start time.", "start");

  const overlapping = await tx.select({ start: bookings.startsAt, end: bookings.endsAt }).from(bookings)
    .where(and(eq(bookings.amenityId, a.id), inArray(bookings.status, [...LIVE]), lt(bookings.startsAt, end), gt(bookings.endsAt, start)));
  const blackouts = await tx.select({ start: amenityBlackouts.startsAt, end: amenityBlackouts.endsAt, reason: amenityBlackouts.reason }).from(amenityBlackouts)
    .where(and(eq(amenityBlackouts.amenityId, a.id), lt(amenityBlackouts.startsAt, end), gt(amenityBlackouts.endsAt, start)));
  let unitBookingsInPeriod = 0;
  if (unitId && a.limitPeriodDays) {
    const span = a.limitPeriodDays * 86_400_000;
    const [r] = await tx.select({ n: count() }).from(bookings).where(and(eq(bookings.amenityId, a.id), eq(bookings.unitId, unitId), inArray(bookings.status, [...LIVE]),
      gt(bookings.startsAt, new Date(start.getTime() - span)), lt(bookings.startsAt, new Date(start.getTime() + span))));
    unitBookingsInPeriod = r.n;
  }
  const decision = evaluateBooking(toRules(a), { start, end, guests: input.guests, roleKey: p.role.key, staff, now: new Date(), timeZone: tz }, { overlapping, blackouts, unitBookingsInPeriod });
  return { a, staff, unitId, tz, start, end, decision };
}

export async function createBooking(ctx: TenantCtx, input: BookingInput) {
  const p = ctx.principal;
  try {
    return await tenantTx(ctx, async (tx) => {
      const { a, staff, unitId, start, end, decision } = await evaluateBookingTx(tx, ctx, input, true);
      if (!decision.ok) throw new BookingRulesError(decision.problems.map((x) => x.message).join("\n"));

      const number = await nextNumber(tx, p.orgId, "booking");
      const [b] = await tx.insert(bookings).values({
        orgId: p.orgId, number, amenityId: a.id, propertyId: a.propertyId, buildingId: a.buildingId, unitId, residentId: staff ? null : p.residentId,
        bookedByUserId: p.userId, startsAt: start, endsAt: end, guests: input.guests, purpose: input.purpose, status: decision.status,
        exclusive: a.maxConcurrent === 1, feeCents: decision.feeCents, depositCents: decision.depositCents,
        feeStatus: decision.feeCents ? "due" : "none", depositStatus: decision.depositCents ? "due" : "none",
        decidedAt: decision.status === "approved" ? new Date() : null, decidedByUserId: decision.status === "approved" && staff ? p.userId : null,
      }).returning();
      await auditAs(tx, ctx, "booking.created", "booking", b.id, undefined, b);
      await emit(tx, ctx, "booking.created", { bookingId: b.id, status: b.status, byStaff: staff });
      return b;
    });
  } catch (e) {
    if (isExclusionViolation(e)) throw new ValidationError("Someone has just booked that time. Pick another slot.");
    throw e;
  }
}

// dry run: would this booking be accepted right now, and on what terms? (nothing is written)
export async function previewBooking(ctx: TenantCtx, input: BookingInput) {
  return tenantTx(ctx, async (tx) => {
    const { a, staff, start, end, tz, decision } = await evaluateBookingTx(tx, ctx, input, false);
    return { amenity: { id: a.id, name: a.name, propertyId: a.propertyId }, staff, start, end, tz, decision, rules: describeRules(toRules(a)) };
  });
}

function bookingVisibleWhere(p: Principal): SQL {
  if (p.role.category === "staff") {
    if (!p.permissions.has("booking.manage") && !p.permissions.has("amenity.read")) return sql`false`;
    return scopeCondition(p, { property: bookings.propertyId, building: bookings.buildingId }) ?? sql`true`;
  }
  const mine = [...p.unitIds];
  return or(eq(bookings.bookedByUserId, p.userId), mine.length ? inArray(bookings.unitId, mine) : undefined) ?? sql`false`;
}

export type BookingView = "upcoming" | "pending" | "past" | "cancelled" | "all";
export type BookingListRow = { id: string; number: number; amenityId: string; amenityName: string; propertyName: string; unitNumber: string | null; startsAt: Date; endsAt: Date; status: string; guests: number; bookedBy: string | null; feeCents: number; depositCents: number; feeStatus: string; depositStatus: string; tz: string };

export async function listBookings(ctx: TenantCtx, opts: { view?: BookingView; amenityId?: string; propertyId?: string; buildingId?: string; from?: Date; to?: Date; page?: number; pageSize?: number }): Promise<Page<BookingListRow>> {
  const p = ctx.principal;
  const { page, pageSize, offset } = pageArgs(opts.page, opts.pageSize);
  const now = new Date();
  const view = opts.view ?? "upcoming";
  const cond: Record<BookingView, SQL | undefined> = {
    upcoming: and(inArray(bookings.status, [...LIVE]), gt(bookings.endsAt, now)),
    pending: and(eq(bookings.status, "requested"), gt(bookings.endsAt, now)),
    past: and(eq(bookings.status, "approved"), lte(bookings.endsAt, now)),
    cancelled: inArray(bookings.status, ["cancelled", "declined"]),
    all: undefined,
  };
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(bookings.orgId, p.orgId), bookingVisibleWhere(p), cond[view], opts.amenityId ? eq(bookings.amenityId, opts.amenityId) : undefined, opts.propertyId ? eq(bookings.propertyId, opts.propertyId) : undefined,
      opts.buildingId ? eq(bookings.buildingId, opts.buildingId) : undefined, opts.to ? lt(bookings.startsAt, opts.to) : undefined, opts.from ? gt(bookings.endsAt, opts.from) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(bookings).where(where);
    const rows = await tx.select({
      id: bookings.id, number: bookings.number, amenityId: bookings.amenityId, amenityName: amenities.name, propertyName: properties.name, unitNumber: units.number,
      startsAt: bookings.startsAt, endsAt: bookings.endsAt, status: bookings.status, guests: bookings.guests, bookedBy: users.name, tz: properties.timezone,
      feeCents: bookings.feeCents, depositCents: bookings.depositCents, feeStatus: bookings.feeStatus, depositStatus: bookings.depositStatus,
    }).from(bookings).innerJoin(amenities, eq(amenities.id, bookings.amenityId)).innerJoin(properties, eq(properties.id, bookings.propertyId))
      .leftJoin(units, eq(units.id, bookings.unitId)).leftJoin(users, eq(users.id, bookings.bookedByUserId))
      .where(where).orderBy(view === "past" || view === "cancelled" || view === "all" ? desc(bookings.startsAt) : asc(bookings.startsAt)).limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

async function loadBooking(tx: Tx, orgId: string, id: string) {
  const [b] = await tx.select().from(bookings).where(and(eq(bookings.id, id), eq(bookings.orgId, orgId)));
  if (!b) throw new NotFoundError();
  return b;
}

function bookingAccess(p: Principal, b: BookingRow) {
  const manage = b.orgId === p.orgId && canManageBookings(p, b);
  const own = b.orgId === p.orgId && (b.bookedByUserId === p.userId || (!!b.unitId && p.unitIds.has(b.unitId)));
  const staffRead = b.orgId === p.orgId && p.role.category === "staff" && can(p, "amenity.read", res(b));
  return { manage, own, read: manage || own || staffRead };
}

export async function getBooking(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const b = await loadBooking(tx, p.orgId, id);
    const access = bookingAccess(p, b);
    if (!access.read) throw new NotFoundError();
    const a = await loadAmenity(tx, p.orgId, b.amenityId);
    const tz = await propertyTz(tx, a.propertyId);
    const [unit] = b.unitId ? await tx.select({ number: units.number }).from(units).where(eq(units.id, b.unitId)) : [];
    const [by] = b.bookedByUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, b.bookedByUserId)) : [];
    const [decider] = b.decidedByUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, b.decidedByUserId)) : [];
    const live = (LIVE as readonly string[]).includes(b.status) && b.endsAt > new Date();
    return {
      booking: b, amenity: a, tz, unitNumber: unit?.number ?? null, bookedByName: by?.name ?? null, decidedByName: decider?.name ?? null, access,
      canCancel: live && (access.manage || (access.own && b.startsAt > new Date() && canResidentCancel(b.startsAt, a.cancellationHours))),
      cancelCutoffPassed: live && access.own && !access.manage && !canResidentCancel(b.startsAt, a.cancellationHours),
      canDecide: access.manage && b.status === "requested" && b.endsAt > new Date(),
    };
  });
}

export const decisionSchema = z.object({
  decision: z.enum(["approve", "decline"]),
  note: z.string().trim().max(1000).optional().transform(blankToNull),
});

export async function decideBooking(ctx: TenantCtx, id: string, input: z.infer<typeof decisionSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const b = await loadBooking(tx, p.orgId, id);
    const access = bookingAccess(p, b);
    if (!access.manage) throw access.read ? new ForbiddenError() : new NotFoundError();
    if (b.status !== "requested") throw new ValidationError("Only pending requests can be approved or declined.");
    if (input.decision === "decline" && !input.note) throw new ValidationError("Tell the resident why it was declined.", "note");
    const status = input.decision === "approve" ? "approved" : "declined";
    const [after] = await tx.update(bookings).set({ status, decisionNote: input.note, decidedByUserId: p.userId, decidedAt: new Date() }).where(eq(bookings.id, id)).returning();
    await auditAs(tx, ctx, `booking.${status}`, "booking", id, { status: b.status }, { status, note: input.note });
    await emit(tx, ctx, "booking.decided", { bookingId: id, decision: status });
    return after;
  });
}

export const cancelSchema = z.object({ reason: z.string().trim().max(500).optional().transform(blankToNull) });

export async function cancelBooking(ctx: TenantCtx, id: string, input: z.infer<typeof cancelSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const b = await loadBooking(tx, p.orgId, id);
    const access = bookingAccess(p, b);
    if (!access.read) throw new NotFoundError();
    if (!(LIVE as readonly string[]).includes(b.status)) throw new ValidationError("This booking is already closed.");
    const a = await loadAmenity(tx, p.orgId, b.amenityId);
    if (!access.manage) {
      if (!access.own) throw new ForbiddenError();
      if (!canResidentCancel(b.startsAt, a.cancellationHours)) throw new ValidationError(`Bookings can be cancelled online up to ${a.cancellationHours} hours before the start. Please contact management.`);
    } else if (!input.reason && !access.own) throw new ValidationError("Give the resident a reason.", "reason");
    const [after] = await tx.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: input.reason }).where(eq(bookings.id, id)).returning();
    await auditAs(tx, ctx, "booking.cancelled", "booking", id, { status: b.status }, { status: "cancelled", reason: input.reason });
    await emit(tx, ctx, "booking.cancelled", { bookingId: id, byStaff: access.manage && b.bookedByUserId !== p.userId, wasStatus: b.status });
    return after;
  });
}

export const paymentSchema = z.object({
  feeStatus: z.enum(["none", "due", "paid", "waived"]),
  depositStatus: z.enum(["none", "due", "held", "refunded", "withheld"]),
});

// fees and deposits are recorded manually until a payment provider is connected (Iteration 10)
export async function updateBookingPayment(ctx: TenantCtx, id: string, input: z.infer<typeof paymentSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const b = await loadBooking(tx, p.orgId, id);
    const access = bookingAccess(p, b);
    if (!access.manage) throw access.read ? new ForbiddenError() : new NotFoundError();
    if (b.feeCents === 0 && input.feeStatus !== "none") throw new ValidationError("This booking has no fee.", "feeStatus");
    if (b.depositCents === 0 && input.depositStatus !== "none") throw new ValidationError("This booking has no deposit.", "depositStatus");
    const [after] = await tx.update(bookings).set(input).where(eq(bookings.id, id)).returning();
    await auditAs(tx, ctx, "booking.payment_updated", "booking", id, { feeStatus: b.feeStatus, depositStatus: b.depositStatus }, input);
    return after;
  });
}

export const damageSchema = z.object({
  notes: z.string().trim().min(5, "Describe the damage.").max(4000),
  createWorkOrder: checkbox,
  withholdDeposit: checkbox,
});

// records damage after an event; optionally opens a repair work order and withholds the deposit
export async function reportDamage(ctx: TenantCtx, id: string, input: z.infer<typeof damageSchema>) {
  const p = ctx.principal;
  const { b, a } = await tenantTx(ctx, async (tx) => {
    const b = await loadBooking(tx, p.orgId, id);
    const access = bookingAccess(p, b);
    if (!access.manage) throw access.read ? new ForbiddenError() : new NotFoundError();
    if (b.status !== "approved") throw new ValidationError("Damage can only be recorded on an approved booking.");
    return { b, a: await loadAmenity(tx, p.orgId, b.amenityId) };
  });
  let woId: string | null = b.damageWorkOrderId;
  if (input.createWorkOrder && !woId) {
    const wo = await createWorkOrder(ctx, {
      title: `Damage after booking #${b.number}: ${a.name}`.slice(0, 160), description: input.notes, category: "general", priority: "normal", isEmergency: false,
      unitId: null, buildingId: a.buildingId, unitNumber: null, propertyId: a.buildingId ? null : a.propertyId, area: a.location ?? a.name, permissionToEnter: false, entryNotes: null,
    }, { source: "staff", sourceType: "booking", sourceId: b.id });
    woId = wo.workOrder.id;
  }
  return tenantTx(ctx, async (tx) => {
    const [after] = await tx.update(bookings).set({
      damageNotes: input.notes, damageWorkOrderId: woId, ...(input.withholdDeposit && b.depositCents ? { depositStatus: "withheld" } : {}),
    }).where(eq(bookings.id, id)).returning();
    await auditAs(tx, ctx, "booking.damage_reported", "booking", id, undefined, { notes: input.notes, workOrderId: woId, depositStatus: after.depositStatus });
    return after;
  });
}

// staff calendar: bookings and closures in a date range for amenities in scope
export async function bookingCalendar(ctx: TenantCtx, opts: { from: string; days: number; amenityId?: string; propertyId?: string }) {
  const p = ctx.principal;
  if (!p.permissions.has("booking.manage") && !p.permissions.has("amenity.read")) throw new ForbiddenError();
  const tz = p.orgTimezone ?? "America/Vancouver";
  const start = zonedToUtc(`${opts.from}T00:00`, tz), end = zonedToUtc(`${nextDate(opts.from, opts.days)}T00:00`, tz);
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({
      id: bookings.id, number: bookings.number, startsAt: bookings.startsAt, endsAt: bookings.endsAt, status: bookings.status, amenityName: amenities.name, amenityId: amenities.id, unitNumber: units.number, guests: bookings.guests,
    }).from(bookings).innerJoin(amenities, eq(amenities.id, bookings.amenityId)).leftJoin(units, eq(units.id, bookings.unitId))
      .where(and(eq(bookings.orgId, p.orgId), bookingVisibleWhere(p), inArray(bookings.status, [...LIVE]), lt(bookings.startsAt, end), gt(bookings.endsAt, start),
        opts.amenityId ? eq(bookings.amenityId, opts.amenityId) : undefined, opts.propertyId ? eq(bookings.propertyId, opts.propertyId) : undefined))
      .orderBy(asc(bookings.startsAt));
    const closures = await tx.select({ id: amenityBlackouts.id, startsAt: amenityBlackouts.startsAt, endsAt: amenityBlackouts.endsAt, reason: amenityBlackouts.reason, amenityName: amenities.name })
      .from(amenityBlackouts).innerJoin(amenities, eq(amenities.id, amenityBlackouts.amenityId))
      .where(and(eq(amenityBlackouts.orgId, p.orgId), amenityVisibleWhere(p), lt(amenityBlackouts.startsAt, end), gt(amenityBlackouts.endsAt, start),
        opts.amenityId ? eq(amenityBlackouts.amenityId, opts.amenityId) : undefined, opts.propertyId ? eq(amenities.propertyId, opts.propertyId) : undefined));
    return { tz, start, end, bookings: rows, closures };
  });
}

export async function bookingStats(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.permissions.has("booking.manage")) return null;
  const tz = p.orgTimezone ?? "America/Vancouver";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const s = zonedToUtc(`${today}T00:00`, tz), e = zonedToUtc(`${nextDate(today)}T00:00`, tz);
  const [r] = await tenantTx(ctx, (tx) => tx.select({
    today: sql<number>`count(*) filter (where ${bookings.status} = 'approved' and ${bookings.startsAt} < ${e} and ${bookings.endsAt} > ${s})::int`,
    pending: sql<number>`count(*) filter (where ${bookings.status} = 'requested' and ${bookings.endsAt} > now())::int`,
  }).from(bookings).where(and(eq(bookings.orgId, p.orgId), bookingVisibleWhere(p))));
  return r;
}

