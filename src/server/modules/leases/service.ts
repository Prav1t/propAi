import "server-only";
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { buildings, leases, organizations, properties, rentCharges, residents, unitOccupancies, units } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import { withContext, type Tx } from "../../db/client";
import { auditAs, blankToNull, ConflictError, friendlyUnique, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { addDays, chargePeriods, dueDate, todayIn } from "@/lib/leasing";

// Leases and rent tracking for rental buildings. A lease names one tenant and one unit; each month it is in force
// gets a rent charge, and staff record what was received. No money moves through the product: payments are recorded,
// not collected. Whole months only (no pro-rating), stated on the page.

type LeaseRow = typeof leases.$inferSelect;
export const canSeeLeases = (p: Principal) => p.permissions.has("lease.read") || p.permissions.has("lease.manage");
const res = (l: { orgId: string; propertyId: string }) => ({ orgId: l.orgId, propertyId: l.propertyId });
const tzOf = (p: Principal) => p.orgTimezone ?? "UTC";
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.").refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Choose a valid date.");
const dollars = (label: string, min: number) => z.string().trim().min(1, `Enter the ${label}.`).regex(/^\d{1,7}(\.\d{1,2})?$/, "Use a number like 1850 or 1850.50.").transform((v) => Math.round(Number(v) * 100)).refine((c) => c >= min, min ? `The ${label} must be more than zero.` : "Can't be negative.");

const scoped = (p: Principal): SQL | undefined => scopeCondition(p, { property: leases.propertyId });

// rent charges for every month a lease has been in force so far; safe to call any number of times
async function ensureCharges(tx: Tx, orgId: string, today: string, leaseId?: string): Promise<number> {
  const rows = await tx.select().from(leases).where(and(eq(leases.orgId, orgId), leaseId ? eq(leases.id, leaseId) : inArray(leases.status, ["active", "notice"])));
  let made = 0;
  for (const l of rows) {
    const periods = chargePeriods(l, today);
    if (!periods.length) continue;
    const created = await tx.insert(rentCharges)
      .values(periods.map((period) => ({ orgId, leaseId: l.id, period, amountCents: l.rentCents, dueOn: dueDate(period, l.dueDay) })))
      .onConflictDoNothing({ target: [rentCharges.leaseId, rentCharges.period] }).returning({ id: rentCharges.id });
    made += created.length;
  }
  return made;
}

// worker, hourly: this month's charges for every organization's leases in force
export async function generateRentCharges(now = new Date()): Promise<number> {
  const orgs = await withContext({ system: true }, (tx) => tx.selectDistinct({ id: leases.orgId }).from(leases).where(inArray(leases.status, ["active", "notice"])));
  let made = 0;
  for (const o of orgs) {
    // each organization's own calendar decides which month it is (an organization is only readable in its own context)
    made += await withContext({ orgId: o.id, system: true }, async (tx) => {
      const [org] = await tx.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, o.id));
      return ensureCharges(tx, o.id, todayIn(org?.tz ?? "UTC", now));
    });
  }
  return made;
}

export type LeaseListRow = {
  id: string; unitNumber: string; buildingName: string; propertyName: string; tenantName: string; startsOn: string; endsOn: string | null; rentCents: number;
  status: string; moveOutOn: string | null; overdueCents: number; upcoming: boolean; endsSoon: boolean;
};
export type LeaseSummary = { inForce: number; rentRollCents: number; overdueCents: number; overdueLeases: number; endingSoon: number };
const SOON_DAYS = 60;

export async function listLeases(ctx: TenantCtx, opts: { view?: "current" | "ending" | "overdue" | "ended" | "all"; propertyId?: string; page?: number }): Promise<Page<LeaseListRow> & { summary: LeaseSummary }> {
  const p = ctx.principal;
  if (!canSeeLeases(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page);
  const today = todayIn(tzOf(p));
  const soon = addDays(today, SOON_DAYS);
  const inForce = inArray(leases.status, ["active", "notice"]);
  const overdue = sql<number>`coalesce((select sum(c.amount_cents - c.paid_cents) from rent_charges c where c.lease_id = leases.id and c.paid_cents < c.amount_cents and c.due_on < ${today}), 0)::int`;
  // "ending" = leaving on a known date within 60 days: a move-out after notice, or the end of a fixed term
  const endDate = sql`coalesce(${leases.moveOutOn}, ${leases.endsOn})`;
  const ending = and(inForce, sql`${endDate} is not null and ${endDate} <= ${soon}`);
  const view = opts.view ?? "current";
  const viewCond = { current: inForce, ending, overdue: and(inForce, sql`${overdue} > 0`), ended: eq(leases.status, "ended"), all: undefined }[view];
  return tenantTx(ctx, async (tx) => {
    const base = and(eq(leases.orgId, p.orgId), scoped(p), opts.propertyId ? eq(leases.propertyId, opts.propertyId) : undefined);
    const where = and(base, viewCond);
    const [{ n }] = await tx.select({ n: count() }).from(leases).where(where);
    const rows = await tx
      .select({
        id: leases.id, unitNumber: units.number, buildingName: buildings.name, propertyName: properties.name, first: residents.firstName, last: residents.lastName,
        startsOn: leases.startsOn, endsOn: leases.endsOn, rentCents: leases.rentCents, status: leases.status, moveOutOn: leases.moveOutOn, overdueCents: overdue,
      })
      .from(leases).innerJoin(units, eq(units.id, leases.unitId)).innerJoin(buildings, eq(buildings.id, units.buildingId))
      .innerJoin(properties, eq(properties.id, leases.propertyId)).innerJoin(residents, eq(residents.id, leases.residentId))
      .where(where)
      .orderBy(view === "ending" ? sql`${endDate} asc` : view === "overdue" ? sql`${overdue} desc` : view === "ended" ? desc(leases.updatedAt) : asc(properties.name), asc(units.number))
      .limit(pageSize).offset(offset);
    const [s] = await tx.select({
      inForce: sql<number>`count(*) filter (where ${inForce})::int`,
      rentRollCents: sql<number>`coalesce(sum(${leases.rentCents}) filter (where ${inForce} and ${leases.startsOn} <= ${today}), 0)::int`,
      overdueCents: sql<number>`coalesce(sum(${overdue}) filter (where ${inForce}), 0)::int`,
      overdueLeases: sql<number>`count(*) filter (where ${inForce} and ${overdue} > 0)::int`,
      endingSoon: sql<number>`count(*) filter (where ${ending})::int`,
    }).from(leases).where(base);
    return {
      ...toPage(rows.map(({ first, last, ...r }) => ({ ...r, tenantName: `${first} ${last}`, upcoming: r.status !== "ended" && r.startsOn > today, endsSoon: r.status !== "ended" && !!(r.moveOutOn ?? r.endsOn) && (r.moveOutOn ?? r.endsOn)! <= soon })), n, page, pageSize),
      summary: s,
    };
  });
}

async function load(tx: Tx, p: Principal, id: string, lock = false) {
  const q = tx.select().from(leases).where(and(eq(leases.id, id), eq(leases.orgId, p.orgId)));
  const [l] = lock ? await q.for("update") : await q;
  if (!l || !(can(p, "lease.read", res(l)) || can(p, "lease.manage", res(l)))) throw new NotFoundError();
  return l;
}

export async function getLease(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  const today = todayIn(tzOf(p));
  return tenantTx(ctx, async (tx) => {
    const l = await load(tx, p, id);
    const manage = can(p, "lease.manage", res(l));
    const [where] = await tx.select({ unitNumber: units.number, buildingName: buildings.name, propertyName: properties.name })
      .from(units).innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, buildings.propertyId)).where(eq(units.id, l.unitId));
    const [tenant] = await tx.select({ id: residents.id, firstName: residents.firstName, lastName: residents.lastName, email: residents.email, phone: residents.phone }).from(residents).where(eq(residents.id, l.residentId));
    const charges = await tx.select().from(rentCharges).where(eq(rentCharges.leaseId, id)).orderBy(desc(rentCharges.period));
    const owing = charges.reduce((s, c) => s + (c.amountCents - c.paidCents), 0);
    const overdue = charges.filter((c) => c.dueOn < today).reduce((s, c) => s + (c.amountCents - c.paidCents), 0);
    return { lease: l, ...where, tenant, charges, owingCents: owing, overdueCents: overdue, today, access: { manage, canSeeResident: can(p, "resident.read", res(l)) }, upcoming: l.status !== "ended" && l.startsOn > today };
  });
}

// units a lease can be written for (no lease in force), with the people living there
export async function leaseUnitOptions(ctx: TenantCtx, propertyId: string) {
  const p = ctx.principal;
  authorize(p, "lease.manage", { orgId: p.orgId, propertyId });
  return tenantTx(ctx, async (tx) => {
    const free = await tx.select({ id: units.id, number: units.number, buildingName: buildings.name,
        occupied: sql<boolean>`exists (select 1 from unit_occupancies o where o.unit_id = ${units.id} and (o.ends_on is null or o.ends_on >= current_date))` })
      .from(units).innerJoin(buildings, eq(buildings.id, units.buildingId))
      .where(and(eq(units.orgId, p.orgId), eq(buildings.propertyId, propertyId), sql`not exists (select 1 from leases l where l.unit_id = ${units.id} and l.status in ('active','notice'))`))
      .orderBy(asc(buildings.name), asc(units.number)).limit(1000);
    return free;
  });
}

export async function unitOccupantOptions(ctx: TenantCtx, unitId: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [u] = await tx.select({ id: units.id, number: units.number, propertyId: buildings.propertyId }).from(units).innerJoin(buildings, eq(buildings.id, units.buildingId)).where(and(eq(units.id, unitId), eq(units.orgId, p.orgId)));
    if (!u || !can(p, "lease.manage", { orgId: p.orgId, propertyId: u.propertyId })) throw new NotFoundError();
    const people = await tx.select({ id: residents.id, firstName: residents.firstName, lastName: residents.lastName, relationship: unitOccupancies.relationship })
      .from(unitOccupancies).innerJoin(residents, eq(residents.id, unitOccupancies.residentId))
      .where(and(eq(unitOccupancies.unitId, unitId), sql`${unitOccupancies.endsOn} is null or ${unitOccupancies.endsOn} >= current_date`)).orderBy(desc(unitOccupancies.isPrimary), asc(residents.lastName));
    return { unit: u, people };
  });
}

export const leaseSchema = z.object({
  unitId: z.string().uuid("Choose a unit."),
  residentId: z.string().uuid("Choose the tenant."),
  startsOn: isoDay,
  endsOn: z.union([z.literal(""), isoDay]).optional().transform((v) => v || null),
  rent: dollars("monthly rent", 1),
  deposit: z.union([z.literal(""), dollars("deposit", 0)]).optional().transform((v) => (v === "" || v === undefined ? 0 : v)),
  dueDay: z.coerce.number().int().min(1, "Between 1 and 28.").max(28, "Between 1 and 28.").default(1),
  notes: z.string().trim().max(4000).optional().transform(blankToNull),
});

export async function createLease(ctx: TenantCtx, input: z.output<typeof leaseSchema>) {
  const p = ctx.principal;
  if (input.endsOn && input.endsOn < input.startsOn) throw new ValidationError("The end date is before the start date.", "endsOn");
  return tenantTx(ctx, async (tx) => {
    const [u] = await tx.select({ id: units.id, propertyId: buildings.propertyId }).from(units).innerJoin(buildings, eq(buildings.id, units.buildingId)).where(and(eq(units.id, input.unitId), eq(units.orgId, p.orgId)));
    if (!u) throw new ValidationError("Choose a unit.", "unitId");
    authorize(p, "lease.manage", { orgId: p.orgId, propertyId: u.propertyId });
    // the tenant must be someone recorded as living in that unit
    const [occ] = await tx.select({ id: unitOccupancies.id }).from(unitOccupancies).where(and(eq(unitOccupancies.unitId, input.unitId), eq(unitOccupancies.residentId, input.residentId), eq(unitOccupancies.orgId, p.orgId)));
    if (!occ) throw new ValidationError("Choose someone who is recorded as living in this unit (add them under Residents first).", "residentId");
    const l = await friendlyUnique(async () => (await tx.insert(leases).values({
      orgId: p.orgId, propertyId: u.propertyId, unitId: input.unitId, residentId: input.residentId, startsOn: input.startsOn, endsOn: input.endsOn,
      rentCents: input.rent, depositCents: input.deposit, dueDay: input.dueDay, notes: input.notes, createdByUserId: p.userId,
    }).returning())[0], { leases_unit_in_force_uq: ["This unit already has a lease in force. End it before starting another.", "unitId"] });
    await ensureCharges(tx, p.orgId, todayIn(tzOf(p)), l.id);
    await auditAs(tx, ctx, "lease.create", "lease", l.id, undefined, { unitId: l.unitId, residentId: l.residentId, startsOn: l.startsOn, endsOn: l.endsOn, rentCents: l.rentCents, depositCents: l.depositCents });
    return l;
  });
}

async function manageable(tx: Tx, p: Principal, id: string): Promise<LeaseRow> {
  const l = await load(tx, p, id, true);
  authorize(p, "lease.manage", res(l));
  return l;
}

export const termsSchema = z.object({ rent: dollars("monthly rent", 1), endsOn: z.union([z.literal(""), isoDay]).optional().transform((v) => v || null), notes: z.string().trim().max(4000).optional().transform(blankToNull) });
// renewal or rent change: applies to charges not yet created (past months keep what was charged)
export async function changeTerms(ctx: TenantCtx, id: string, input: z.output<typeof termsSchema>) {
  return tenantTx(ctx, async (tx) => {
    const l = await manageable(tx, ctx.principal, id);
    if (l.status === "ended") throw new ConflictError("This lease has ended.");
    if (input.endsOn && input.endsOn < l.startsOn) throw new ValidationError("The end date is before the start date.", "endsOn");
    const [u] = await tx.update(leases).set({ rentCents: input.rent, endsOn: input.endsOn, notes: input.notes }).where(eq(leases.id, id)).returning();
    await auditAs(tx, ctx, "lease.terms", "lease", id, { rentCents: l.rentCents, endsOn: l.endsOn }, { rentCents: u.rentCents, endsOn: u.endsOn });
    return u;
  });
}

export const noticeSchema = z.object({ moveOutOn: isoDay });
export async function giveNotice(ctx: TenantCtx, id: string, moveOutOn: string) {
  const today = todayIn(tzOf(ctx.principal));
  return tenantTx(ctx, async (tx) => {
    const l = await manageable(tx, ctx.principal, id);
    if (l.status === "ended") throw new ConflictError("This lease has ended.");
    if (moveOutOn < l.startsOn) throw new ValidationError("The move-out date is before the lease starts.", "moveOutOn");
    const [u] = await tx.update(leases).set({ status: "notice", noticeGivenOn: l.noticeGivenOn ?? today, moveOutOn }).where(eq(leases.id, id)).returning();
    await auditAs(tx, ctx, "lease.notice", "lease", id, { status: l.status, moveOutOn: l.moveOutOn }, { status: "notice", moveOutOn });
    return u;
  });
}

export async function withdrawNotice(ctx: TenantCtx, id: string) {
  return tenantTx(ctx, async (tx) => {
    const l = await manageable(tx, ctx.principal, id);
    if (l.status !== "notice") throw new ConflictError("No notice is recorded on this lease.");
    await tx.update(leases).set({ status: "active", noticeGivenOn: null, moveOutOn: null }).where(eq(leases.id, id));
    await auditAs(tx, ctx, "lease.notice_withdrawn", "lease", id, { status: "notice", moveOutOn: l.moveOutOn }, { status: "active" });
  });
}

export const endSchema = z.object({ endedOn: isoDay });
export async function endLease(ctx: TenantCtx, id: string, endedOn: string) {
  const today = todayIn(tzOf(ctx.principal));
  return tenantTx(ctx, async (tx) => {
    const l = await manageable(tx, ctx.principal, id);
    if (l.status === "ended") throw new ConflictError("This lease has already ended.");
    if (endedOn > today) throw new ValidationError("To end a lease on a future date, record notice with that move-out date instead.", "endedOn");
    if (endedOn < l.startsOn) throw new ValidationError("That is before the lease started.", "endedOn");
    await tx.update(leases).set({ moveOutOn: endedOn }).where(eq(leases.id, id));
    // charge any months up to the end that haven't been charged yet, so the final balance is complete
    await ensureCharges(tx, ctx.principal.orgId, today, id);
    await tx.update(leases).set({ status: "ended" }).where(eq(leases.id, id));
    await auditAs(tx, ctx, "lease.end", "lease", id, { status: l.status }, { status: "ended", moveOutOn: endedOn });
  });
}

export const paymentSchema = z.object({ amount: dollars("amount", 1), paidOn: isoDay, note: z.string().trim().max(300).optional().transform(blankToNull) });
// record money received against one month's rent (in part or in full). Nothing is collected by the product.
export async function recordPayment(ctx: TenantCtx, chargeId: string, input: z.output<typeof paymentSchema>) {
  const p = ctx.principal;
  const today = todayIn(tzOf(p));
  return tenantTx(ctx, async (tx) => {
    const [c] = await tx.select().from(rentCharges).where(and(eq(rentCharges.id, chargeId), eq(rentCharges.orgId, p.orgId))).for("update");
    if (!c) throw new NotFoundError();
    const l = await load(tx, p, c.leaseId);
    authorize(p, "lease.manage", res(l));
    if (input.paidOn > today) throw new ValidationError("The payment date is in the future.", "paidOn");
    const left = c.amountCents - c.paidCents;
    if (left <= 0) throw new ConflictError("This month is already paid in full.");
    if (input.amount > left) throw new ValidationError(`That is more than the ${(left / 100).toFixed(2)} still owing for this month.`, "amount");
    const paid = c.paidCents + input.amount;
    const note = [c.note, input.note].filter(Boolean).join("; ").slice(0, 600) || null;
    const [u] = await tx.update(rentCharges).set({ paidCents: paid, paidOn: paid >= c.amountCents ? input.paidOn : null, note }).where(eq(rentCharges.id, chargeId)).returning();
    await auditAs(tx, ctx, "lease.payment", "lease", l.id, { period: c.period, paidCents: c.paidCents }, { period: c.period, paidCents: paid, receivedCents: input.amount, paidOn: input.paidOn });
    return { charge: u, leaseId: l.id };
  });
}

// used when someone tries to delete a resident: lease and rent records are kept
export async function residentHasLeases(tx: Tx, orgId: string, residentId: string): Promise<boolean> {
  const [{ n }] = await tx.select({ n: count() }).from(leases).where(and(eq(leases.orgId, orgId), eq(leases.residentId, residentId)));
  return n > 0;
}
