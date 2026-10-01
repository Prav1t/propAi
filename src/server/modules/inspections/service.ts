import "server-only";
import { and, asc, count, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { buildings, inspectionItems, inspections, inspectionTemplates, memberships, properties, units, users, INSPECTION_KINDS } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { addTimeline, emit, listTimeline } from "../ops/core";
import { createWorkOrder } from "../maintenance/service";
import { taskAssignees } from "../tasks/service";
import type { WO_CATEGORIES } from "../maintenance/rules";

type InspRow = typeof inspections.$inferSelect;

/* ───── templates ───── */

// "Section: item" per line; lines without a colon go under "General"
export function parseChecklist(text: string): { section: string; label: string }[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 200).map((l) => {
    const i = l.indexOf(":");
    return i > 0 ? { section: l.slice(0, i).trim().slice(0, 80), label: l.slice(i + 1).trim().slice(0, 200) } : { section: "General", label: l.slice(0, 200) };
  }).filter((x) => x.label);
}

export const templateSchema = z.object({
  name: z.string().trim().min(2, "Name the template.").max(120),
  kind: z.enum(INSPECTION_KINDS),
  items: z.string().max(20_000).transform(parseChecklist).refine((v) => v.length > 0, "Add at least one checklist item."),
  repeatEveryDays: z.union([z.literal(""), z.coerce.number().int().min(1).max(730)]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
});

export async function listTemplates(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.permissions.has("inspection.read") && !p.permissions.has("inspection.manage")) throw new ForbiddenError();
  return tenantTx(ctx, (tx) => tx.select().from(inspectionTemplates).where(and(eq(inspectionTemplates.orgId, p.orgId), eq(inspectionTemplates.active, true))).orderBy(asc(inspectionTemplates.name)));
}

export async function createTemplate(ctx: TenantCtx, input: z.infer<typeof templateSchema>) {
  authorize(ctx.principal, "inspection.manage");
  if (ctx.principal.role.scopeLevel !== "org" && !ctx.principal.permissions.has("workorder.configure")) throw new ForbiddenError("Templates are shared across the organization; ask an admin.");
  return tenantTx(ctx, async (tx) => {
    const [t] = await tx.insert(inspectionTemplates).values({ orgId: ctx.principal.orgId, ...input }).returning();
    await auditAs(tx, ctx, "inspection_template.created", "inspection_template", t.id, undefined, t);
    return t;
  });
}

export async function archiveTemplate(ctx: TenantCtx, id: string) {
  authorize(ctx.principal, "inspection.manage");
  await tenantTx(ctx, async (tx) => {
    const r = await tx.update(inspectionTemplates).set({ active: false }).where(and(eq(inspectionTemplates.id, id), eq(inspectionTemplates.orgId, ctx.principal.orgId))).returning();
    if (!r.length) throw new NotFoundError();
    await auditAs(tx, ctx, "inspection_template.archived", "inspection_template", id);
  });
}

/* ───── inspections ───── */

function access(p: Principal, i: InspRow) {
  const res = { orgId: i.orgId, propertyId: i.propertyId, buildingId: i.buildingId };
  const manage = can(p, "inspection.manage", res);
  const inspector = !!i.inspectorMembershipId && i.inspectorMembershipId === p.membershipId;
  return { manage, read: manage || inspector || can(p, "inspection.read", res), perform: manage || inspector };
}

export type InspectionRow = {
  id: string; title: string; kind: string; status: string; result: string | null; scheduledFor: string; propertyName: string;
  buildingName: string | null; unitNumber: string | null; inspectorName: string | null; failed: number; total: number;
};

export async function listInspections(ctx: TenantCtx, opts: { view?: "upcoming" | "overdue" | "completed" | "all"; propertyId?: string; page?: number }): Promise<Page<InspectionRow>> {
  const p = ctx.principal;
  if (!p.permissions.has("inspection.read") && !p.permissions.has("inspection.manage")) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page);
  const today = new Date().toISOString().slice(0, 10);
  const open = inArray(inspections.status, ["scheduled", "in_progress"]);
  const viewCond = { upcoming: and(open, gte(inspections.scheduledFor, today)), overdue: and(open, lt(inspections.scheduledFor, today)), completed: eq(inspections.status, "completed"), all: undefined }[opts.view ?? "upcoming"];
  return tenantTx(ctx, async (tx) => {
    const where = and(
      eq(inspections.orgId, p.orgId), viewCond, opts.propertyId ? eq(inspections.propertyId, opts.propertyId) : undefined,
      sql`(${scopeCondition(p, { property: inspections.propertyId, building: inspections.buildingId }) ?? sql`true`} or ${inspections.inspectorMembershipId} = ${p.membershipId})`,
    );
    const [{ n }] = await tx.select({ n: count() }).from(inspections).where(where);
    const rows = await tx
      .select({
        id: inspections.id, title: inspections.title, kind: inspections.kind, status: inspections.status, result: inspections.result, scheduledFor: inspections.scheduledFor,
        propertyName: properties.name, buildingName: buildings.name, unitNumber: units.number, inspectorName: users.name,
        failed: sql<number>`(select count(*)::int from inspection_items i where i.inspection_id = inspections.id and i.result = 'fail')`,
        total: sql<number>`(select count(*)::int from inspection_items i where i.inspection_id = inspections.id)`,
      })
      .from(inspections).innerJoin(properties, eq(properties.id, inspections.propertyId))
      .leftJoin(buildings, eq(buildings.id, inspections.buildingId)).leftJoin(units, eq(units.id, inspections.unitId))
      .leftJoin(memberships, eq(memberships.id, inspections.inspectorMembershipId)).leftJoin(users, eq(users.id, memberships.userId))
      .where(where)
      .orderBy(opts.view === "completed" ? desc(inspections.completedAt) : asc(inspections.scheduledFor))
      .limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

export const scheduleInspectionSchema = z.object({
  templateId: z.string().uuid("Choose a template."),
  buildingId: z.string().uuid("Choose a building."),
  unitNumber: z.string().trim().max(20).optional().transform(blankToNull),
  scheduledFor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date."),
  inspectorMembershipId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  title: z.string().trim().max(160).optional().transform(blankToNull),
});

async function insertInspection(tx: Tx, ctx: TenantCtx, t: typeof inspectionTemplates.$inferSelect, loc: { propertyId: string; buildingId: string | null; unitId: string | null; unitNumber?: string | null }, scheduledFor: string, inspector: string | null, title: string | null) {
  const p = ctx.principal;
  const [i] = await tx.insert(inspections).values({
    orgId: p.orgId, templateId: t.id, propertyId: loc.propertyId, buildingId: loc.buildingId, unitId: loc.unitId, kind: t.kind,
    title: title ?? `${t.name}${loc.unitNumber ? ` — Unit ${loc.unitNumber}` : ""}`, scheduledFor, inspectorMembershipId: inspector,
  }).returning();
  if (t.items.length) await tx.insert(inspectionItems).values(t.items.map((it, n) => ({ orgId: p.orgId, inspectionId: i.id, section: it.section, label: it.label, position: n })));
  await addTimeline(tx, ctx, { entityType: "inspection", entityId: i.id, kind: "created", toStatus: "scheduled", body: `Scheduled for ${scheduledFor}.` });
  return i;
}

export async function scheduleInspection(ctx: TenantCtx, input: z.infer<typeof scheduleInspectionSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [b] = await tx.select().from(buildings).where(and(eq(buildings.id, input.buildingId), eq(buildings.orgId, p.orgId)));
    if (!b) throw new ValidationError("Building not found.", "buildingId");
    authorize(p, "inspection.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId: b.id });
    const [t] = await tx.select().from(inspectionTemplates).where(and(eq(inspectionTemplates.id, input.templateId), eq(inspectionTemplates.orgId, p.orgId), eq(inspectionTemplates.active, true)));
    if (!t) throw new ValidationError("Template not found.", "templateId");
    let unitId: string | null = null;
    if (input.unitNumber) {
      const [u] = await tx.select({ id: units.id }).from(units).where(and(eq(units.buildingId, b.id), sql`lower(${units.number}) = lower(${input.unitNumber})`));
      if (!u) throw new ValidationError(`No unit ${input.unitNumber} in that building.`, "unitNumber");
      unitId = u.id;
    }
    if (input.inspectorMembershipId && !(await taskAssignees(tx, p.orgId, b.propertyId)).some((a) => a.membershipId === input.inspectorMembershipId)) {
      throw new ValidationError("That person can't inspect this property.", "inspectorMembershipId");
    }
    const i = await insertInspection(tx, ctx, t, { propertyId: b.propertyId, buildingId: b.id, unitId, unitNumber: input.unitNumber }, input.scheduledFor, input.inspectorMembershipId, input.title);
    await auditAs(tx, ctx, "inspection.scheduled", "inspection", i.id, undefined, i);
    return i;
  });
}

async function loadInspection(tx: Tx, orgId: string, id: string) {
  const [i] = await tx.select().from(inspections).where(and(eq(inspections.id, id), eq(inspections.orgId, orgId)));
  if (!i) throw new NotFoundError();
  return i;
}

export async function getInspection(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const i = await loadInspection(tx, p.orgId, id);
    const a = access(p, i);
    if (!a.read) throw new NotFoundError();
    const items = await tx.select().from(inspectionItems).where(eq(inspectionItems.inspectionId, id)).orderBy(asc(inspectionItems.position));
    const [labels] = await tx.select({ propertyName: properties.name, buildingName: buildings.name, unitNumber: units.number })
      .from(properties).leftJoin(buildings, eq(buildings.id, sql`${i.buildingId}`)).leftJoin(units, eq(units.id, sql`${i.unitId}`)).where(eq(properties.id, i.propertyId));
    const [inspector] = i.inspectorMembershipId ? await tx.select({ name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.id, i.inspectorMembershipId)) : [];
    const timeline = await listTimeline(tx, p.orgId, "inspection", id, ["public", "vendor", "internal"]);
    return { inspection: i, items, labels, inspectorName: inspector?.name ?? null, timeline, access: a, canCreateWorkOrder: can(p, "workorder.create", { orgId: p.orgId, propertyId: i.propertyId, buildingId: i.buildingId }) };
  });
}

export const itemSchema = z.object({
  result: z.enum(["pass", "fail", "na"]),
  severity: z.union([z.literal(""), z.enum(["low", "medium", "high", "critical"])]).optional().transform((v) => v || null),
  notes: z.string().trim().max(2000).optional().transform(blankToNull),
});

export async function recordItem(ctx: TenantCtx, itemId: string, input: z.infer<typeof itemSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [item] = await tx.select().from(inspectionItems).where(and(eq(inspectionItems.id, itemId), eq(inspectionItems.orgId, p.orgId)));
    if (!item) throw new NotFoundError();
    const i = await loadInspection(tx, p.orgId, item.inspectionId);
    const a = access(p, i);
    if (!a.read) throw new NotFoundError();
    if (!a.perform) throw new ForbiddenError();
    if (i.status === "completed" || i.status === "cancelled") throw new ValidationError("This inspection is closed.");
    if (input.result === "fail" && !input.severity) throw new ValidationError("Choose a severity for failed items.", "severity");
    await tx.update(inspectionItems).set({ result: input.result, severity: input.result === "fail" ? input.severity : null, notes: input.notes }).where(eq(inspectionItems.id, itemId));
    if (i.status === "scheduled") await tx.update(inspections).set({ status: "in_progress" }).where(eq(inspections.id, i.id));
    return i.id;
  });
}

export const completeSchema = z.object({
  summary: z.string().trim().max(4000).optional().transform(blankToNull),
  signedByName: z.string().trim().min(2, "Type your name to sign.").max(120),
});

// all items must be answered; any failure fails the inspection; recurring templates schedule the next one
export async function completeInspection(ctx: TenantCtx, id: string, input: z.infer<typeof completeSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const i = await loadInspection(tx, p.orgId, id);
    const a = access(p, i);
    if (!a.read) throw new NotFoundError();
    if (!a.perform) throw new ForbiddenError();
    if (i.status === "completed" || i.status === "cancelled") throw new ValidationError("This inspection is already closed.");
    const items = await tx.select().from(inspectionItems).where(eq(inspectionItems.inspectionId, id));
    const open = items.filter((x) => !x.result).length;
    if (open) throw new ValidationError(`${open} checklist item${open === 1 ? " is" : "s are"} still unanswered.`);
    const failed = items.filter((x) => x.result === "fail");
    const result = failed.length ? "fail" : "pass";
    const [after] = await tx.update(inspections).set({ status: "completed", result, summary: input.summary, signedByName: input.signedByName, completedAt: new Date() }).where(eq(inspections.id, id)).returning();
    await addTimeline(tx, ctx, { entityType: "inspection", entityId: id, kind: "status", fromStatus: i.status, toStatus: "completed", body: `${result === "pass" ? "Passed" : `Failed (${failed.length} item${failed.length === 1 ? "" : "s"})`}. Signed by ${input.signedByName}.` });
    await auditAs(tx, ctx, "inspection.completed", "inspection", id, { status: i.status }, { status: "completed", result });
    if (result === "fail") await emit(tx, ctx, "inspection.failed", { inspectionId: id, failed: failed.length });
    if (i.templateId) {
      const [t] = await tx.select().from(inspectionTemplates).where(eq(inspectionTemplates.id, i.templateId));
      if (t?.repeatEveryDays && t.active) {
        const next = new Date(`${i.scheduledFor}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + t.repeatEveryDays);
        await insertInspection(tx, ctx, t, { propertyId: i.propertyId, buildingId: i.buildingId, unitId: i.unitId }, next.toISOString().slice(0, 10), i.inspectorMembershipId, i.title);
      }
    }
    return after;
  });
}

// turns a failed checklist item into a linked work order
export async function createFollowUpWorkOrder(ctx: TenantCtx, itemId: string, category: (typeof WO_CATEGORIES)[number]) {
  const p = ctx.principal;
  const { item, insp } = await tenantTx(ctx, async (tx) => {
    const [item] = await tx.select().from(inspectionItems).where(and(eq(inspectionItems.id, itemId), eq(inspectionItems.orgId, p.orgId)));
    if (!item) throw new NotFoundError();
    const insp = await loadInspection(tx, p.orgId, item.inspectionId);
    if (!access(p, insp).read) throw new NotFoundError();
    if (item.result !== "fail") throw new ValidationError("Only failed items need a follow-up.");
    if (item.workOrderId) throw new ValidationError("A work order already exists for this item.");
    return { item, insp };
  });
  const priority = item.severity === "critical" ? "urgent" : item.severity === "high" ? "high" : "normal";
  const res = await createWorkOrder(ctx, {
    title: `${item.label} (inspection follow-up)`.slice(0, 160), description: `From inspection “${insp.title}” on ${insp.scheduledFor}.\n${item.notes ?? ""}`.trim(),
    category, priority, isEmergency: false, unitId: insp.unitId, buildingId: insp.unitId ? null : insp.buildingId, unitNumber: null,
    propertyId: insp.unitId || insp.buildingId ? null : insp.propertyId, area: item.section, permissionToEnter: false, entryNotes: null,
  }, { source: "inspection", sourceType: "inspection", sourceId: insp.id });
  await tenantTx(ctx, (tx) => tx.update(inspectionItems).set({ workOrderId: res.workOrder.id }).where(eq(inspectionItems.id, itemId)));
  return res.workOrder;
}

export async function inspectionFormOptions(ctx: TenantCtx, propertyId: string | null) {
  return tenantTx(ctx, (tx) => taskAssignees(tx, ctx.principal.orgId, propertyId));
}
