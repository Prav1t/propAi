import "server-only";
import { randomInt } from "node:crypto";
import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { buildings, files, packages, properties, units, users, PACKAGE_SIZES } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { withContext } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { emit, emitSystem } from "../ops/core";
import { fileRows, prepareFiles, withStoredBlobs, type PreparedFile } from "../../files/service";
import { sniff } from "../../files/sniff";
import { unitOccupants } from "../community/residents";
import { detectCarrier, normalizeTracking } from "./carrier";

type PkgRow = typeof packages.$inferSelect;
export const OVERDUE_DAYS = 7;
export const reminderDays = () => Math.max(1, Number(process.env.PACKAGE_REMINDER_DAYS) || 3);

const res = (k: { orgId: string; propertyId: string; buildingId: string }) => ({ orgId: k.orgId, propertyId: k.propertyId, buildingId: k.buildingId });
export const canManagePackages = (p: Principal) => p.permissions.has("package.manage");
export const canUsePackages = (p: Principal) => p.permissions.has("package.manage") || p.permissions.has("package.read.own");

function access(p: Principal, k: PkgRow) {
  const manage = k.orgId === p.orgId && can(p, "package.manage", res(k));
  const own = k.orgId === p.orgId && p.permissions.has("package.read.own") && p.unitIds.has(k.unitId);
  return { manage, own, read: manage || own };
}

function visibleWhere(p: Principal): SQL {
  if (p.permissions.has("package.manage")) return scopeCondition(p, { property: packages.propertyId, building: packages.buildingId }) ?? sql`true`;
  if (p.permissions.has("package.read.own") && p.unitIds.size) return inArray(packages.unitId, [...p.unitIds]);
  return sql`false`;
}

/* ───────────── intake ───────────── */

export const packageSchema = z.object({
  buildingId: z.string().uuid("Choose the building."),
  unitNumber: z.string().trim().min(1, "Enter the unit.").max(20),
  recipientName: z.string().trim().max(120).optional().transform(blankToNull),
  carrier: z.string().trim().max(40).optional().transform(blankToNull),
  trackingNumber: z.string().trim().max(60).optional().transform((v) => (v ? normalizeTracking(v) || null : null)),
  size: z.enum(PACKAGE_SIZES).default("small"),
  perishable: z.union([z.literal("on"), z.literal("")]).optional().transform((v) => v === "on"),
  shelfLocation: z.string().trim().max(40).optional().transform(blankToNull),
  notes: z.string().trim().max(500).optional().transform(blankToNull),
});
export type PackageInput = z.infer<typeof packageSchema>;

const pickupCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

// logs a delivery: finds the unit, matches the recipient to a current occupant, generates a pickup code, notifies the unit
export async function logPackage(ctx: TenantCtx, input: PackageInput, photos: File[] = []) {
  const p = ctx.principal;
  const prepared = photos.length ? await prepareFiles(p.orgId, "package", photos) : [];
  return withStoredBlobs(prepared, () => tenantTx(ctx, async (tx) => {
    const [b] = await tx.select().from(buildings).where(and(eq(buildings.id, input.buildingId), eq(buildings.orgId, p.orgId)));
    if (!b) throw new ValidationError("Building not found.", "buildingId");
    authorize(p, "package.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId: b.id });
    const [u] = await tx.select().from(units).where(and(eq(units.buildingId, b.id), sql`lower(${units.number}) = lower(${input.unitNumber})`));
    if (!u) throw new ValidationError(`No unit ${input.unitNumber} in ${b.name}.`, "unitNumber");
    const occupants = await unitOccupants(tx, p.orgId, u.id);
    const wanted = input.recipientName?.toLowerCase();
    const match = wanted ? occupants.find((o) => `${o.firstName} ${o.lastName}`.toLowerCase().includes(wanted) || wanted.includes(o.lastName.toLowerCase())) : occupants[0];
    const detected = input.trackingNumber ? detectCarrier(input.trackingNumber) : null;
    const [k] = await tx.insert(packages).values({
      orgId: p.orgId, propertyId: b.propertyId, buildingId: b.id, unitId: u.id, residentId: match?.residentId ?? null,
      recipientName: input.recipientName ?? (match ? `${match.firstName} ${match.lastName}` : null),
      carrier: input.carrier ?? detected?.carrier ?? null, trackingNumber: input.trackingNumber, size: input.size, perishable: input.perishable,
      shelfLocation: input.shelfLocation, notes: input.notes, pickupCode: pickupCode(), receivedByUserId: p.userId,
    }).returning();
    if (prepared.length) await tx.insert(files).values(fileRows(prepared, p, "package", k.id, "public"));
    await auditAs(tx, ctx, "package.received", "package", k.id, undefined, { unit: u.number, carrier: k.carrier, tracking: k.trackingNumber });
    await emit(tx, ctx, "package.arrived", { packageId: k.id });
    return { package: k, unitNumber: u.number, buildingName: b.name, matched: !!match, occupantCount: occupants.length };
  }));
}

/* ───────────── lists ───────────── */

export type PackageView = "waiting" | "overdue" | "picked_up" | "returned" | "all";
export type PackageListRow = { id: string; unitNumber: string; buildingName: string; propertyName: string; recipientName: string | null; carrier: string | null; trackingNumber: string | null; size: string; perishable: boolean; shelfLocation: string | null; status: string; receivedAt: Date; pickedUpAt: Date | null; pickedUpByName: string | null; pickupCode: string | null; photos: number };

export async function listPackages(ctx: TenantCtx, opts: { view?: PackageView; q?: string; propertyId?: string; buildingId?: string; unitId?: string; receivedBefore?: Date; page?: number; pageSize?: number }): Promise<Page<PackageListRow>> {
  const p = ctx.principal;
  if (!canUsePackages(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page, opts.pageSize ?? 50);
  const overdueBefore = new Date(Date.now() - OVERDUE_DAYS * 86_400_000);
  const view = opts.view ?? "waiting";
  const cond: Record<PackageView, SQL | undefined> = {
    waiting: eq(packages.status, "waiting"),
    overdue: and(eq(packages.status, "waiting"), lt(packages.receivedAt, overdueBefore)),
    picked_up: eq(packages.status, "picked_up"),
    returned: eq(packages.status, "returned"),
    all: undefined,
  };
  const q = opts.q?.trim();
  const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
  const staff = canManagePackages(p);
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(packages.orgId, p.orgId), visibleWhere(p), cond[view],
      opts.propertyId ? eq(packages.propertyId, opts.propertyId) : undefined, opts.buildingId ? eq(packages.buildingId, opts.buildingId) : undefined,
      opts.unitId ? eq(packages.unitId, opts.unitId) : undefined, opts.receivedBefore ? lt(packages.receivedAt, opts.receivedBefore) : undefined,
      like ? or(sql`lower(${units.number}) = lower(${q})`, ilike(packages.recipientName, like), ilike(packages.trackingNumber, `%${normalizeTracking(q!)}%`), eq(packages.pickupCode, q!)) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(packages).innerJoin(units, eq(units.id, packages.unitId)).where(where);
    const rows = await tx.select({
      id: packages.id, unitNumber: units.number, buildingName: buildings.name, propertyName: properties.name, recipientName: packages.recipientName, carrier: packages.carrier,
      trackingNumber: packages.trackingNumber, size: packages.size, perishable: packages.perishable, shelfLocation: packages.shelfLocation, status: packages.status,
      receivedAt: packages.receivedAt, pickedUpAt: packages.pickedUpAt, pickedUpByName: packages.pickedUpByName, pickupCode: packages.pickupCode,
      photos: sql<number>`(select count(*)::int from files f where f.entity_type = 'package' and f.entity_id = packages.id and f.visibility = 'public')`,
    }).from(packages).innerJoin(units, eq(units.id, packages.unitId)).innerJoin(buildings, eq(buildings.id, packages.buildingId)).innerJoin(properties, eq(properties.id, packages.propertyId))
      .where(where).orderBy(view === "waiting" || view === "overdue" ? asc(packages.receivedAt) : desc(packages.receivedAt)).limit(pageSize).offset(offset);
    // staff verify the resident's code instead of reading it out; residents see their own codes
    return toPage(rows.map((r) => ({ ...r, pickupCode: staff ? null : r.status === "waiting" ? r.pickupCode : null })), n, page, pageSize);
  });
}

export async function getPackage(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [k] = await tx.select().from(packages).where(and(eq(packages.id, id), eq(packages.orgId, p.orgId)));
    if (!k) throw new NotFoundError();
    const a = access(p, k);
    if (!a.read) throw new NotFoundError();
    const [labels] = await tx.select({ unitNumber: units.number, buildingName: buildings.name, propertyName: properties.name }).from(units)
      .innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, units.propertyId)).where(eq(units.id, k.unitId));
    const [receiver] = k.receivedByUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, k.receivedByUserId)) : [];
    const [releaser] = k.releasedByUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, k.releasedByUserId)) : [];
    const levels = a.manage ? ["public", "vendor", "internal"] : ["public"];
    const attachments = await tx.select().from(files).where(and(eq(files.entityType, "package"), eq(files.entityId, id), inArray(files.visibility, levels))).orderBy(asc(files.createdAt));
    return { package: { ...k, pickupCode: a.manage ? null : k.pickupCode }, labels, receivedByName: receiver?.name ?? null, releasedByName: releaser?.name ?? null, attachments, access: a };
  });
}

/* ───────────── release ───────────── */

export const releaseSchema = z.object({
  pickedUpByName: z.string().trim().min(2, "Who picked it up?").max(120),
  pickupCode: z.string().trim().max(10).optional().transform(blankToNull),
  signature: z.string().max(400_000).optional().transform(blankToNull), // PNG data URL from the signature pad
});

function signatureFile(dataUrl: string | null): File[] {
  if (!dataUrl) return [];
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new ValidationError("The signature couldn't be read. Try signing again.", "signature");
  const bytes = Buffer.from(m[1], "base64");
  if (sniff(new Uint8Array(bytes))?.mime !== "image/png") throw new ValidationError("The signature couldn't be read. Try signing again.", "signature");
  return [new File([bytes], "signature.png", { type: "image/png" })];
}

// hands over one or more waiting packages; a single package can be checked against its pickup code
export async function releasePackages(ctx: TenantCtx, ids: string[], input: z.infer<typeof releaseSchema>) {
  const p = ctx.principal;
  const unique = [...new Set(ids)].slice(0, 50);
  if (!unique.length) throw new ValidationError("Select at least one package.");
  const sig = signatureFile(input.signature);
  // one stored copy of the signature per package, keyed by package id
  const signed = new Map<string, PreparedFile>();
  if (sig.length) for (const id of unique) signed.set(id, (await prepareFiles(p.orgId, "package", sig))[0]);
  return withStoredBlobs([...signed.values()], () => tenantTx(ctx, async (tx) => {
    const rows = await tx.select().from(packages).where(and(eq(packages.orgId, p.orgId), inArray(packages.id, unique))).for("update");
    if (rows.length !== unique.length) throw new NotFoundError();
    for (const k of rows) {
      if (!access(p, k).manage) throw new ForbiddenError();
      if (k.status !== "waiting") throw new ValidationError("One of these packages was already released.");
    }
    if (input.pickupCode && rows.length === 1 && rows[0].pickupCode !== input.pickupCode) throw new ValidationError("That pickup code doesn't match.", "pickupCode");
    const now = new Date();
    await tx.update(packages).set({ status: "picked_up", pickedUpAt: now, pickedUpByName: input.pickedUpByName, releasedByUserId: p.userId }).where(inArray(packages.id, unique));
    for (const k of rows) {
      const file = signed.get(k.id);
      if (file) await tx.insert(files).values(fileRows([file], p, "package", k.id, "internal"));
      await auditAs(tx, ctx, "package.released", "package", k.id, { status: "waiting" }, { status: "picked_up", by: input.pickedUpByName, codeVerified: !!input.pickupCode, signed: !!file });
      await emit(tx, ctx, "package.released", { packageId: k.id });
    }
    return rows.length;
  }));
}

export const returnSchema = z.object({ reason: z.string().trim().min(3, "Why is it going back?").max(300) });

export async function returnPackage(ctx: TenantCtx, id: string, input: z.infer<typeof returnSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [k] = await tx.select().from(packages).where(and(eq(packages.id, id), eq(packages.orgId, p.orgId)));
    if (!k) throw new NotFoundError();
    if (!access(p, k).manage) throw new ForbiddenError();
    if (k.status !== "waiting") throw new ValidationError("Only waiting packages can be returned.");
    await tx.update(packages).set({ status: "returned", returnedAt: new Date(), returnReason: input.reason, releasedByUserId: p.userId }).where(eq(packages.id, id));
    await auditAs(tx, ctx, "package.returned", "package", id, { status: "waiting" }, { status: "returned", reason: input.reason });
  });
}

export async function packageStats(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!canManagePackages(p)) return null;
  const overdueBefore = new Date(Date.now() - OVERDUE_DAYS * 86_400_000);
  const since = new Date(Date.now() - 86_400_000);
  const [r] = await tenantTx(ctx, (tx) => tx.select({
    waiting: sql<number>`count(*) filter (where ${packages.status} = 'waiting')::int`,
    overdue: sql<number>`count(*) filter (where ${packages.status} = 'waiting' and ${packages.receivedAt} < ${overdueBefore})::int`,
    last24h: sql<number>`count(*) filter (where ${packages.receivedAt} >= ${since})::int`,
    perishable: sql<number>`count(*) filter (where ${packages.status} = 'waiting' and ${packages.perishable})::int`,
  }).from(packages).where(and(eq(packages.orgId, p.orgId), visibleWhere(p))));
  return r;
}

/* ───────────── worker ───────────── */

// one reminder per package after PACKAGE_REMINDER_DAYS; perishables are reminded after one day
export async function packageReminders(): Promise<number> {
  const due = await withContext({ system: true }, (tx) =>
    tx.select({ id: packages.id, orgId: packages.orgId }).from(packages)
      .where(and(eq(packages.status, "waiting"), isNull(packages.reminderSentAt),
        or(lt(packages.receivedAt, new Date(Date.now() - reminderDays() * 86_400_000)), and(eq(packages.perishable, true), lt(packages.receivedAt, new Date(Date.now() - 86_400_000))))))
      .limit(200));
  for (const k of due) {
    await withContext({ orgId: k.orgId, system: true }, async (tx: Tx) => {
      const r = await tx.update(packages).set({ reminderSentAt: new Date() }).where(and(eq(packages.id, k.id), isNull(packages.reminderSentAt))).returning({ id: packages.id });
      if (r.length) await emitSystem(tx, k.orgId, "package.reminder", { packageId: k.id });
    });
  }
  return due.length;
}

