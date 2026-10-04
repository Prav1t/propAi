import "server-only";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { buildings, memberships, properties, roles, shiftHandoffs, shifts, users, SHIFT_POSITIONS } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { scopeCondition } from "../scope";
import { emit } from "../ops/core";
import { zonedToUtc } from "@/lib/time";
import { addDays } from "../assets/schedule";
import { clockInProblem, endAfterStart, isOnNow, validateShift } from "./rules";

export const canSeeShifts = (p: Principal) => p.permissions.has("shift.read") || p.permissions.has("shift.manage");
export const canScheduleShifts = (p: Principal) => p.permissions.has("shift.manage");

const optUuid = z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time.");
const checkbox = z.union([z.literal("on"), z.literal(""), z.boolean()]).optional().transform((v) => v === "on" || v === true);
const isExclusion = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23P01" || err?.cause?.code === "23P01";
};
// team schedules: building-scoped staff also see property-wide shifts at their building's property
const scoped = (p: Principal) => or(scopeCondition(p, { property: shifts.propertyId, building: shifts.buildingId }) ?? sql`true`,
  p.partialPropertyIds.size ? and(inArray(shifts.propertyId, [...p.partialPropertyIds]), isNull(shifts.buildingId)) : undefined)!;

// is this membership an active staff member whose role scope covers the property?
async function memberCovers(tx: Tx, orgId: string, membershipId: string, propertyId: string) {
  const [m] = await tx.select({ id: memberships.id, userId: memberships.userId, name: users.name, category: roles.category, scopeLevel: roles.scopeLevel }).from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId)).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.id, membershipId), eq(memberships.status, "active")));
  if (!m || m.category !== "staff") return null;
  if (m.scopeLevel === "org") return m;
  const r = await tx.execute(sql`select 1 from membership_scopes s where s.membership_id = ${membershipId} and (
    s.property_id = ${propertyId} or s.portfolio_id = (select portfolio_id from properties where id = ${propertyId})
    or s.building_id in (select id from buildings where property_id = ${propertyId})) limit 1`);
  return r.rows.length ? m : null;
}

/* ───────────── scheduling ───────────── */

export const shiftSchema = z.object({
  membershipId: z.string().uuid("Choose who's working."),
  propertyId: z.string().uuid("Choose the property."),
  buildingId: optUuid,
  position: z.enum(SHIFT_POSITIONS),
  startDate: dateStr,
  startTime: hhmm,
  endTime: hhmm,
  endDate: z.union([z.literal(""), dateStr]).optional().transform((v) => v || null),
  onCall: checkbox,
  notes: z.string().trim().max(300).optional().transform(blankToNull),
  repeatWeeks: z.coerce.number().int().min(0).max(12).default(0),
});

// one shift, optionally repeated weekly; all or nothing
export async function createShifts(ctx: TenantCtx, input: z.infer<typeof shiftSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [pr] = await tx.select({ id: properties.id, tz: properties.timezone }).from(properties).where(and(eq(properties.orgId, p.orgId), eq(properties.id, input.propertyId)));
    if (!pr) throw new ValidationError("Property not found.", "propertyId");
    if (input.buildingId) {
      const [b] = await tx.select({ propertyId: buildings.propertyId }).from(buildings).where(and(eq(buildings.orgId, p.orgId), eq(buildings.id, input.buildingId)));
      if (!b || b.propertyId !== pr.id) throw new ValidationError("That building isn't part of the property.", "buildingId");
    }
    authorize(p, "shift.manage", { orgId: p.orgId, propertyId: pr.id, buildingId: input.buildingId });
    const m = await memberCovers(tx, p.orgId, input.membershipId, pr.id);
    if (!m) throw new ValidationError("That person isn't an active staff member at this property.", "membershipId");
    const { endDate } = endAfterStart(input.startDate, input.startTime, input.endTime, input.endDate);
    const created: string[] = [];
    for (let w = 0; w <= input.repeatWeeks; w++) {
      const startsAt = zonedToUtc(`${addDays(input.startDate, w * 7)}T${input.startTime}`, pr.tz);
      const endsAt = zonedToUtc(`${addDays(endDate, w * 7)}T${input.endTime}`, pr.tz);
      const problem = validateShift({ startsAt, endsAt, onCall: input.onCall });
      if (problem) throw new ValidationError(problem, "endTime");
      try {
        const [row] = await tx.transaction((sp) => sp.insert(shifts).values({
          orgId: p.orgId, propertyId: pr.id, buildingId: input.buildingId, membershipId: m.id, position: input.position, startsAt, endsAt,
          onCall: input.onCall, notes: input.notes, createdByUserId: p.userId,
        }).returning({ id: shifts.id }));
        created.push(row.id);
      } catch (e) {
        if (isExclusion(e)) throw new ValidationError(`${m.name} already has a shift that overlaps ${addDays(input.startDate, w * 7)}.`, "startDate");
        throw e;
      }
    }
    await auditAs(tx, ctx, "shift.scheduled", "membership", m.id, undefined, { propertyId: pr.id, count: created.length, startDate: input.startDate, startTime: input.startTime, endTime: input.endTime, onCall: input.onCall });
    return { count: created.length, name: m.name };
  });
}

export async function cancelShift(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [s] = await tx.select().from(shifts).where(and(eq(shifts.id, id), eq(shifts.orgId, p.orgId)));
    if (!s) throw new NotFoundError();
    if (!can(p, "shift.manage", { orgId: p.orgId, propertyId: s.propertyId, buildingId: s.buildingId })) throw new NotFoundError();
    if (s.status !== "scheduled") throw new ValidationError("Already cancelled.");
    if (s.endsAt <= new Date()) throw new ValidationError("Past shifts can't be cancelled.");
    await tx.update(shifts).set({ status: "cancelled" }).where(eq(shifts.id, id));
    await auditAs(tx, ctx, "shift.cancelled", "shift", id, { status: "scheduled" }, { status: "cancelled" });
  });
}

/* ───────────── reading ───────────── */

export type ShiftRow = {
  id: string; membershipId: string; name: string; position: string; startsAt: Date; endsAt: Date; onCall: boolean; status: string; notes: string | null;
  propertyId: string; propertyName: string; buildingName: string | null; clockedInAt: Date | null; clockedOutAt: Date | null; tz: string;
};

const shiftCols = {
  id: shifts.id, membershipId: shifts.membershipId, name: users.name, position: shifts.position, startsAt: shifts.startsAt, endsAt: shifts.endsAt, onCall: shifts.onCall,
  status: shifts.status, notes: shifts.notes, propertyId: shifts.propertyId, propertyName: properties.name, buildingName: buildings.name,
  clockedInAt: shifts.clockedInAt, clockedOutAt: shifts.clockedOutAt, tz: properties.timezone,
};

// everyone's shifts overlapping [from, to) in scope; people with only shift.read still see the whole team's schedule at their properties
export async function listShifts(ctx: TenantCtx, opts: { from: Date; to: Date; propertyId?: string; includeCancelled?: boolean }): Promise<ShiftRow[]> {
  const p = ctx.principal;
  if (!canSeeShifts(p)) throw new ForbiddenError();
  return tenantTx(ctx, (tx) => tx.select(shiftCols).from(shifts)
    .innerJoin(memberships, eq(memberships.id, shifts.membershipId)).innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(properties, eq(properties.id, shifts.propertyId)).leftJoin(buildings, eq(buildings.id, shifts.buildingId))
    .where(and(eq(shifts.orgId, p.orgId), scoped(p), lt(shifts.startsAt, opts.to), gt(shifts.endsAt, opts.from),
      opts.includeCancelled ? undefined : eq(shifts.status, "scheduled"), opts.propertyId ? eq(shifts.propertyId, opts.propertyId) : undefined))
    .orderBy(asc(shifts.startsAt), asc(users.name)).limit(2000));
}

export async function onShiftNow(ctx: TenantCtx, opts: { propertyId?: string } = {}) {
  const now = new Date();
  return listShifts(ctx, { from: now, to: new Date(now.getTime() + 1000), propertyId: opts.propertyId });
}

export async function myShifts(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!canSeeShifts(p)) return [];
  const now = new Date();
  return tenantTx(ctx, (tx) => tx.select(shiftCols).from(shifts)
    .innerJoin(memberships, eq(memberships.id, shifts.membershipId)).innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(properties, eq(properties.id, shifts.propertyId)).leftJoin(buildings, eq(buildings.id, shifts.buildingId))
    .where(and(eq(shifts.orgId, p.orgId), eq(shifts.membershipId, p.membershipId), eq(shifts.status, "scheduled"), gt(shifts.endsAt, now), lt(shifts.startsAt, new Date(now.getTime() + 14 * 86_400_000))))
    .orderBy(asc(shifts.startsAt)).limit(30));
}

export async function clockIn(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [s] = await tx.select().from(shifts).where(and(eq(shifts.id, id), eq(shifts.orgId, p.orgId))).for("update");
    if (!s || s.membershipId !== p.membershipId) throw new NotFoundError();
    const problem = clockInProblem(s);
    if (problem) throw new ValidationError(problem);
    await tx.update(shifts).set({ clockedInAt: new Date() }).where(eq(shifts.id, id));
    await auditAs(tx, ctx, "shift.clocked_in", "shift", id);
  });
}

export async function clockOut(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [s] = await tx.select().from(shifts).where(and(eq(shifts.id, id), eq(shifts.orgId, p.orgId))).for("update");
    if (!s || s.membershipId !== p.membershipId) throw new NotFoundError();
    if (!s.clockedInAt) throw new ValidationError("You haven't clocked in.");
    if (s.clockedOutAt) throw new ValidationError("You've already clocked out.");
    await tx.update(shifts).set({ clockedOutAt: new Date() }).where(eq(shifts.id, id));
    await auditAs(tx, ctx, "shift.clocked_out", "shift", id);
  });
}

// staff who can be scheduled at properties the principal manages shifts for
export async function schedulableStaff(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!canScheduleShifts(p)) return [];
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({ membershipId: memberships.id, name: users.name, role: roles.name, title: memberships.title }).from(memberships)
      .innerJoin(roles, eq(roles.id, memberships.roleId)).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, p.orgId), eq(memberships.status, "active"), eq(roles.category, "staff"), isNull(memberships.vendorId)))
      .orderBy(asc(users.name));
    return rows;
  });
}

/* ───────────── on-call routing (used by maintenance) ───────────── */

// the person on call right now at a property who can work maintenance requests, if any
export async function onCallFor(tx: Tx, orgId: string, propertyId: string, buildingId: string | null) {
  const now = new Date();
  const [r] = await tx.select({ membershipId: shifts.membershipId, name: users.name }).from(shifts)
    .innerJoin(memberships, eq(memberships.id, shifts.membershipId)).innerJoin(roles, eq(roles.id, memberships.roleId)).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(shifts.orgId, orgId), eq(shifts.propertyId, propertyId), buildingId ? or(isNull(shifts.buildingId), eq(shifts.buildingId, buildingId)) : undefined,
      eq(shifts.status, "scheduled"), eq(shifts.onCall, true), lte(shifts.startsAt, now), gt(shifts.endsAt, now), eq(memberships.status, "active"),
      sql`${roles.permissions} && array['workorder.manage','workorder.read.assigned']::text[]`))
    .orderBy(asc(shifts.startsAt)).limit(1);
  return r ?? null;
}

/* ───────────── handoffs ───────────── */

export type Snapshot = {
  at: string;
  packages?: { waiting: number; perishable: number; overdue: number };
  visitors?: { onSite: { name: string; unit: string | null; overstay: boolean }[]; expectedNext4h: number };
  tasks?: { open: number; items: { title: string; dueAt: string | null }[] };
  incidents?: { last12h: { number: number; title: string; severity: string }[]; openSerious: number };
  emergencies?: { number: number; title: string; status: string }[];
  messagesNeedingReply?: number;
  bookingsRestOfToday?: number;
  parkingToReview?: number;
};

const rows = async <T,>(tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as T[];

// a factual picture of the property right now, limited to what the author may see
export async function buildSnapshot(tx: Tx, p: Principal, propertyId: string, buildingId: string | null): Promise<Snapshot> {
  const r = { orgId: p.orgId, propertyId, buildingId };
  const now = new Date();
  const bld = (col: string) => (buildingId ? sql`and (${sql.raw(col)} is null or ${sql.raw(col)} = ${buildingId})` : sql``);
  const snap: Snapshot = { at: now.toISOString() };
  if (can(p, "package.manage", r)) {
    const [k] = await rows<{ waiting: number; perishable: number; overdue: number }>(tx, sql`select count(*)::int as waiting, count(*) filter (where perishable)::int as perishable,
      count(*) filter (where received_at < now() - interval '7 days')::int as overdue from packages where org_id = ${p.orgId} and property_id = ${propertyId} and status = 'waiting' ${bld("building_id")}`);
    snap.packages = k;
  }
  if (can(p, "visitor.manage", r)) {
    const onSite = await rows<{ name: string; unit: string | null; until: Date }>(tx, sql`select v.name, u.number as unit, v.expected_until as until from visitors v left join units u on u.id = v.unit_id
      where v.org_id = ${p.orgId} and v.property_id = ${propertyId} and v.status = 'checked_in' ${bld("v.building_id")} order by v.checked_in_at limit 20`);
    const [e] = await rows<{ n: number }>(tx, sql`select count(*)::int as n from visitors where org_id = ${p.orgId} and property_id = ${propertyId} and status = 'expected'
      and expected_from <= now() + interval '4 hours' and expected_until > now() ${bld("building_id")}`);
    snap.visitors = { onSite: onSite.map((v) => ({ name: v.name, unit: v.unit, overstay: new Date(v.until) < now })), expectedNext4h: e.n };
  }
  if (can(p, "task.read", r) || can(p, "task.manage", r)) {
    const t = await rows<{ title: string; due_at: Date | null; total: number }>(tx, sql`select title, due_at, count(*) over ()::int as total from tasks
      where org_id = ${p.orgId} and property_id = ${propertyId} and status in ('open','in_progress','blocked') ${bld("building_id")} order by due_at nulls last, created_at limit 5`);
    snap.tasks = { open: t[0]?.total ?? 0, items: t.map((x) => ({ title: x.title, dueAt: x.due_at ? new Date(x.due_at).toISOString() : null })) };
  }
  if (can(p, "incident.read", r)) {
    const recent = await rows<{ number: number; title: string; severity: string }>(tx, sql`select number, title, severity from incidents where org_id = ${p.orgId} and property_id = ${propertyId}
      and created_at > now() - interval '12 hours' ${bld("building_id")} order by created_at desc limit 10`);
    const [s] = await rows<{ n: number }>(tx, sql`select count(*)::int as n from incidents where org_id = ${p.orgId} and property_id = ${propertyId}
      and status not in ('resolved','closed') and severity in ('high','critical') ${bld("building_id")}`);
    snap.incidents = { last12h: recent, openSerious: s.n };
  }
  if (can(p, "workorder.read", r) || can(p, "workorder.manage", r)) {
    snap.emergencies = await rows<{ number: number; title: string; status: string }>(tx, sql`select number, title, status from work_orders where org_id = ${p.orgId} and property_id = ${propertyId}
      and is_emergency and status in ('new','acknowledged','assigned','scheduled','in_progress','awaiting_vendor','awaiting_resident') ${bld("building_id")} order by created_at limit 10`);
  }
  if (can(p, "message.manage", r)) {
    const [m] = await rows<{ n: number }>(tx, sql`select count(*)::int as n from message_threads where org_id = ${p.orgId} and property_id = ${propertyId} and status = 'open' and not last_from_staff ${bld("building_id")}`);
    snap.messagesNeedingReply = m.n;
  }
  if (can(p, "booking.manage", r)) {
    const [b] = await rows<{ n: number }>(tx, sql`select count(*)::int as n from bookings where org_id = ${p.orgId} and property_id = ${propertyId} and status = 'approved'
      and starts_at >= now() and starts_at < now() + interval '12 hours'`);
    snap.bookingsRestOfToday = b.n;
  }
  if (can(p, "parking.manage", r)) {
    const [v] = await rows<{ n: number }>(tx, sql`select count(*)::int as n from parking_violations where org_id = ${p.orgId} and property_id = ${propertyId} and status = 'reported'`);
    snap.parkingToReview = v.n;
  }
  return snap;
}

export async function previewSnapshot(ctx: TenantCtx, propertyId: string, buildingId: string | null) {
  const p = ctx.principal;
  if (!can(p, "shift.read", { orgId: p.orgId, propertyId, buildingId })) throw new NotFoundError();
  return tenantTx(ctx, (tx) => buildSnapshot(tx, p, propertyId, buildingId));
}

export const handoffSchema = z.object({
  propertyId: z.string().uuid("Choose the property."),
  buildingId: optUuid,
  notes: z.string().trim().min(3, "Write what the next shift needs to know.").max(4000),
});

export async function createHandoff(ctx: TenantCtx, input: z.infer<typeof handoffSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    authorize(p, "shift.read", { orgId: p.orgId, propertyId: input.propertyId, buildingId: input.buildingId });
    const snapshot = await buildSnapshot(tx, p, input.propertyId, input.buildingId);
    const now = new Date();
    const [mine] = await tx.select({ id: shifts.id }).from(shifts).where(and(eq(shifts.orgId, p.orgId), eq(shifts.membershipId, p.membershipId), eq(shifts.propertyId, input.propertyId),
      eq(shifts.status, "scheduled"), lte(shifts.startsAt, new Date(now.getTime() + 3_600_000)), gt(shifts.endsAt, new Date(now.getTime() - 3_600_000)))).limit(1);
    const [h] = await tx.insert(shiftHandoffs).values({ orgId: p.orgId, propertyId: input.propertyId, buildingId: input.buildingId, shiftId: mine?.id ?? null, authorUserId: p.userId, notes: input.notes, snapshot }).returning();
    await auditAs(tx, ctx, "shift.handoff_written", "shift_handoff", h.id);
    await emit(tx, ctx, "shift.handoff_created", { handoffId: h.id });
    return h;
  });
}

export async function listHandoffs(ctx: TenantCtx, opts: { propertyId?: string; limit?: number } = {}) {
  const p = ctx.principal;
  if (!canSeeShifts(p)) throw new ForbiddenError();
  const ackUsers = sql`(select name from users where id = ${shiftHandoffs.acknowledgedByUserId})`;
  return tenantTx(ctx, (tx) => tx.select({
    id: shiftHandoffs.id, notes: shiftHandoffs.notes, snapshot: shiftHandoffs.snapshot, createdAt: shiftHandoffs.createdAt, authorUserId: shiftHandoffs.authorUserId,
    authorName: users.name, acknowledgedAt: shiftHandoffs.acknowledgedAt, acknowledgedByName: sql<string | null>`${ackUsers}`,
    propertyId: shiftHandoffs.propertyId, propertyName: properties.name, buildingName: buildings.name, tz: properties.timezone,
  }).from(shiftHandoffs).innerJoin(properties, eq(properties.id, shiftHandoffs.propertyId)).leftJoin(buildings, eq(buildings.id, shiftHandoffs.buildingId))
    .leftJoin(users, eq(users.id, shiftHandoffs.authorUserId))
    .where(and(eq(shiftHandoffs.orgId, p.orgId), or(scopeCondition(p, { property: shiftHandoffs.propertyId, building: shiftHandoffs.buildingId }) ?? sql`true`,
      p.partialPropertyIds.size ? and(inArray(shiftHandoffs.propertyId, [...p.partialPropertyIds]), isNull(shiftHandoffs.buildingId)) : undefined),
      opts.propertyId ? eq(shiftHandoffs.propertyId, opts.propertyId) : undefined))
    .orderBy(desc(shiftHandoffs.createdAt)).limit(Math.min(opts.limit ?? 20, 100)))
    .then((r) => r.map((x) => ({ ...x, snapshot: x.snapshot as Snapshot, mine: x.authorUserId === p.userId })));
}

export async function acknowledgeHandoff(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [h] = await tx.select().from(shiftHandoffs).where(and(eq(shiftHandoffs.id, id), eq(shiftHandoffs.orgId, p.orgId))).for("update");
    if (!h || !can(p, "shift.read", { orgId: p.orgId, propertyId: h.propertyId, buildingId: h.buildingId })) throw new NotFoundError();
    if (h.authorUserId === p.userId) throw new ValidationError("The next shift acknowledges a handoff, not its author.");
    if (h.acknowledgedAt) throw new ValidationError("Already acknowledged.");
    await tx.update(shiftHandoffs).set({ acknowledgedAt: new Date(), acknowledgedByUserId: p.userId }).where(eq(shiftHandoffs.id, id));
    await auditAs(tx, ctx, "shift.handoff_acknowledged", "shift_handoff", id);
  });
}

// people who should read a new handoff: on shift now or starting soon at that property, other than the author
export async function handoffRecipients(tx: Tx, orgId: string, propertyId: string, authorUserId: string | null): Promise<string[]> {
  const now = new Date();
  const r = await tx.selectDistinct({ userId: memberships.userId }).from(shifts).innerJoin(memberships, eq(memberships.id, shifts.membershipId))
    .where(and(eq(shifts.orgId, orgId), eq(shifts.propertyId, propertyId), eq(shifts.status, "scheduled"), eq(memberships.status, "active"),
      lte(shifts.startsAt, new Date(now.getTime() + 3 * 3_600_000)), gt(shifts.endsAt, now), authorUserId ? ne(memberships.userId, authorUserId) : undefined));
  return r.map((x) => x.userId);
}

// properties (and buildings) where the principal can see shifts, for pickers
export async function shiftPlaces(ctx: TenantCtx) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const r = await tx.select({ id: buildings.id, name: buildings.name, propertyId: properties.id, propertyName: properties.name, tz: properties.timezone }).from(buildings)
      .innerJoin(properties, eq(properties.id, buildings.propertyId))
      .where(and(eq(buildings.orgId, p.orgId), scopeCondition(p, { property: buildings.propertyId, building: buildings.id }) ?? sql`true`))
      .orderBy(asc(properties.name), asc(buildings.name));
    const props = [...new Map(r.map((b) => [b.propertyId, { id: b.propertyId, name: b.propertyName, tz: b.tz }])).values()];
    return { buildings: r, properties: props };
  });
}

export const isCurrent = (s: { startsAt: Date; endsAt: Date; status: string }) => isOnNow({ ...s, onCall: false });
