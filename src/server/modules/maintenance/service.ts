import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  assets, buildings, files, membershipScopes, memberships, properties, roles, slaPolicies, triageRules, units, users,
  vendorProperties, vendors, workOrders,
} from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { addTimeline, emit, listTimeline, nextNumber, type Visibility } from "../ops/core";
import { closeDowntimeForWorkOrderTx, openDowntimeTx } from "../assets/service";
import { onCallFor } from "../shifts/service";
import { BRAND } from "@/config/brand";
import {
  allowedTransitions, dueDates, evaluateTriage, isOpen, OPEN_STATUSES, PRIORITY_ORDER, slaFor, WO_CATEGORIES,
  type Priority, type TriageRule, type WoActor, type WoStatus,
} from "./rules";

const optText = (max = 2000) => z.string().trim().max(max).optional().transform(blankToNull);
const checkbox = z.union([z.literal("on"), z.literal(""), z.literal("true"), z.literal("false")]).optional().transform((v) => v === "on" || v === "true");

/* ───────────── access model ───────────── */

export type WoAccess = { manage: boolean; staff: boolean; worker: boolean; requester: boolean };
type WoRow = typeof workOrders.$inferSelect;

export function woAccess(p: Principal, wo: Pick<WoRow, "orgId" | "propertyId" | "buildingId" | "unitId" | "assignedMembershipId" | "vendorId" | "submittedByUserId" | "residentId">): WoAccess {
  const res = { orgId: wo.orgId, propertyId: wo.propertyId, buildingId: wo.buildingId };
  const assignedToMe = p.permissions.has("workorder.read.assigned") &&
    ((!!wo.assignedMembershipId && wo.assignedMembershipId === p.membershipId) || (!!p.vendorId && wo.vendorId === p.vendorId));
  const mine = p.permissions.has("workorder.read.own") &&
    (wo.submittedByUserId === p.userId || (!!p.residentId && wo.residentId === p.residentId));
  return {
    manage: wo.orgId === p.orgId && can(p, "workorder.manage", res),
    staff: wo.orgId === p.orgId && can(p, "workorder.read", res),
    worker: wo.orgId === p.orgId && assignedToMe,
    requester: wo.orgId === p.orgId && mine,
  };
}

export const canSeeWo = (a: WoAccess) => a.manage || a.staff || a.worker || a.requester;

// timeline/file visibility levels for a viewer
export function visibleLevels(a: WoAccess): Visibility[] {
  if (a.staff || a.manage) return ["public", "vendor", "internal"];
  if (a.worker) return ["public", "vendor"];
  return ["public"];
}

function actorFor(a: WoAccess): WoActor | null {
  if (a.manage) return "manager";
  if (a.worker) return "worker";
  if (a.requester) return "requester";
  return null;
}

// SQL predicate for the work orders a principal may list
export function woVisibleWhere(p: Principal): SQL {
  const parts: (SQL | undefined)[] = [];
  if (p.permissions.has("workorder.read")) parts.push(scopeCondition(p, { property: workOrders.propertyId, building: workOrders.buildingId }) ?? sql`true`);
  if (p.permissions.has("workorder.read.assigned")) {
    parts.push(eq(workOrders.assignedMembershipId, p.membershipId));
    if (p.vendorId) parts.push(eq(workOrders.vendorId, p.vendorId));
  }
  if (p.permissions.has("workorder.read.own")) {
    parts.push(eq(workOrders.submittedByUserId, p.userId));
    if (p.residentId) parts.push(eq(workOrders.residentId, p.residentId));
  }
  return or(...parts.filter(Boolean)) ?? sql`false`;
}

export const canListWorkOrders = (p: Principal) =>
  ["workorder.read", "workorder.read.assigned", "workorder.read.own", "workorder.create"].some((x) => p.permissions.has(x));

/* ───────────── list ───────────── */

export type WoView = "open" | "overdue" | "emergency" | "unassigned" | "mine" | "completed" | "all";

export type WoListRow = {
  id: string; number: number; title: string; status: string; priority: string; isEmergency: boolean; category: string;
  propertyName: string; buildingName: string | null; unitNumber: string | null; area: string | null;
  assigneeName: string | null; vendorName: string | null; resolveDueAt: Date | null; createdAt: Date; overdue: boolean;
};

export type WoListOpts = { view?: WoView; status?: string; propertyId?: string; buildingId?: string; unitId?: string; category?: string; priority?: string; vendorId?: string; q?: string; page?: number; pageSize?: number };

// the filter behind the work order list (and its per-property counts): visibility first, then the requested view
function woListWhere(p: Principal, opts: WoListOpts, now: Date): SQL | undefined {
  const view = opts.view ?? "open";
  const viewCond: Record<WoView, SQL | undefined> = {
    open: inArray(workOrders.status, OPEN_STATUSES),
    overdue: and(inArray(workOrders.status, OPEN_STATUSES), lt(workOrders.resolveDueAt, now)),
    emergency: and(inArray(workOrders.status, OPEN_STATUSES), eq(workOrders.isEmergency, true)),
    unassigned: and(inArray(workOrders.status, OPEN_STATUSES), isNull(workOrders.assignedMembershipId), isNull(workOrders.vendorId)),
    mine: and(inArray(workOrders.status, OPEN_STATUSES), or(eq(workOrders.assignedMembershipId, p.membershipId), p.vendorId ? eq(workOrders.vendorId, p.vendorId) : undefined)),
    completed: inArray(workOrders.status, ["completed", "closed"]),
    all: undefined,
  };
  const q = opts.q?.trim();
  const num = q ? Number(q.replace(/^wo-?/i, "")) : NaN;
  return and(
    eq(workOrders.orgId, p.orgId),
    woVisibleWhere(p),
    viewCond[view],
    opts.status ? eq(workOrders.status, opts.status) : undefined,
    opts.propertyId ? eq(workOrders.propertyId, opts.propertyId) : undefined,
    opts.buildingId ? eq(workOrders.buildingId, opts.buildingId) : undefined,
    opts.unitId ? eq(workOrders.unitId, opts.unitId) : undefined,
    opts.category ? eq(workOrders.category, opts.category) : undefined,
    opts.priority ? eq(workOrders.priority, opts.priority) : undefined,
    opts.vendorId ? eq(workOrders.vendorId, opts.vendorId) : undefined,
    q ? (Number.isInteger(num) && num > 0 ? eq(workOrders.number, num) : ilike(workOrders.title, `%${q.replace(/[%_\\]/g, "\\$&")}%`)) : undefined,
  );
}

export async function listWorkOrders(ctx: TenantCtx, opts: WoListOpts): Promise<Page<WoListRow>> {
  const p = ctx.principal;
  if (!canListWorkOrders(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page, opts.pageSize);
  const now = new Date();
  return tenantTx(ctx, async (tx) => {
    const where = woListWhere(p, opts, now);
    const [{ n }] = await tx.select({ n: count() }).from(workOrders).where(where);
    const rows = await tx
      .select({
        id: workOrders.id, number: workOrders.number, title: workOrders.title, status: workOrders.status, priority: workOrders.priority,
        isEmergency: workOrders.isEmergency, category: workOrders.category, area: workOrders.area,
        propertyName: properties.name, buildingName: buildings.name, unitNumber: units.number,
        assigneeName: users.name, vendorName: vendors.name, resolveDueAt: workOrders.resolveDueAt, createdAt: workOrders.createdAt,
      })
      .from(workOrders)
      .innerJoin(properties, eq(properties.id, workOrders.propertyId))
      .leftJoin(buildings, eq(buildings.id, workOrders.buildingId))
      .leftJoin(units, eq(units.id, workOrders.unitId))
      .leftJoin(memberships, eq(memberships.id, workOrders.assignedMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .leftJoin(vendors, eq(vendors.id, workOrders.vendorId))
      .where(where)
      .orderBy(desc(workOrders.isEmergency), sql`case ${workOrders.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`, asc(workOrders.resolveDueAt), desc(workOrders.createdAt))
      .limit(pageSize)
      .offset(offset);
    return toPage(rows.map((r) => ({ ...r, overdue: isOpen(r.status) && !!r.resolveDueAt && r.resolveDueAt < now })), n, page, pageSize);
  });
}

// how the same list splits by property (for summaries such as "17 overdue: Fraser Towers 9, Harbour Centre 5…")
export async function workOrderCountsByProperty(ctx: TenantCtx, opts: WoListOpts): Promise<{ property: string; n: number }[]> {
  const p = ctx.principal;
  if (!canListWorkOrders(p)) throw new ForbiddenError();
  return tenantTx(ctx, (tx) =>
    tx.select({ property: properties.name, n: count() }).from(workOrders).innerJoin(properties, eq(properties.id, workOrders.propertyId))
      .where(woListWhere(p, opts, new Date())).groupBy(properties.name).orderBy(desc(count()), asc(properties.name)),
  );
}

/* ───────────── detail ───────────── */

async function loadWo(tx: Tx, orgId: string, id: string) {
  const [wo] = await tx.select().from(workOrders).where(and(eq(workOrders.id, id), eq(workOrders.orgId, orgId)));
  if (!wo) throw new NotFoundError();
  return wo;
}

export async function getWorkOrder(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const wo = await loadWo(tx, p.orgId, id);
    const access = woAccess(p, wo);
    if (!canSeeWo(access)) throw new NotFoundError();
    const [labels] = await tx
      .select({ propertyName: properties.name, buildingName: buildings.name, unitNumber: units.number })
      .from(properties).leftJoin(buildings, eq(buildings.id, sql`${wo.buildingId}`)).leftJoin(units, eq(units.id, sql`${wo.unitId}`))
      .where(eq(properties.id, wo.propertyId));
    const [submitter] = wo.submittedByUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, wo.submittedByUserId)) : [];
    const [assignee] = wo.assignedMembershipId
      ? await tx.select({ name: users.name, membershipId: memberships.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.id, wo.assignedMembershipId))
      : [];
    const [vendor] = wo.vendorId ? await tx.select({ id: vendors.id, name: vendors.name, phone: vendors.phone }).from(vendors).where(eq(vendors.id, wo.vendorId)) : [];
    // the linked asset is shown to people who can work the job, not to residents
    const [asset] = wo.assetId && (access.manage || access.staff || access.worker)
      ? await tx.select({ id: assets.id, name: assets.name, status: assets.status }).from(assets).where(eq(assets.id, wo.assetId)) : [];
    const levels = visibleLevels(access);
    const timeline = await listTimeline(tx, p.orgId, "work_order", id, levels);
    const attachments = await tx.select().from(files)
      .where(and(eq(files.orgId, p.orgId), eq(files.entityType, "work_order"), eq(files.entityId, id), inArray(files.visibility, levels)))
      .orderBy(asc(files.createdAt));
    const actor = actorFor(access);
    // residents don't see staff contact details beyond names; vendors see the unit and entry notes
    const showEntry = access.manage || access.staff || access.worker;
    return {
      workOrder: { ...wo, entryNotes: showEntry ? wo.entryNotes : null },
      labels, submitterName: submitter?.name ?? null, assignee: assignee ?? null, vendor: vendor ?? null, asset: asset ?? null,
      timeline, attachments, access,
      transitions: actor ? allowedTransitions(wo.status as WoStatus, actor) : [],
      commentLevels: (access.manage || access.staff ? ["public", "vendor", "internal"] : access.worker ? ["public", "vendor"] : ["public"]) as Visibility[],
      assignOptions: access.manage ? await assignOptions(tx, p.orgId, wo.propertyId) : null,
    };
  });
}

// staff whose access covers the property, and active vendors approved for it
async function assignOptions(tx: Tx, orgId: string, propertyId: string) {
  const staff = await tx
    .selectDistinct({ membershipId: memberships.id, name: users.name, role: roles.name })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId)).innerJoin(roles, eq(roles.id, memberships.roleId))
    .leftJoin(membershipScopes, eq(membershipScopes.membershipId, memberships.id))
    .where(and(
      eq(memberships.orgId, orgId), eq(memberships.status, "active"), eq(roles.category, "staff"),
      sql`('workorder.read' = any(${roles.permissions}) or 'workorder.read.assigned' = any(${roles.permissions}))`,
      or(eq(roles.scopeLevel, "org"), eq(membershipScopes.propertyId, propertyId),
        sql`${membershipScopes.portfolioId} = (select portfolio_id from properties where id = ${propertyId})`,
        sql`${membershipScopes.buildingId} in (select id from buildings where property_id = ${propertyId})`),
    ))
    .orderBy(asc(users.name));
  const vend = await tx.select({ id: vendors.id, name: vendors.name, categories: vendors.categories }).from(vendors)
    .innerJoin(vendorProperties, eq(vendorProperties.vendorId, vendors.id))
    .where(and(eq(vendors.orgId, orgId), eq(vendors.status, "active"), eq(vendorProperties.propertyId, propertyId)))
    .orderBy(asc(vendors.name));
  return { staff, vendors: vend };
}

/* ───────────── previews for the assistant (read-only) ───────────── */

// who the principal may assign at a property: staff whose scope covers it and approved, active vendors
export async function assignmentOptions(ctx: TenantCtx, propertyId: string) {
  const p = ctx.principal;
  authorize(p, "workorder.manage", { orgId: p.orgId, propertyId });
  return tenantTx(ctx, (tx) => assignOptions(tx, p.orgId, propertyId));
}

// what the configured triage rules would do with a new request, without creating it
export async function triagePreview(ctx: TenantCtx, input: { propertyId: string; title: string; description: string; category: string }) {
  return tenantTx(ctx, async (tx) => {
    const t = evaluateTriage(await loadTriageRules(tx, ctx.principal.orgId, input.propertyId), `${input.title} ${input.description}`, input.category, input.propertyId);
    return { isEmergency: t.isEmergency, priority: t.priority, category: t.category, rules: t.matched.map((m) => m.name), instructions: t.instructions };
  });
}

/* ───────────── create ───────────── */

export const createWoSchema = z.object({
  title: z.string().trim().min(3, "Describe the problem in a few words.").max(160),
  description: z.string().trim().max(5000).default(""),
  category: z.enum(WO_CATEGORIES),
  priority: z.union([z.literal(""), z.enum(PRIORITY_ORDER)]).optional().transform((v) => (v ? v : null)),
  isEmergency: checkbox,
  unitId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  buildingId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  unitNumber: optText(20),
  propertyId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  area: optText(120),
  permissionToEnter: checkbox,
  entryNotes: optText(500),
  assetId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null), // staff: equipment involved
  assetDown: checkbox, // staff: the equipment is out of service
});
// asset fields are optional for internal callers (inspections, bookings, tests)
export type CreateWoInput = Omit<z.infer<typeof createWoSchema>, "assetId" | "assetDown"> & { assetId?: string | null; assetDown?: boolean };

export async function loadTriageRules(tx: Tx, orgId: string, propertyId: string): Promise<TriageRule[]> {
  return tx.select().from(triageRules).where(and(eq(triageRules.orgId, orgId), eq(triageRules.active, true), or(isNull(triageRules.propertyId), eq(triageRules.propertyId, propertyId))));
}

async function loadSla(tx: Tx, orgId: string, propertyId: string, priority: Priority) {
  const rows = await tx.select().from(slaPolicies).where(and(eq(slaPolicies.orgId, orgId), or(isNull(slaPolicies.propertyId), eq(slaPolicies.propertyId, propertyId))));
  return slaFor(rows, propertyId, priority);
}

// resolve where the issue is: a unit (by id, or building + number), a building area, or a property area
async function resolveLocation(tx: Tx, p: Principal, input: CreateWoInput) {
  if (input.unitId || (input.buildingId && input.unitNumber)) {
    const [u] = await tx.select().from(units).where(and(
      eq(units.orgId, p.orgId),
      input.unitId ? eq(units.id, input.unitId) : and(eq(units.buildingId, input.buildingId!), sql`lower(${units.number}) = lower(${input.unitNumber})`),
    ));
    if (!u) throw new ValidationError("Unit not found.", input.unitId ? "unitId" : "unitNumber");
    return { propertyId: u.propertyId, buildingId: u.buildingId, unitId: u.id };
  }
  if (input.buildingId) {
    const [b] = await tx.select().from(buildings).where(and(eq(buildings.orgId, p.orgId), eq(buildings.id, input.buildingId)));
    if (!b) throw new ValidationError("Building not found.", "buildingId");
    return { propertyId: b.propertyId, buildingId: b.id, unitId: null };
  }
  if (input.propertyId) {
    const [pr] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.orgId, p.orgId), eq(properties.id, input.propertyId)));
    if (!pr) throw new ValidationError("Property not found.", "propertyId");
    return { propertyId: pr.id, buildingId: null, unitId: null };
  }
  throw new ValidationError("Choose where the problem is.", "buildingId");
}

export type CreateWoResult = { workOrder: WoRow; instructions: string[]; matchedRules: string[] };

export async function createWorkOrder(ctx: TenantCtx, input: CreateWoInput, opts: { source?: WoRow["source"]; sourceType?: string; sourceId?: string } = {}): Promise<CreateWoResult> {
  const p = ctx.principal;
  if (!p.permissions.has("workorder.create")) throw new ForbiddenError();
  const isResident = p.role.category === "resident";
  return tenantTx(ctx, async (tx) => {
    // equipment: staff only; with no other location given, the asset's own location is used
    const [asset] = input.assetId && !isResident ? await tx.select().from(assets).where(and(eq(assets.orgId, p.orgId), eq(assets.id, input.assetId))) : [];
    if (input.assetId && !isResident && !asset) throw new ValidationError("Asset not found.", "assetId");
    const located = asset && !input.unitId && !input.buildingId && !input.propertyId ? { ...input, propertyId: asset.propertyId, buildingId: asset.buildingId } : input;
    const loc = await resolveLocation(tx, p, located);
    if (asset && asset.propertyId !== loc.propertyId) throw new ValidationError("That asset is at a different property.", "assetId");
    if (isResident) {
      // residents report issues in their own unit only
      if (!loc.unitId || !p.unitIds.has(loc.unitId)) throw new ForbiddenError("You can only submit requests for your own unit.");
    } else {
      authorize(p, "workorder.create", { orgId: p.orgId, propertyId: loc.propertyId, buildingId: loc.buildingId });
    }
    // configured rules decide triage; residents can't choose priority, staff choices win over rules
    const triage = evaluateTriage(await loadTriageRules(tx, p.orgId, loc.propertyId), `${input.title} ${input.description}`, input.category, loc.propertyId);
    const isEmergency = input.isEmergency || triage.isEmergency;
    const staffPriority = isResident ? null : input.priority;
    const priority: Priority = isEmergency ? "urgent" : staffPriority ?? triage.priority ?? "normal";
    const category = triage.category && input.category === "general" ? triage.category : input.category;
    const now = new Date();
    const due = dueDates(now, await loadSla(tx, p.orgId, loc.propertyId, priority));
    const number = await nextNumber(tx, p.orgId, "work_order");

    // rule-based default assignment, only if still valid for this property
    let assignMembershipId: string | null = null;
    let assignVendorId: string | null = null;
    if (triage.assignMembershipId || triage.assignVendorId) {
      const opts2 = await assignOptions(tx, p.orgId, loc.propertyId);
      if (triage.assignMembershipId && opts2.staff.some((s) => s.membershipId === triage.assignMembershipId)) assignMembershipId = triage.assignMembershipId;
      if (triage.assignVendorId && opts2.vendors.some((v) => v.id === triage.assignVendorId)) assignVendorId = triage.assignVendorId;
    }
    // emergencies nobody was assigned to go to whoever is on call at the property right now
    const onCall = isEmergency && !assignMembershipId && !assignVendorId ? await onCallFor(tx, p.orgId, loc.propertyId, loc.buildingId) : null;
    if (onCall) assignMembershipId = onCall.membershipId;
    const assigned = !!(assignMembershipId || assignVendorId);
    const [wo] = await tx.insert(workOrders).values({
      orgId: p.orgId, number, ...loc, area: input.area, category, priority, isEmergency, title: input.title, description: input.description,
      status: assigned ? "assigned" : "new", source: opts.source ?? (isResident ? "resident" : "staff"),
      submittedByUserId: p.userId, residentId: isResident ? p.residentId : null,
      assignedMembershipId: assignMembershipId, vendorId: assignVendorId,
      permissionToEnter: input.permissionToEnter, entryNotes: input.entryNotes,
      respondDueAt: due.respondDueAt, resolveDueAt: due.resolveDueAt,
      triageRuleId: triage.matched[0]?.id ?? null, sourceType: opts.sourceType ?? null, sourceId: opts.sourceId ?? null,
      assetId: asset?.id ?? null,
    }).returning();
    await addTimeline(tx, ctx, { entityType: "work_order", entityId: wo.id, kind: "created", toStatus: "new", visibility: "public",
      body: ctx.ai ? `Request #${number} submitted with ${BRAND.assistantName}.` : `Request #${number} submitted.` });
    if (triage.matched.length) {
      await addTimeline(tx, ctx, { entityType: "work_order", entityId: wo.id, kind: "rule", visibility: "internal",
        body: `Triage rules applied: ${triage.matched.map((m) => m.name).join(", ")} → priority ${priority}${isEmergency ? ", emergency" : ""}.` });
    }
    // configured guidance for the requester (e.g. "shut off the valve under the sink") stays on the record
    if (triage.instructions.length) await addTimeline(tx, ctx, { entityType: "work_order", entityId: wo.id, kind: "guidance", visibility: "public", body: triage.instructions.join("\n") });
    if (assigned) await addTimeline(tx, ctx, { entityType: "work_order", entityId: wo.id, kind: "assigned", fromStatus: "new", toStatus: "assigned", visibility: "vendor",
      body: onCall ? `Emergency assigned to ${onCall.name}, on call for this property.` : "Assigned automatically by triage rule." });
    if (asset && input.assetDown) {
      const d = await openDowntimeTx(tx, asset, input.title, p.userId, wo.id);
      if (d) await emit(tx, ctx, "asset.down", { assetId: asset.id, reason: input.title, workOrderId: wo.id });
    }
    await auditAs(tx, ctx, "work_order.created", "work_order", wo.id, undefined, wo);
    await emit(tx, ctx, "workorder.created", { workOrderId: wo.id });
    if (assigned) await emit(tx, ctx, "workorder.assigned", { workOrderId: wo.id, membershipId: assignMembershipId, vendorId: assignVendorId });
    return { workOrder: wo, instructions: triage.instructions, matchedRules: triage.matched.map((m) => m.name) };
  });
}

/* ───────────── updates ───────────── */

export const transitionSchema = z.object({
  to: z.enum(["new", "acknowledged", "assigned", "scheduled", "in_progress", "awaiting_vendor", "awaiting_resident", "completed", "closed", "cancelled"]),
  note: optText(2000),
  cost: z.union([z.literal(""), z.coerce.number().min(0).max(10_000_000)]).optional().transform((v) => (v === "" || v === undefined ? null : v.toFixed(2))),
  resolutionNotes: optText(4000),
});

const STATUS_LABEL: Record<string, string> = {
  new: "New", acknowledged: "Acknowledged", assigned: "Assigned", scheduled: "Scheduled", in_progress: "In progress",
  awaiting_vendor: "Awaiting vendor", awaiting_resident: "Awaiting resident", completed: "Completed", closed: "Closed", cancelled: "Cancelled",
};
export const woStatusLabel = (s: string) => STATUS_LABEL[s] ?? s;

export async function transitionWorkOrder(ctx: TenantCtx, id: string, input: z.infer<typeof transitionSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const before = await loadWo(tx, p.orgId, id);
    const access = woAccess(p, before);
    if (!canSeeWo(access)) throw new NotFoundError();
    const actor = actorFor(access);
    const to = input.to as WoStatus;
    if (!actor || !allowedTransitions(before.status as WoStatus, actor).includes(to)) {
      throw new ForbiddenError(`You can't move this request from ${woStatusLabel(before.status)} to ${woStatusLabel(to)}.`);
    }
    if (to === "completed" && actor !== "requester" && !input.resolutionNotes && !before.resolutionNotes) {
      throw new ValidationError("Add resolution notes describing what was done.", "resolutionNotes");
    }
    const now = new Date();
    const patch: Partial<WoRow> = { status: to };
    if (!before.firstResponseAt && actor !== "requester" && to !== "cancelled") patch.firstResponseAt = now;
    if (to === "completed") { patch.completedAt = now; if (input.resolutionNotes) patch.resolutionNotes = input.resolutionNotes; if (input.cost !== null) patch.cost = input.cost; }
    if (to === "closed") patch.closedAt = now;
    if (to === "cancelled") patch.cancelledAt = now;
    if (to === "in_progress" && (before.status === "completed" || before.status === "closed")) { patch.completedAt = null; patch.closedAt = null; }
    const [after] = await tx.update(workOrders).set(patch).where(eq(workOrders.id, id)).returning();
    // finishing the job brings linked equipment back into service
    if (before.assetId && ["completed", "closed", "cancelled"].includes(to)) await closeDowntimeForWorkOrderTx(tx, id, p.userId);
    const body = [input.note, to === "completed" && input.resolutionNotes ? `Resolution: ${input.resolutionNotes}` : null].filter(Boolean).join("\n") || null;
    await addTimeline(tx, ctx, { entityType: "work_order", entityId: id, kind: "status", fromStatus: before.status, toStatus: to, body, visibility: "public" });
    await auditAs(tx, ctx, "work_order.status_changed", "work_order", id, { status: before.status }, { status: to, cost: after.cost });
    await emit(tx, ctx, "workorder.status_changed", { workOrderId: id, from: before.status, to });
    return after;
  });
}

export const assignSchema = z.object({
  membershipId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  vendorId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
});

export async function assignWorkOrder(ctx: TenantCtx, id: string, input: z.infer<typeof assignSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const before = await loadWo(tx, p.orgId, id);
    const access = woAccess(p, before);
    if (!access.manage) throw canSeeWo(access) ? new ForbiddenError() : new NotFoundError();
    if (!isOpen(before.status)) throw new ValidationError("Reopen the request before reassigning it.");
    const opts = await assignOptions(tx, p.orgId, before.propertyId);
    if (input.membershipId && !opts.staff.some((s) => s.membershipId === input.membershipId)) throw new ValidationError("That person can't work at this property.", "membershipId");
    if (input.vendorId && !opts.vendors.some((v) => v.id === input.vendorId)) throw new ValidationError("That vendor isn't active and approved for this property.", "vendorId");
    const status = (["new", "acknowledged"].includes(before.status) && (input.membershipId || input.vendorId)) ? "assigned" : before.status;
    const now = new Date();
    const [after] = await tx.update(workOrders).set({
      assignedMembershipId: input.membershipId, vendorId: input.vendorId, status, firstResponseAt: before.firstResponseAt ?? now,
    }).where(eq(workOrders.id, id)).returning();
    const names = [
      input.membershipId ? opts.staff.find((s) => s.membershipId === input.membershipId)?.name : null,
      input.vendorId ? opts.vendors.find((v) => v.id === input.vendorId)?.name : null,
    ].filter(Boolean).join(" and ");
    await addTimeline(tx, ctx, { entityType: "work_order", entityId: id, kind: "assigned", fromStatus: before.status, toStatus: status, visibility: "vendor", body: names ? `Assigned to ${names}.` : "Unassigned." });
    if (status !== before.status) await addTimeline(tx, ctx, { entityType: "work_order", entityId: id, kind: "status", fromStatus: before.status, toStatus: status, visibility: "public" });
    await auditAs(tx, ctx, "work_order.assigned", "work_order", id, { membershipId: before.assignedMembershipId, vendorId: before.vendorId }, input);
    if ((input.membershipId && input.membershipId !== before.assignedMembershipId) || (input.vendorId && input.vendorId !== before.vendorId)) {
      await emit(tx, ctx, "workorder.assigned", {
        workOrderId: id,
        membershipId: input.membershipId !== before.assignedMembershipId ? input.membershipId : null,
        vendorId: input.vendorId !== before.vendorId ? input.vendorId : null,
      });
    }
    return after;
  });
}

export const scheduleSchema = z.object({
  start: z.string().min(1, "Choose a start time."),
  durationMinutes: z.coerce.number().int().min(15).max(24 * 60).default(120),
  note: optText(500),
});

// visit times are entered in the org's time zone; stored as UTC
export async function scheduleWorkOrder(ctx: TenantCtx, id: string, input: z.infer<typeof scheduleSchema>, startUtc: Date) {
  const p = ctx.principal;
  if (Number.isNaN(startUtc.getTime())) throw new ValidationError("Invalid start time.", "start");
  return tenantTx(ctx, async (tx) => {
    const before = await loadWo(tx, p.orgId, id);
    const access = woAccess(p, before);
    if (!access.manage && !access.worker) throw canSeeWo(access) ? new ForbiddenError() : new NotFoundError();
    const actor = actorFor(access)!;
    const moveToScheduled = before.status !== "scheduled" && allowedTransitions(before.status as WoStatus, actor).includes("scheduled");
    if (!isOpen(before.status)) throw new ValidationError("This request is no longer open.");
    const end = new Date(startUtc.getTime() + input.durationMinutes * 60_000);
    const [after] = await tx.update(workOrders).set({
      scheduledStart: startUtc, scheduledEnd: end, status: moveToScheduled ? "scheduled" : before.status, firstResponseAt: before.firstResponseAt ?? new Date(),
    }).where(eq(workOrders.id, id)).returning();
    const when = startUtc.toLocaleString("en-CA", { timeZone: p.orgTimezone ?? "UTC", dateStyle: "medium", timeStyle: "short" });
    await addTimeline(tx, ctx, { entityType: "work_order", entityId: id, kind: "scheduled", fromStatus: before.status, toStatus: after.status, visibility: "public", body: `Visit scheduled for ${when}.${input.note ? ` ${input.note}` : ""}` });
    await auditAs(tx, ctx, "work_order.scheduled", "work_order", id, { start: before.scheduledStart }, { start: startUtc, end });
    await emit(tx, ctx, "workorder.status_changed", { workOrderId: id, from: before.status, to: after.status, scheduled: startUtc.toISOString() });
    return after;
  });
}

export const commentSchema = z.object({
  body: z.string().trim().min(1, "Write a comment.").max(4000),
  visibility: z.enum(["public", "vendor", "internal"]).default("public"),
});

export async function commentOnWorkOrder(ctx: TenantCtx, id: string, input: z.infer<typeof commentSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const wo = await loadWo(tx, p.orgId, id);
    const access = woAccess(p, wo);
    if (!canSeeWo(access)) throw new NotFoundError();
    // a viewer can only post at levels they can read
    if (!visibleLevels(access).includes(input.visibility)) throw new ForbiddenError("You can't post at that visibility.");
    const ev = await addTimeline(tx, ctx, { entityType: "work_order", entityId: id, kind: "comment", body: input.body, visibility: input.visibility });
    if (input.visibility !== "internal") await emit(tx, ctx, "workorder.commented", { workOrderId: id, eventId: ev.id, visibility: input.visibility });
    return ev;
  });
}

export const detailsSchema = z.object({
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(5000).default(""),
  category: z.enum(WO_CATEGORIES),
  priority: z.enum(PRIORITY_ORDER),
  isEmergency: checkbox,
});

// priority changes recompute SLA targets from the original submission time
export async function updateWorkOrderDetails(ctx: TenantCtx, id: string, input: z.infer<typeof detailsSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const before = await loadWo(tx, p.orgId, id);
    const access = woAccess(p, before);
    if (!access.manage) throw canSeeWo(access) ? new ForbiddenError() : new NotFoundError();
    const priority: Priority = input.isEmergency ? "urgent" : input.priority;
    const due = priority !== before.priority ? dueDates(before.createdAt, await loadSla(tx, p.orgId, before.propertyId, priority)) : null;
    const [after] = await tx.update(workOrders).set({
      title: input.title, description: input.description, category: input.category, priority, isEmergency: input.isEmergency,
      ...(due ? { respondDueAt: due.respondDueAt, resolveDueAt: due.resolveDueAt, slaBreachedAt: null } : {}),
    }).where(eq(workOrders.id, id)).returning();
    const changes = (["title", "category", "priority", "isEmergency"] as const).filter((k) => before[k] !== after[k]).map((k) => `${k} → ${String(after[k])}`);
    if (changes.length) await addTimeline(tx, ctx, { entityType: "work_order", entityId: id, kind: "updated", visibility: "internal", body: `Updated ${changes.join(", ")}.` });
    await auditAs(tx, ctx, "work_order.updated", "work_order", id, before, after);
    return after;
  });
}

/* ───────────── resident helpers ───────────── */

export async function residentUnitsForRequests(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.unitIds.size) return [];
  return tenantTx(ctx, (tx) =>
    tx.select({ id: units.id, number: units.number, building: buildings.name, property: properties.name }).from(units)
      .innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, units.propertyId))
      .where(inArray(units.id, [...p.unitIds])).orderBy(asc(units.number)),
  );
}

