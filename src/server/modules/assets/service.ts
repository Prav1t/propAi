import "server-only";
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assetDowntime, assets, buildings, files, memberships, pmSchedules, properties, roles, users, vendorProperties, vendors, workOrders,
  ASSET_CATEGORIES, ASSET_STATUSES,
} from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import { withContext, type Tx } from "../../db/client";
import { auditAs, blankToNull, friendlyUnique, tenantTx, ValidationError, type TenantCtx } from "../context";
import { matches, pageArgs, scopeCondition, toPage, toPrefixQuery, type Page } from "../scope";
import { addTimeline, emit, emitSystem, nextNumber } from "../ops/core";
import { PRIORITY_ORDER } from "../maintenance/rules";
import { zonedToUtc } from "@/lib/time";
import { addInterval, describeInterval, planGeneration, type IntervalUnit } from "./schedule";

type AssetRow = typeof assets.$inferSelect;
type PmRow = typeof pmSchedules.$inferSelect;

export const canReadAssets = (p: Principal) => p.permissions.has("asset.read") || p.permissions.has("asset.manage");
export const canManageAssets = (p: Principal) => p.permissions.has("asset.manage");

const optUuid = z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null);
const opt = (max: number) => z.string().trim().max(max).optional().transform(blankToNull);
const optDate = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")]).optional().transform((v) => v || null);
const res = (a: Pick<AssetRow, "orgId" | "propertyId" | "buildingId">) => ({ orgId: a.orgId, propertyId: a.propertyId, buildingId: a.buildingId });
const scoped = (p: Principal) => scopeCondition(p, { property: assets.propertyId, building: assets.buildingId }) ?? sql`true`;

// asset category → work order category
const WO_CATEGORY: Record<string, string> = {
  hvac: "hvac", elevator: "elevator", plumbing: "plumbing", electrical: "electrical", fire_safety: "fire_safety", roofing: "exterior",
  security: "doors_locks", doors_access: "doors_locks", generator: "electrical", pool: "general", appliance: "appliance", other: "general",
};
export const woCategoryForAsset = (c: string) => WO_CATEGORY[c] ?? "general";

function access(p: Principal, a: AssetRow) {
  const manage = a.orgId === p.orgId && can(p, "asset.manage", res(a));
  const read = manage || (a.orgId === p.orgId && can(p, "asset.read", res(a)));
  return { manage, read };
}

async function loadAsset(tx: Tx, p: Principal, id: string) {
  const [a] = await tx.select().from(assets).where(and(eq(assets.id, id), eq(assets.orgId, p.orgId)));
  if (!a || !access(p, a).read) throw new NotFoundError();
  return a;
}

/* ───────────── registry ───────────── */

export const assetSchema = z.object({
  propertyId: z.string().uuid("Choose the property."),
  buildingId: optUuid,
  location: opt(120),
  name: z.string().trim().min(2, "Name the asset.").max(120),
  tag: z.string().trim().max(40).optional().transform((v) => (v ? v.toUpperCase() : null)),
  category: z.enum(ASSET_CATEGORIES),
  make: opt(60),
  model: opt(60),
  serialNumber: opt(80),
  installedOn: optDate,
  warrantyUntil: optDate,
  expectedLifeYears: z.union([z.literal(""), z.coerce.number().int().min(1).max(100)]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
  criticality: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  vendorId: optUuid,
  replacementCost: z.union([z.literal(""), z.coerce.number().min(0).max(100_000_000)]).optional().transform((v) => (v === "" || v === undefined ? null : v.toFixed(2))),
  notes: opt(2000),
});
export type AssetInput = z.infer<typeof assetSchema>;

async function checkPlacement(tx: Tx, p: Principal, input: AssetInput) {
  const [pr] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.orgId, p.orgId), eq(properties.id, input.propertyId)));
  if (!pr) throw new ValidationError("Property not found.", "propertyId");
  if (input.buildingId) {
    const [b] = await tx.select({ propertyId: buildings.propertyId }).from(buildings).where(and(eq(buildings.orgId, p.orgId), eq(buildings.id, input.buildingId)));
    if (!b || b.propertyId !== pr.id) throw new ValidationError("That building isn't part of the property.", "buildingId");
  }
  authorize(p, "asset.manage", { orgId: p.orgId, propertyId: input.propertyId, buildingId: input.buildingId });
  if (input.vendorId) {
    const [v] = await tx.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.orgId, p.orgId), eq(vendors.id, input.vendorId)));
    if (!v) throw new ValidationError("Vendor not found.", "vendorId");
  }
}

export async function createAsset(ctx: TenantCtx, input: AssetInput) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    await checkPlacement(tx, p, input);
    const [a] = await friendlyUnique(() => tx.insert(assets).values({ orgId: p.orgId, ...input }).returning(), { assets_tag_uq: ["That asset tag is already in use.", "tag"] });
    await auditAs(tx, ctx, "asset.created", "asset", a.id, undefined, a);
    return a;
  });
}

export async function updateAsset(ctx: TenantCtx, id: string, input: AssetInput) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const before = await loadAsset(tx, p, id);
    if (!access(p, before).manage) throw new ForbiddenError();
    await checkPlacement(tx, p, input);
    const [a] = await friendlyUnique(() => tx.update(assets).set(input).where(eq(assets.id, id)).returning(), { assets_tag_uq: ["That asset tag is already in use.", "tag"] });
    await auditAs(tx, ctx, "asset.updated", "asset", id, before, a);
    return a;
  });
}

/* ───────────── status & downtime ───────────── */

export async function openDowntimeTx(tx: Tx, a: Pick<AssetRow, "id" | "orgId" | "propertyId">, reason: string, userId: string | null, workOrderId: string | null) {
  const [open] = await tx.select({ id: assetDowntime.id }).from(assetDowntime).where(and(eq(assetDowntime.assetId, a.id), isNull(assetDowntime.endedAt)));
  if (open) return null;
  const [d] = await tx.insert(assetDowntime).values({ orgId: a.orgId, assetId: a.id, propertyId: a.propertyId, startedAt: new Date(), reason, workOrderId, startedByUserId: userId }).returning();
  await tx.update(assets).set({ status: "down" }).where(eq(assets.id, a.id));
  return d;
}

// when the repair is done, the asset comes back into service
export async function closeDowntimeForWorkOrderTx(tx: Tx, workOrderId: string, userId: string | null) {
  const closed = await tx.update(assetDowntime).set({ endedAt: new Date(), endedByUserId: userId })
    .where(and(eq(assetDowntime.workOrderId, workOrderId), isNull(assetDowntime.endedAt))).returning({ assetId: assetDowntime.assetId });
  for (const c of closed) await tx.update(assets).set({ status: "operational" }).where(and(eq(assets.id, c.assetId), eq(assets.status, "down")));
  return closed.length;
}

export const statusSchema = z.object({
  status: z.enum(ASSET_STATUSES),
  note: opt(500),
}).superRefine((v, c) => {
  if (v.status === "down" && !v.note) c.addIssue({ code: "custom", path: ["note"], message: "Say what's wrong." });
});

export async function setAssetStatus(ctx: TenantCtx, id: string, input: z.infer<typeof statusSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const a = await loadAsset(tx, p, id);
    if (!access(p, a).manage) throw new ForbiddenError();
    if (a.status === input.status) throw new ValidationError("That's already the status.", "status");
    if (input.status === "down") {
      await openDowntimeTx(tx, a, input.note!, p.userId, null);
      await emit(tx, ctx, "asset.down", { assetId: id, reason: input.note });
    } else {
      await tx.update(assetDowntime).set({ endedAt: new Date(), endedByUserId: p.userId }).where(and(eq(assetDowntime.assetId, id), isNull(assetDowntime.endedAt)));
      await tx.update(assets).set({ status: input.status }).where(eq(assets.id, id));
      if (input.status === "retired") await tx.update(pmSchedules).set({ active: false }).where(eq(pmSchedules.assetId, id));
    }
    await auditAs(tx, ctx, "asset.status_changed", "asset", id, { status: a.status }, { status: input.status, note: input.note });
  });
}

/* ───────────── lists & detail ───────────── */

export type AssetListRow = {
  id: string; name: string; tag: string | null; category: string; status: string; criticality: string; location: string | null;
  propertyName: string; buildingName: string | null; openWorkOrders: number; reactive90d: number; nextPmOn: string | null;
};

export async function listAssets(ctx: TenantCtx, opts: { q?: string; propertyId?: string; category?: string; status?: string; page?: number }): Promise<Page<AssetListRow>> {
  const p = ctx.principal;
  if (!canReadAssets(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page, 50);
  const tsq = toPrefixQuery(opts.q);
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(assets.orgId, p.orgId), scoped(p),
      opts.status && (ASSET_STATUSES as readonly string[]).includes(opts.status) ? eq(assets.status, opts.status) : opts.status === "active" ? sql`${assets.status} <> 'retired'` : undefined,
      opts.propertyId ? eq(assets.propertyId, opts.propertyId) : undefined,
      opts.category && (ASSET_CATEGORIES as readonly string[]).includes(opts.category) ? eq(assets.category, opts.category) : undefined,
      tsq ? matches("assets", tsq) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(assets).where(where);
    const rows = await tx.select({
      id: assets.id, name: assets.name, tag: assets.tag, category: assets.category, status: assets.status, criticality: assets.criticality, location: assets.location,
      propertyName: properties.name, buildingName: buildings.name,
      openWorkOrders: sql<number>`(select count(*)::int from work_orders w where w.asset_id = assets.id and w.status in ('new','acknowledged','assigned','scheduled','in_progress','awaiting_vendor','awaiting_resident'))`,
      reactive90d: sql<number>`(select count(*)::int from work_orders w where w.asset_id = assets.id and coalesce(w.source_type, '') <> 'pm_schedule' and w.created_at > now() - interval '90 days')`,
      nextPmOn: sql<string | null>`(select min(next_due_on)::text from pm_schedules s where s.asset_id = assets.id and s.active)`,
    }).from(assets).innerJoin(properties, eq(properties.id, assets.propertyId)).leftJoin(buildings, eq(buildings.id, assets.buildingId))
      .where(where).orderBy(sql`case ${assets.status} when 'down' then 0 when 'needs_attention' then 1 when 'operational' then 2 else 3 end`, asc(properties.name), asc(assets.name))
      .limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

export async function getAsset(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const a = await loadAsset(tx, p, id);
    const acc = access(p, a);
    const [labels] = await tx.select({ propertyName: properties.name, tz: properties.timezone }).from(properties).where(eq(properties.id, a.propertyId));
    const [bld] = a.buildingId ? await tx.select({ name: buildings.name }).from(buildings).where(eq(buildings.id, a.buildingId)) : [];
    const [vendor] = a.vendorId ? await tx.select({ id: vendors.id, name: vendors.name, phone: vendors.phone }).from(vendors).where(eq(vendors.id, a.vendorId)) : [];
    const schedules = await tx.select({
      s: pmSchedules, vendorName: vendors.name, assigneeName: users.name,
    }).from(pmSchedules).leftJoin(vendors, eq(vendors.id, pmSchedules.assignVendorId)).leftJoin(memberships, eq(memberships.id, pmSchedules.assignMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId)).where(eq(pmSchedules.assetId, id)).orderBy(desc(pmSchedules.active), asc(pmSchedules.nextDueOn));
    const downtime = await tx.select().from(assetDowntime).where(eq(assetDowntime.assetId, id)).orderBy(desc(assetDowntime.startedAt)).limit(20);
    const history = await tx.select({ id: workOrders.id, number: workOrders.number, title: workOrders.title, status: workOrders.status, createdAt: workOrders.createdAt,
      completedAt: workOrders.completedAt, cost: workOrders.cost, sourceType: workOrders.sourceType, vendorName: vendors.name })
      .from(workOrders).leftJoin(vendors, eq(vendors.id, workOrders.vendorId)).where(eq(workOrders.assetId, id)).orderBy(desc(workOrders.createdAt)).limit(25);
    const [stats] = (await tx.execute(sql`select
        coalesce(sum(extract(epoch from (least(coalesce(ended_at, now()), now()) - greatest(started_at, now() - interval '90 days'))) / 3600)
          filter (where coalesce(ended_at, now()) > now() - interval '90 days'), 0)::float as downtime_90d,
        coalesce(sum(extract(epoch from (coalesce(ended_at, now()) - greatest(started_at, now() - interval '365 days'))) / 3600)
          filter (where coalesce(ended_at, now()) > now() - interval '365 days'), 0)::float as downtime_365d,
        count(*) filter (where coalesce(ended_at, now()) > now() - interval '365 days')::int as outages_365d
      from asset_downtime where asset_id = ${id}`)).rows as { downtime_90d: number; downtime_365d: number; outages_365d: number }[];
    const [wo] = (await tx.execute(sql`select
        count(*) filter (where coalesce(source_type, '') <> 'pm_schedule' and created_at > now() - interval '90 days')::int as reactive_90d,
        count(*) filter (where source_type = 'pm_schedule' and status in ('completed','closed') and completed_at > now() - interval '365 days')::int as pm_done_365d,
        coalesce(sum(cost) filter (where completed_at > now() - interval '365 days'), 0)::float as cost_365d,
        coalesce(sum(cost) filter (where coalesce(source_type, '') <> 'pm_schedule' and completed_at > now() - interval '365 days'), 0)::float as reactive_cost_365d
      from work_orders where asset_id = ${id}`)).rows as { reactive_90d: number; pm_done_365d: number; cost_365d: number; reactive_cost_365d: number }[];
    const attachments = await tx.select().from(files).where(and(eq(files.entityType, "asset"), eq(files.entityId, id))).orderBy(asc(files.createdAt));
    return {
      asset: a, access: acc, labels: { ...labels, buildingName: bld?.name ?? null }, vendor: vendor ?? null,
      schedules: schedules.map((x) => ({ ...x.s, vendorName: x.vendorName, assigneeName: x.assigneeName, every: describeInterval(x.s.intervalUnit as IntervalUnit, x.s.intervalCount) })),
      downtime, history, attachments,
      stats: { downtime90d: stats.downtime_90d, downtime365d: stats.downtime_365d, outages365d: stats.outages_365d, reactive90d: wo.reactive_90d, pmDone365d: wo.pm_done_365d, cost365d: wo.cost_365d, reactiveCost365d: wo.reactive_cost_365d },
      openDowntime: downtime.find((d) => !d.endedAt) ?? null,
    };
  });
}

// assets a work order can be linked to (staff create form)
export async function assetOptions(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!canReadAssets(p) && !p.permissions.has("workorder.manage")) return [];
  return tenantTx(ctx, (tx) => tx.select({ id: assets.id, name: assets.name, tag: assets.tag, category: assets.category, propertyId: assets.propertyId, buildingId: assets.buildingId, propertyName: properties.name })
    .from(assets).innerJoin(properties, eq(properties.id, assets.propertyId))
    .where(and(eq(assets.orgId, p.orgId), sql`${assets.status} <> 'retired'`, scoped(p))).orderBy(asc(properties.name), asc(assets.name)).limit(1000));
}

/* ───────────── preventive maintenance ───────────── */

export const pmSchema = z.object({
  title: z.string().trim().min(3, "Name the maintenance task.").max(120),
  instructions: opt(4000),
  intervalUnit: z.enum(["day", "week", "month", "year"]),
  intervalCount: z.coerce.number().int().min(1, "At least 1.").max(366),
  nextDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the next due date."),
  leadDays: z.coerce.number().int().min(0).max(90).default(7),
  priority: z.enum(PRIORITY_ORDER).default("normal"),
  assignVendorId: optUuid,
  assignMembershipId: optUuid,
});

async function validateAssignees(tx: Tx, orgId: string, propertyId: string, input: { assignVendorId: string | null; assignMembershipId: string | null }) {
  if (input.assignVendorId) {
    const [ok] = await tx.select({ id: vendors.id }).from(vendors).innerJoin(vendorProperties, eq(vendorProperties.vendorId, vendors.id))
      .where(and(eq(vendors.orgId, orgId), eq(vendors.id, input.assignVendorId), eq(vendors.status, "active"), eq(vendorProperties.propertyId, propertyId)));
    if (!ok) throw new ValidationError("That vendor isn't approved for this property.", "assignVendorId");
  }
  if (input.assignMembershipId) {
    const [m] = await tx.select({ id: memberships.id }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.orgId, orgId), eq(memberships.id, input.assignMembershipId), eq(memberships.status, "active"), eq(roles.category, "staff")));
    if (!m) throw new ValidationError("Choose an active staff member.", "assignMembershipId");
  }
}

export async function createPmSchedule(ctx: TenantCtx, assetId: string, input: z.infer<typeof pmSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const a = await loadAsset(tx, p, assetId);
    if (!access(p, a).manage) throw new ForbiddenError();
    if (a.status === "retired") throw new ValidationError("Retired assets don't get maintenance schedules.");
    await validateAssignees(tx, p.orgId, a.propertyId, input);
    const [s] = await tx.insert(pmSchedules).values({ orgId: p.orgId, assetId, propertyId: a.propertyId, ...input }).returning();
    await auditAs(tx, ctx, "pm.schedule_created", "asset", assetId, undefined, s);
    return s;
  });
}

export async function setPmActive(ctx: TenantCtx, id: string, active: boolean) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [s] = await tx.select().from(pmSchedules).where(and(eq(pmSchedules.id, id), eq(pmSchedules.orgId, p.orgId)));
    if (!s) throw new NotFoundError();
    const a = await loadAsset(tx, p, s.assetId);
    if (!access(p, a).manage) throw new ForbiddenError();
    await tx.update(pmSchedules).set({ active }).where(eq(pmSchedules.id, id));
    await auditAs(tx, ctx, active ? "pm.schedule_resumed" : "pm.schedule_paused", "asset", a.id, { active: s.active }, { active, schedule: s.title });
  });
}

const todayIn = (tz: string, d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);

// opens the work order for one occurrence and moves the schedule on (inside the caller's transaction)
async function openPmWorkOrder(tx: Tx, s: PmRow, a: AssetRow, dueOn: string, nextDueOn: string, actor: TenantCtx | null) {
  const [pr] = await tx.select({ tz: properties.timezone }).from(properties).where(eq(properties.id, a.propertyId));
  // an assignment is applied only if it's still valid (vendor approved here, staff member active)
  let vendorId: string | null = null;
  let membershipId: string | null = null;
  try { await validateAssignees(tx, s.orgId, a.propertyId, { assignVendorId: s.assignVendorId, assignMembershipId: null }); vendorId = s.assignVendorId; } catch { /* stale vendor */ }
  try { await validateAssignees(tx, s.orgId, a.propertyId, { assignVendorId: null, assignMembershipId: s.assignMembershipId }); membershipId = s.assignMembershipId; } catch { /* stale member */ }
  const number = await nextNumber(tx, s.orgId, "work_order");
  const assigned = !!(vendorId || membershipId);
  const [wo] = await tx.insert(workOrders).values({
    orgId: s.orgId, number, propertyId: a.propertyId, buildingId: a.buildingId, unitId: a.unitId, area: a.location,
    category: woCategoryForAsset(a.category), priority: s.priority, title: `${s.title} — ${a.name}`,
    description: [s.instructions, `Preventive maintenance due ${dueOn}.`].filter(Boolean).join("\n\n"),
    status: assigned ? "assigned" : "new", source: "system", submittedByUserId: actor?.principal.userId ?? null,
    assignedMembershipId: membershipId, vendorId, resolveDueAt: zonedToUtc(`${dueOn}T23:59`, pr.tz),
    sourceType: "pm_schedule", sourceId: s.id, assetId: a.id,
  }).returning();
  const who = { orgId: s.orgId, userId: actor?.principal.userId ?? null };
  await addTimeline(tx, who, { entityType: "work_order", entityId: wo.id, kind: "created", toStatus: "new", visibility: "public", body: `Request #${number} opened from the preventive maintenance schedule “${s.title}”.` });
  if (assigned) await addTimeline(tx, who, { entityType: "work_order", entityId: wo.id, kind: "assigned", fromStatus: "new", toStatus: "assigned", visibility: "vendor", body: "Assigned by the maintenance schedule." });
  await tx.update(pmSchedules).set({ nextDueOn, lastGeneratedAt: new Date(), lastWorkOrderId: wo.id }).where(eq(pmSchedules.id, s.id));
  const send = (type: string, payload: Record<string, unknown>) => (actor ? emit(tx, actor, type, payload) : emitSystem(tx, s.orgId, type, payload));
  await send("workorder.created", { workOrderId: wo.id });
  if (assigned) await send("workorder.assigned", { workOrderId: wo.id, membershipId, vendorId });
  return wo;
}

// "create the work order now" from the asset page, for the schedule's next occurrence
export async function generatePmNow(ctx: TenantCtx, scheduleId: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [s] = await tx.select().from(pmSchedules).where(and(eq(pmSchedules.id, scheduleId), eq(pmSchedules.orgId, p.orgId))).for("update");
    if (!s) throw new NotFoundError();
    const a = await loadAsset(tx, p, s.assetId);
    if (!access(p, a).manage) throw new ForbiddenError();
    if (!s.active) throw new ValidationError("Resume the schedule first.");
    const wo = await openPmWorkOrder(tx, s, a, s.nextDueOn, addInterval(s.nextDueOn, s.intervalUnit as IntervalUnit, s.intervalCount), ctx);
    await auditAs(tx, ctx, "pm.generated", "work_order", wo.id, undefined, { scheduleId, dueOn: s.nextDueOn });
    return wo;
  });
}

// worker job: opens work orders for schedules entering their lead window; idempotent under concurrent workers
export async function generatePreventiveMaintenance(now = new Date()): Promise<number> {
  const candidates = await withContext({ system: true }, (tx) => tx.select({ id: pmSchedules.id, orgId: pmSchedules.orgId }).from(pmSchedules)
    .innerJoin(assets, eq(assets.id, pmSchedules.assetId))
    .where(and(eq(pmSchedules.active, true), sql`${assets.status} <> 'retired'`, lte(sql`${pmSchedules.nextDueOn} - ${pmSchedules.leadDays}`, sql`(${now.toISOString()}::timestamptz at time zone 'UTC')::date + 1`)))
    .limit(200));
  let created = 0;
  for (const c of candidates) {
    await withContext({ orgId: c.orgId, system: true }, async (tx) => {
      const locked = await tx.execute(sql`select id from pm_schedules where id = ${c.id} and active for update skip locked`);
      if (!locked.rows.length) return;
      const [s] = await tx.select().from(pmSchedules).where(eq(pmSchedules.id, c.id));
      const [a] = await tx.select().from(assets).where(eq(assets.id, s.assetId));
      const [pr] = await tx.select({ tz: properties.timezone }).from(properties).where(eq(properties.id, a.propertyId));
      const plan = planGeneration({ nextDueOn: s.nextDueOn, intervalUnit: s.intervalUnit as IntervalUnit, intervalCount: s.intervalCount, leadDays: s.leadDays }, todayIn(pr.tz, now));
      if (!plan) return;
      await openPmWorkOrder(tx, s, a, plan.dueOn, plan.nextDueOn, null);
      created++;
    });
  }
  return created;
}

/* ───────────── facility dashboard ───────────── */

export async function facilityStats(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!canReadAssets(p)) return null;
  return tenantTx(ctx, async (tx) => {
    const [byStatus] = await tx.select({
      total: sql<number>`count(*) filter (where ${assets.status} <> 'retired')::int`,
      down: sql<number>`count(*) filter (where ${assets.status} = 'down')::int`,
      attention: sql<number>`count(*) filter (where ${assets.status} = 'needs_attention')::int`,
      criticalDown: sql<number>`count(*) filter (where ${assets.status} = 'down' and ${assets.criticality} in ('high','critical'))::int`,
    }).from(assets).where(and(eq(assets.orgId, p.orgId), scoped(p)));
    const visibleAssets = tx.select({ id: assets.id }).from(assets).where(and(eq(assets.orgId, p.orgId), scoped(p)));
    const [pm] = await tx.select({
      dueSoon: sql<number>`count(*) filter (where ${pmSchedules.nextDueOn} <= current_date + 14)::int`,
      active: sql<number>`count(*)::int`,
    }).from(pmSchedules).where(and(eq(pmSchedules.orgId, p.orgId), eq(pmSchedules.active, true), inArray(pmSchedules.assetId, visibleAssets)));
    const [pmWo] = await tx.select({
      open: sql<number>`count(*) filter (where ${workOrders.status} in ('new','acknowledged','assigned','scheduled','in_progress','awaiting_vendor','awaiting_resident'))::int`,
      overdue: sql<number>`count(*) filter (where ${workOrders.status} in ('new','acknowledged','assigned','scheduled','in_progress','awaiting_vendor','awaiting_resident') and ${workOrders.resolveDueAt} < now())::int`,
      done30: sql<number>`count(*) filter (where ${workOrders.status} in ('completed','closed') and ${workOrders.completedAt} > now() - interval '30 days')::int`,
    }).from(workOrders).where(and(eq(workOrders.orgId, p.orgId), eq(workOrders.sourceType, "pm_schedule"), inArray(workOrders.assetId, visibleAssets)));
    const [dt] = (await tx.execute(sql`select coalesce(sum(extract(epoch from (coalesce(d.ended_at, now()) - greatest(d.started_at, now() - interval '30 days'))) / 3600), 0)::float as hours
      from asset_downtime d where d.org_id = ${p.orgId} and coalesce(d.ended_at, now()) > now() - interval '30 days'
      and d.asset_id in (select a.id from assets a where a.org_id = ${p.orgId} and ${scopeCondition(p, { property: sql`a.property_id`, building: sql`a.building_id` }) ?? sql`true`})`)).rows as { hours: number }[];
    const repeat = await tx.select({
      id: assets.id, name: assets.name, propertyName: properties.name,
      count: sql<number>`count(${workOrders.id})::int`, cost: sql<number>`coalesce(sum(${workOrders.cost}), 0)::float`,
    }).from(assets).innerJoin(properties, eq(properties.id, assets.propertyId))
      .innerJoin(workOrders, and(eq(workOrders.assetId, assets.id), sql`coalesce(${workOrders.sourceType}, '') <> 'pm_schedule'`, gt(workOrders.createdAt, sql`now() - interval '90 days'`)))
      .where(and(eq(assets.orgId, p.orgId), scoped(p))).groupBy(assets.id, properties.name)
      .having(sql`count(${workOrders.id}) >= 3`).orderBy(desc(sql`count(${workOrders.id})`)).limit(5);
    const upcoming = await tx.select({ id: pmSchedules.id, title: pmSchedules.title, nextDueOn: pmSchedules.nextDueOn, assetId: assets.id, assetName: assets.name, propertyName: properties.name })
      .from(pmSchedules).innerJoin(assets, eq(assets.id, pmSchedules.assetId)).innerJoin(properties, eq(properties.id, assets.propertyId))
      .where(and(eq(pmSchedules.orgId, p.orgId), eq(pmSchedules.active, true), scoped(p))).orderBy(asc(pmSchedules.nextDueOn)).limit(6);
    const outOfService = await tx.select({ id: assets.id, name: assets.name, propertyName: properties.name, criticality: assets.criticality, since: assetDowntime.startedAt, reason: assetDowntime.reason })
      .from(assets).innerJoin(properties, eq(properties.id, assets.propertyId))
      .leftJoin(assetDowntime, and(eq(assetDowntime.assetId, assets.id), isNull(assetDowntime.endedAt)))
      .where(and(eq(assets.orgId, p.orgId), eq(assets.status, "down"), scoped(p))).orderBy(asc(assetDowntime.startedAt)).limit(10);
    return { ...byStatus, pmDueSoon: pm.dueSoon, pmActive: pm.active, pmOpen: pmWo.open, pmOverdue: pmWo.overdue, pmDone30: pmWo.done30, downtimeHours30d: dt.hours, repeat, upcoming, outOfService };
  });
}

// assets and staff for pickers on the asset pages
export async function assetFormOptions(ctx: TenantCtx) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const bs = await tx.select({ id: buildings.id, name: buildings.name, propertyId: properties.id, propertyName: properties.name }).from(buildings)
      .innerJoin(properties, eq(properties.id, buildings.propertyId))
      .where(and(eq(buildings.orgId, p.orgId), scopeCondition(p, { property: buildings.propertyId, building: buildings.id }) ?? sql`true`))
      .orderBy(asc(properties.name), asc(buildings.name));
    const props = [...new Map(bs.map((b) => [b.propertyId, { id: b.propertyId, name: b.propertyName }])).values()].filter((x) => can(p, "asset.manage", { orgId: p.orgId, propertyId: x.id }));
    const vend = await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(and(eq(vendors.orgId, p.orgId), eq(vendors.status, "active"))).orderBy(asc(vendors.name));
    const staff = await tx.select({ id: memberships.id, name: users.name }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId)).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, p.orgId), eq(memberships.status, "active"), eq(roles.category, "staff"), isNull(memberships.vendorId),
        sql`${roles.permissions} && array['workorder.manage','workorder.read.assigned']::text[]`)).orderBy(asc(users.name));
    return { properties: props, buildings: bs.filter((b) => can(p, "asset.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId: b.id })), vendors: vend, staff };
  });
}
