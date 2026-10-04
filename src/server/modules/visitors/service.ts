import "server-only";
import { and, asc, count, desc, eq, gt, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { buildings, organizations, parkingPermits, parkingSpaces, properties, units, users, visitors, workOrders, VISITOR_KINDS } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import { setTxOrg, withContext } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { emit } from "../ops/core";
import { unitOccupants } from "../community/residents";
import { zonedToUtc } from "@/lib/time";
import { normalizePlate, isPlausiblePlate } from "../parking/plate";
import { endVisitorPermitsTx, findUnitInBuilding, freeVisitorSpaces, issueVisitorPermitTx } from "../parking/service";
import { hashPass, isOverstay, looksLikePassToken, newPass, passState, tokenFromScan } from "./pass";

type VisitorRow = typeof visitors.$inferSelect;

export const RESIDENT_MAX_DAYS = 14;
export const STAFF_MAX_DAYS = 90;

export const canManageVisitors = (p: Principal) => p.permissions.has("visitor.manage");
export const canInviteVisitors = (p: Principal) => p.permissions.has("visitor.invite") && p.unitIds.size > 0;
export const canUseVisitors = (p: Principal) => canManageVisitors(p) || canInviteVisitors(p);

const res = (v: Pick<VisitorRow, "orgId" | "propertyId" | "buildingId">) => ({ orgId: v.orgId, propertyId: v.propertyId, buildingId: v.buildingId });

function access(p: Principal, v: VisitorRow) {
  const manage = v.orgId === p.orgId && can(p, "visitor.manage", res(v));
  const own = v.orgId === p.orgId && p.permissions.has("visitor.invite") && !!v.unitId && p.unitIds.has(v.unitId);
  return { manage, own, read: manage || own };
}

function visibleWhere(p: Principal): SQL {
  if (canManageVisitors(p)) return scopeCondition(p, { property: visitors.propertyId, building: visitors.buildingId }) ?? sql`true`;
  if (canInviteVisitors(p)) return inArray(visitors.unitId, [...p.unitIds]);
  return sql`false`;
}

const optUuid = z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null);
const opt = (max: number) => z.string().trim().max(max).optional().transform(blankToNull);
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time.");
const checkbox = z.union([z.literal("on"), z.literal(""), z.boolean()]).optional().transform((v) => v === "on" || v === true);

export const visitorSchema = z.object({
  name: z.string().trim().min(2, "Enter the visitor's name.").max(120),
  company: opt(120),
  phone: opt(40),
  kind: z.enum(VISITOR_KINDS).default("guest"),
  purpose: opt(300),
  date: dateStr,
  from: hhmm,
  until: hhmm,
  throughDate: z.union([z.literal(""), dateStr]).optional().transform((v) => v || null),
  plate: z.string().optional().transform((v) => normalizePlate(v) || null).refine((v) => !v || isPlausiblePlate(v), "Enter a licence plate (2–8 letters and digits)."),
  needsParking: checkbox,
  unitId: optUuid, // residents with more than one home
  buildingId: optUuid, // staff
  unitNumber: opt(20), // staff
  workOrderNumber: z.union([z.literal(""), z.coerce.number().int().positive()]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
  arrivingNow: checkbox, // staff walk-in: checked in immediately
});
export type VisitorInput = z.infer<typeof visitorSchema>;

export type RegisterResult = { visitor: VisitorRow; passToken: string | null };

// pre-registers a guest (resident or desk) or records a walk-in; returns the pass secret once
export async function registerVisitor(ctx: TenantCtx, input: VisitorInput): Promise<RegisterResult> {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const staff = canManageVisitors(p) && !!input.buildingId;
    let place: { propertyId: string; buildingId: string; unitId: string | null };
    let hostResidentId: string | null = null;
    if (staff) {
      const [b] = await tx.select().from(buildings).where(and(eq(buildings.orgId, p.orgId), eq(buildings.id, input.buildingId!)));
      if (!b) throw new ValidationError("Building not found.", "buildingId");
      authorize(p, "visitor.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId: b.id });
      let unitId: string | null = null;
      if (input.unitNumber) {
        const u = await findUnitInBuilding(tx, p.orgId, b.id, input.unitNumber);
        if (!u) throw new ValidationError(`No unit ${input.unitNumber} in ${b.name}.`, "unitNumber");
        unitId = u.id;
        hostResidentId = (await unitOccupants(tx, p.orgId, u.id))[0]?.residentId ?? null;
      } else if (input.kind === "guest") throw new ValidationError("Which unit is the guest visiting?", "unitNumber");
      place = { propertyId: b.propertyId, buildingId: b.id, unitId };
    } else if (canInviteVisitors(p)) {
      if (input.arrivingNow || input.workOrderNumber) throw new ForbiddenError();
      const unitId = input.unitId ?? (p.unitIds.size === 1 ? [...p.unitIds][0] : null);
      if (!unitId) throw new ValidationError("Choose which home they're visiting.", "unitId");
      if (!p.unitIds.has(unitId)) throw new ForbiddenError("You can only invite guests to your own home.");
      const [u] = await tx.select({ propertyId: units.propertyId, buildingId: units.buildingId }).from(units).where(and(eq(units.orgId, p.orgId), eq(units.id, unitId)));
      if (!u) throw new NotFoundError();
      place = { propertyId: u.propertyId, buildingId: u.buildingId, unitId };
      hostResidentId = p.residentId;
    } else if (canManageVisitors(p)) {
      throw new ValidationError("Choose the building.", "buildingId");
    } else throw new ForbiddenError();

    const [pr] = await tx.select({ tz: properties.timezone }).from(properties).where(eq(properties.id, place.propertyId));
    const now = new Date();
    let from = zonedToUtc(`${input.date}T${input.from}`, pr.tz);
    const until = zonedToUtc(`${input.throughDate ?? input.date}T${input.until}`, pr.tz);
    if (input.arrivingNow && from > now) from = now;
    if (until <= from) throw new ValidationError("The visit must end after it starts.", "until");
    if (until <= now) throw new ValidationError("That time has already passed.", "until");
    const maxDays = staff ? STAFF_MAX_DAYS : RESIDENT_MAX_DAYS;
    if (until.getTime() - from.getTime() > maxDays * 86_400_000) throw new ValidationError(`A pass can cover at most ${maxDays} days.`, "throughDate");
    if (!staff && from.getTime() > now.getTime() + 180 * 86_400_000) throw new ValidationError("Invite guests up to six months ahead.", "date");
    if (input.needsParking && !input.plate) throw new ValidationError("Add the licence plate so the desk can assign visitor parking.", "plate");

    let workOrderId: string | null = null;
    if (input.workOrderNumber) {
      const [wo] = await tx.select({ id: workOrders.id, propertyId: workOrders.propertyId }).from(workOrders).where(and(eq(workOrders.orgId, p.orgId), eq(workOrders.number, input.workOrderNumber)));
      if (!wo || wo.propertyId !== place.propertyId) throw new ValidationError(`No work order #${input.workOrderNumber} at this property.`, "workOrderNumber");
      workOrderId = wo.id;
    }

    const pass = input.arrivingNow ? null : newPass();
    const [v] = await tx.insert(visitors).values({
      orgId: p.orgId, ...place, hostResidentId, invitedByUserId: staff ? null : p.userId, name: input.name, company: input.company, phone: input.phone,
      kind: workOrderId && input.kind === "guest" ? "contractor" : input.kind, purpose: input.purpose, expectedFrom: from, expectedUntil: until,
      status: input.arrivingNow ? "checked_in" : "expected", passTokenHash: pass?.hash ?? null, plate: input.plate, needsParking: input.needsParking, workOrderId,
      checkedInAt: input.arrivingNow ? now : null, checkedInByUserId: input.arrivingNow ? p.userId : null, createdByUserId: p.userId,
    }).returning();
    await auditAs(tx, ctx, input.arrivingNow ? "visitor.walk_in" : "visitor.registered", "visitor", v.id, undefined, { name: v.name, kind: v.kind, unitId: v.unitId, from, until });
    if (input.arrivingNow) await emit(tx, ctx, "visitor.checked_in", { visitorId: v.id });
    return { visitor: v, passToken: pass?.token ?? null };
  });
}

/* ───────────── lists ───────────── */

export type VisitorView = "today" | "on_site" | "upcoming" | "past" | "all";
export type VisitorListRow = {
  id: string; name: string; company: string | null; kind: string; status: string; expectedFrom: Date; expectedUntil: Date; checkedInAt: Date | null; checkedOutAt: Date | null;
  unitNumber: string | null; buildingName: string; propertyName: string; plate: string | null; needsParking: boolean; tz: string; hasPass: boolean; overstay: boolean;
};

// "today" = expected guests whose window is open now or later today (org time zone), plus nothing already finished
export async function listVisitors(ctx: TenantCtx, opts: { view?: VisitorView; q?: string; buildingId?: string; page?: number; pageSize?: number }): Promise<Page<VisitorListRow>> {
  const p = ctx.principal;
  if (!canUseVisitors(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page, opts.pageSize ?? 50);
  const now = new Date();
  const tz = p.orgTimezone ?? "America/Vancouver";
  const endOfToday = zonedToUtc(`${new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now)}T23:59`, tz);
  const view = opts.view ?? "today";
  const cond: Record<VisitorView, SQL | undefined> = {
    today: and(eq(visitors.status, "expected"), lte(visitors.expectedFrom, endOfToday), gt(visitors.expectedUntil, now)),
    on_site: eq(visitors.status, "checked_in"),
    upcoming: and(eq(visitors.status, "expected"), gt(visitors.expectedFrom, endOfToday)),
    past: or(inArray(visitors.status, ["checked_out", "cancelled", "denied"]), and(eq(visitors.status, "expected"), lte(visitors.expectedUntil, now))),
    all: undefined,
  };
  const q = opts.q?.trim();
  const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(visitors.orgId, p.orgId), visibleWhere(p), cond[view], opts.buildingId ? eq(visitors.buildingId, opts.buildingId) : undefined,
      like ? or(ilike(visitors.name, like), ilike(visitors.company, like), sql`lower(${units.number}) = lower(${q})`, normalizePlate(q) ? eq(visitors.plate, normalizePlate(q)) : undefined) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(visitors).leftJoin(units, eq(units.id, visitors.unitId)).where(where);
    const rows = await tx.select({
      id: visitors.id, name: visitors.name, company: visitors.company, kind: visitors.kind, status: visitors.status, expectedFrom: visitors.expectedFrom, expectedUntil: visitors.expectedUntil,
      checkedInAt: visitors.checkedInAt, checkedOutAt: visitors.checkedOutAt, unitNumber: units.number, buildingName: buildings.name, propertyName: properties.name,
      plate: visitors.plate, needsParking: visitors.needsParking, tz: properties.timezone, hasPass: sql<boolean>`${visitors.passTokenHash} is not null`,
    }).from(visitors).innerJoin(buildings, eq(buildings.id, visitors.buildingId)).innerJoin(properties, eq(properties.id, visitors.propertyId)).leftJoin(units, eq(units.id, visitors.unitId))
      .where(where).orderBy(view === "past" || view === "all" ? desc(visitors.expectedFrom) : view === "on_site" ? asc(visitors.checkedInAt) : asc(visitors.expectedFrom))
      .limit(pageSize).offset(offset);
    return toPage(rows.map((r) => ({ ...r, overstay: isOverstay(r, now) })), n, page, pageSize);
  });
}

export async function visitorStats(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!canManageVisitors(p)) return null;
  const now = new Date();
  const tz = p.orgTimezone ?? "America/Vancouver";
  const endOfToday = zonedToUtc(`${new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now)}T23:59`, tz);
  const [r] = await tenantTx(ctx, (tx) => tx.select({
    expectedToday: sql<number>`count(*) filter (where ${visitors.status} = 'expected' and ${visitors.expectedFrom} <= ${endOfToday} and ${visitors.expectedUntil} > ${now})::int`,
    onSite: sql<number>`count(*) filter (where ${visitors.status} = 'checked_in')::int`,
    overstay: sql<number>`count(*) filter (where ${visitors.status} = 'checked_in' and ${visitors.expectedUntil} < ${now})::int`,
    nextHours: sql<number>`count(*) filter (where ${visitors.status} = 'expected' and ${visitors.expectedFrom} <= ${new Date(now.getTime() + 4 * 3_600_000)} and ${visitors.expectedUntil} > ${now})::int`,
  }).from(visitors).where(and(eq(visitors.orgId, p.orgId), visibleWhere(p))));
  return r;
}

/* ───────────── detail ───────────── */

export async function getVisitor(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(visitors).where(and(eq(visitors.id, id), eq(visitors.orgId, p.orgId)));
    if (!v) throw new NotFoundError();
    const a = access(p, v);
    if (!a.read) throw new NotFoundError();
    const [labels] = await tx.select({ buildingName: buildings.name, propertyName: properties.name, tz: properties.timezone }).from(buildings)
      .innerJoin(properties, eq(properties.id, buildings.propertyId)).where(eq(buildings.id, v.buildingId));
    const [unit] = v.unitId ? await tx.select({ number: units.number }).from(units).where(eq(units.id, v.unitId)) : [];
    const name = async (uid: string | null) => (uid ? (await tx.select({ name: users.name }).from(users).where(eq(users.id, uid)))[0]?.name ?? null : null);
    const permits = await tx.select({ id: parkingPermits.id, number: parkingPermits.number, plate: parkingPermits.plate, validFrom: parkingPermits.validFrom, validUntil: parkingPermits.validUntil, spaceCode: parkingSpaces.code })
      .from(parkingPermits).leftJoin(parkingSpaces, eq(parkingSpaces.id, parkingPermits.spaceId)).where(eq(parkingPermits.visitorId, v.id)).orderBy(desc(parkingPermits.validFrom));
    const [wo] = v.workOrderId && a.manage ? await tx.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, status: workOrders.status }).from(workOrders).where(eq(workOrders.id, v.workOrderId)) : [];
    const freeSpaces = a.manage && v.status === "expected" ? await freeVisitorSpaces(tx, p.orgId, v.propertyId, v.expectedUntil) : [];
    const state = passState(v);
    return {
      visitor: { ...v, passTokenHash: undefined, hasPass: !!v.passTokenHash }, access: a, labels, unitNumber: unit?.number ?? null, state, overstay: isOverstay(v),
      checkedInByName: await name(v.checkedInByUserId), checkedOutByName: await name(v.checkedOutByUserId), invitedByName: await name(v.invitedByUserId),
      permits, workOrder: wo ?? null, freeSpaces,
      canCheckIn: a.manage && v.status === "expected", canCheckOut: a.manage && v.status === "checked_in",
      canCancel: v.status === "expected" && (a.manage || a.own), canRegenerate: v.status === "expected" && (a.manage || a.own) && state !== "expired",
    };
  });
}

/* ───────────── front desk actions ───────────── */

export const checkInSchema = z.object({
  spaceId: optUuid,
  plate: z.string().optional().transform((v) => normalizePlate(v) || null).refine((v) => !v || isPlausiblePlate(v), "Enter a licence plate."),
  override: checkbox,
  note: opt(300),
});

export async function checkInVisitor(ctx: TenantCtx, id: string, input: z.infer<typeof checkInSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(visitors).where(and(eq(visitors.id, id), eq(visitors.orgId, p.orgId))).for("update");
    if (!v || !access(p, v).manage) throw new NotFoundError();
    if (v.status !== "expected") throw new ValidationError(v.status === "checked_in" ? "Already checked in." : "This visit is closed.");
    const state = passState(v);
    // outside the window the desk can still let someone in, but has to say why
    if (state !== "valid" && !(input.override && input.note)) {
      throw new ValidationError(state === "upcoming" ? "This pass isn't valid yet. Tick “Check in anyway” and add a note to override." : "This pass has expired. Tick “Check in anyway” and add a note to override.", "override");
    }
    const plate = input.plate ?? v.plate;
    const now = new Date();
    const [row] = await tx.update(visitors).set({ status: "checked_in", checkedInAt: now, checkedInByUserId: p.userId, plate }).where(eq(visitors.id, id)).returning();
    let parking: { spaceCode: string } | null = null;
    if (input.spaceId) parking = await issueVisitorPermitTx(tx, ctx, { ...row }, input.spaceId);
    await auditAs(tx, ctx, "visitor.checked_in", "visitor", id, { status: v.status }, { status: "checked_in", override: state !== "valid" ? input.note : undefined, parking: parking?.spaceCode });
    await emit(tx, ctx, "visitor.checked_in", { visitorId: id });
    return { visitor: row, parking };
  });
}

export async function checkOutVisitor(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(visitors).where(and(eq(visitors.id, id), eq(visitors.orgId, p.orgId))).for("update");
    if (!v || !access(p, v).manage) throw new NotFoundError();
    if (v.status !== "checked_in") throw new ValidationError("This visitor isn't checked in.");
    // a used pass can't be reused
    await tx.update(visitors).set({ status: "checked_out", checkedOutAt: new Date(), checkedOutByUserId: p.userId, passTokenHash: null }).where(eq(visitors.id, id));
    await endVisitorPermitsTx(tx, id);
    await auditAs(tx, ctx, "visitor.checked_out", "visitor", id, { status: v.status }, { status: "checked_out" });
  });
}

export const denySchema = z.object({ reason: z.string().trim().min(3, "Say why they weren't let in.").max(300) });

export async function denyVisitor(ctx: TenantCtx, id: string, input: z.infer<typeof denySchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(visitors).where(and(eq(visitors.id, id), eq(visitors.orgId, p.orgId))).for("update");
    if (!v || !access(p, v).manage) throw new NotFoundError();
    if (v.status !== "expected") throw new ValidationError("Only expected visitors can be turned away.");
    await tx.update(visitors).set({ status: "denied", deniedReason: input.reason, passTokenHash: null }).where(eq(visitors.id, id));
    await auditAs(tx, ctx, "visitor.denied", "visitor", id, { status: v.status }, { status: "denied", reason: input.reason });
    await emit(tx, ctx, "visitor.denied", { visitorId: id });
  });
}

export async function cancelVisitor(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(visitors).where(and(eq(visitors.id, id), eq(visitors.orgId, p.orgId))).for("update");
    if (!v) throw new NotFoundError();
    const a = access(p, v);
    if (!a.read) throw new NotFoundError();
    if (!a.manage && !a.own) throw new ForbiddenError();
    if (v.status !== "expected") throw new ValidationError("Only upcoming visits can be cancelled.");
    await tx.update(visitors).set({ status: "cancelled", cancelledAt: new Date(), passTokenHash: null }).where(eq(visitors.id, id));
    await auditAs(tx, ctx, "visitor.cancelled", "visitor", id, { status: v.status }, { status: "cancelled" });
  });
}

// issues a new pass link; the old one stops working
export async function regeneratePass(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(visitors).where(and(eq(visitors.id, id), eq(visitors.orgId, p.orgId))).for("update");
    if (!v) throw new NotFoundError();
    const a = access(p, v);
    if (!a.read) throw new NotFoundError();
    if (!a.manage && !a.own) throw new ForbiddenError();
    if (v.status !== "expected" || passState(v) === "expired") throw new ValidationError("Passes can only be reissued for upcoming visits.");
    const pass = newPass();
    await tx.update(visitors).set({ passTokenHash: pass.hash }).where(eq(visitors.id, id));
    await auditAs(tx, ctx, "visitor.pass_reissued", "visitor", id);
    return { visitorId: id, passToken: pass.token };
  });
}

// front desk scan: a pass QR (or pasted link) → the visit in this desk's scope
export async function resolvePass(ctx: TenantCtx, scanned: string) {
  const p = ctx.principal;
  if (!canManageVisitors(p)) throw new ForbiddenError();
  const token = tokenFromScan(scanned);
  if (!token) throw new ValidationError("That isn't a guest pass. Search by name or unit instead.", "code");
  return tenantTx(ctx, async (tx) => {
    const [v] = await tx.select().from(visitors).where(and(eq(visitors.orgId, p.orgId), eq(visitors.passTokenHash, hashPass(token))));
    if (!v || !access(p, v).manage) throw new ValidationError("No valid pass found for this building. It may have been cancelled, used or replaced.", "code");
    return v.id;
  });
}

/* ───────────── public pass page ───────────── */

export type PublicPass = {
  guestName: string; kind: string; buildingName: string; propertyName: string; address: string; orgName: string; tz: string;
  expectedFrom: Date; expectedUntil: Date; state: ReturnType<typeof passState>;
};

// what the guest's phone shows: no host name, no unit number, nothing beyond what the desk needs
export async function publicPass(token: string): Promise<PublicPass | null> {
  if (!looksLikePassToken(token)) return null;
  return withContext({ passTokenHash: hashPass(token) }, async (tx) => {
    const [v] = await tx.select().from(visitors).where(eq(visitors.passTokenHash, hashPass(token)));
    if (!v) return null;
    // the token proved access to this one visit; read its building's public details
    await setTxOrg(tx, v.orgId);
    const [loc] = await tx.select({ buildingName: buildings.name, propertyName: properties.name, address: properties.addressLine1, city: properties.city, tz: properties.timezone })
      .from(buildings).innerJoin(properties, eq(properties.id, buildings.propertyId)).where(eq(buildings.id, v.buildingId));
    const [org] = await tx.select({ name: organizations.name, status: organizations.status }).from(organizations).where(eq(organizations.id, v.orgId));
    if (!loc || !org || org.status !== "active") return null;
    const first = v.name.trim().split(/\s+/);
    return {
      guestName: first.length > 1 ? `${first[0]} ${first.at(-1)![0]}.` : first[0], kind: v.kind, buildingName: loc.buildingName, propertyName: loc.propertyName,
      address: [loc.address, loc.city].filter(Boolean).join(", "), orgName: org.name, tz: loc.tz, expectedFrom: v.expectedFrom, expectedUntil: v.expectedUntil, state: passState(v),
    };
  });
}

/* ───────────── form options ───────────── */

export async function visitorFormOptions(ctx: TenantCtx) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    if (canManageVisitors(p)) {
      const rows = await tx.select({ id: buildings.id, name: buildings.name, propertyId: properties.id, propertyName: properties.name, tz: properties.timezone }).from(buildings)
        .innerJoin(properties, eq(properties.id, buildings.propertyId))
        .where(and(eq(buildings.orgId, p.orgId), scopeCondition(p, { property: buildings.propertyId, building: buildings.id }) ?? sql`true`))
        .orderBy(asc(properties.name), asc(buildings.name));
      return { buildings: rows.filter((b) => can(p, "visitor.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId: b.id })), homes: [] as { id: string; label: string; tz: string }[] };
    }
    if (!canInviteVisitors(p)) return { buildings: [], homes: [] };
    const homes = await tx.select({ id: units.id, number: units.number, building: buildings.name, property: properties.name, tz: properties.timezone }).from(units)
      .innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, units.propertyId))
      .where(and(eq(units.orgId, p.orgId), inArray(units.id, [...p.unitIds]))).orderBy(asc(units.number));
    return { buildings: [], homes: homes.map((h) => ({ id: h.id, label: `Unit ${h.number} · ${h.building}, ${h.property}`, tz: h.tz })) };
  });
}

// recent visits for a resident's home screen
export async function myUpcomingGuests(ctx: TenantCtx, limit = 4) {
  const p = ctx.principal;
  if (!canInviteVisitors(p)) return [];
  const now = new Date();
  return tenantTx(ctx, (tx) => tx.select({ id: visitors.id, name: visitors.name, status: visitors.status, expectedFrom: visitors.expectedFrom, expectedUntil: visitors.expectedUntil, tz: properties.timezone })
    .from(visitors).innerJoin(properties, eq(properties.id, visitors.propertyId))
    .where(and(eq(visitors.orgId, p.orgId), inArray(visitors.unitId, [...p.unitIds]), or(and(eq(visitors.status, "expected"), gt(visitors.expectedUntil, now)), eq(visitors.status, "checked_in"))))
    .orderBy(asc(visitors.expectedFrom)).limit(limit));
}
