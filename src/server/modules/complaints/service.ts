import "server-only";
import { and, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { buildings, complaints, incidents, memberships, properties, units, users, COMPLAINT_CATEGORIES } from "../../db/schema";
import { can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { addTimeline, emit, listTimeline, nextNumber, type Visibility } from "../ops/core";
import { taskAssignees } from "../tasks/service";

export const COMPLAINT_STATUSES = ["new", "acknowledged", "investigating", "resolved", "closed", "dismissed"] as const;
type CmpRow = typeof complaints.$inferSelect;

function access(p: Principal, c: CmpRow) {
  const res = { orgId: c.orgId, propertyId: c.propertyId, buildingId: c.buildingId };
  const manage = can(p, "complaint.manage", res);
  const staff = manage || can(p, "complaint.read", res);
  const assignee = !!c.assignedMembershipId && c.assignedMembershipId === p.membershipId;
  const owner = c.submittedByUserId === p.userId || (!!p.residentId && c.residentId === p.residentId);
  return { manage, staff: staff || assignee, owner, read: staff || assignee || owner };
}

function visibleWhere(p: Principal): SQL {
  const parts: (SQL | undefined)[] = [eq(complaints.submittedByUserId, p.userId), eq(complaints.assignedMembershipId, p.membershipId)];
  if (p.residentId) parts.push(eq(complaints.residentId, p.residentId));
  if (p.permissions.has("complaint.read")) parts.push(scopeCondition(p, { property: complaints.propertyId, building: complaints.buildingId }) ?? sql`true`);
  return or(...parts.filter(Boolean)) ?? sql`false`;
}

export const canUseComplaints = (p: Principal) => p.permissions.has("complaint.read") || p.permissions.has("complaint.create");

export type ComplaintRow = { id: string; number: number; subject: string; category: string; status: string; priority: string; createdAt: Date; propertyName: string; unitNumber: string | null; assigneeName: string | null };

export async function listComplaints(ctx: TenantCtx, opts: { view?: "open" | "all" | "resolved"; category?: string; propertyId?: string; page?: number }): Promise<Page<ComplaintRow>> {
  const p = ctx.principal;
  if (!canUseComplaints(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page);
  const viewCond = { open: inArray(complaints.status, ["new", "acknowledged", "investigating"]), resolved: inArray(complaints.status, ["resolved", "closed", "dismissed"]), all: undefined }[opts.view ?? "open"];
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(complaints.orgId, p.orgId), visibleWhere(p), viewCond,
      opts.category ? eq(complaints.category, opts.category) : undefined, opts.propertyId ? eq(complaints.propertyId, opts.propertyId) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(complaints).where(where);
    const rows = await tx.select({
      id: complaints.id, number: complaints.number, subject: complaints.subject, category: complaints.category, status: complaints.status, priority: complaints.priority,
      createdAt: complaints.createdAt, propertyName: properties.name, unitNumber: units.number, assigneeName: users.name,
    }).from(complaints).innerJoin(properties, eq(properties.id, complaints.propertyId)).leftJoin(units, eq(units.id, complaints.unitId))
      .leftJoin(memberships, eq(memberships.id, complaints.assignedMembershipId)).leftJoin(users, eq(users.id, memberships.userId))
      .where(where).orderBy(desc(complaints.createdAt)).limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

export const complaintSchema = z.object({
  category: z.enum(COMPLAINT_CATEGORIES),
  subject: z.string().trim().min(3, "Add a short subject.").max(160),
  description: z.string().trim().min(10, "Tell us what happened (at least a sentence).").max(10_000),
  unitId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  buildingId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  unitNumber: z.string().trim().max(20).optional().transform(blankToNull),
});

export async function createComplaint(ctx: TenantCtx, input: z.infer<typeof complaintSchema>) {
  const p = ctx.principal;
  if (!p.permissions.has("complaint.create") && !p.permissions.has("complaint.manage")) throw new ForbiddenError();
  const isResident = p.role.category === "resident";
  return tenantTx(ctx, async (tx) => {
    let unit: typeof units.$inferSelect | undefined;
    if (input.unitId) [unit] = await tx.select().from(units).where(and(eq(units.orgId, p.orgId), eq(units.id, input.unitId)));
    else if (input.buildingId && input.unitNumber) [unit] = await tx.select().from(units).where(and(eq(units.orgId, p.orgId), eq(units.buildingId, input.buildingId), sql`lower(${units.number}) = lower(${input.unitNumber})`));
    let loc: { propertyId: string; buildingId: string | null; unitId: string | null };
    if (unit) loc = { propertyId: unit.propertyId, buildingId: unit.buildingId, unitId: unit.id };
    else if (input.buildingId && !input.unitNumber) {
      const [b] = await tx.select().from(buildings).where(and(eq(buildings.orgId, p.orgId), eq(buildings.id, input.buildingId)));
      if (!b) throw new ValidationError("Building not found.", "buildingId");
      loc = { propertyId: b.propertyId, buildingId: b.id, unitId: null };
    } else throw new ValidationError(input.unitNumber ? "Unit not found." : "Choose the building.", input.unitNumber ? "unitNumber" : "buildingId");
    // residents file complaints from their own unit
    if (isResident && (!loc.unitId || !p.unitIds.has(loc.unitId))) throw new ForbiddenError("Choose your own unit.");
    if (!isResident && !can(p, "complaint.create", { orgId: p.orgId, ...loc }) && !can(p, "complaint.manage", { orgId: p.orgId, ...loc })) throw new ForbiddenError();
    const number = await nextNumber(tx, p.orgId, "complaint");
    const [c] = await tx.insert(complaints).values({
      orgId: p.orgId, number, ...loc, category: input.category, subject: input.subject, description: input.description,
      submittedByUserId: p.userId, residentId: isResident ? p.residentId : null,
    }).returning();
    await addTimeline(tx, ctx, { entityType: "complaint", entityId: c.id, kind: "created", toStatus: "new", visibility: "public", body: `Complaint #${number} received.` });
    await auditAs(tx, ctx, "complaint.created", "complaint", c.id, undefined, c);
    await emit(tx, ctx, "complaint.created", { complaintId: c.id });
    return c;
  });
}

async function loadComplaint(tx: Tx, orgId: string, id: string) {
  const [c] = await tx.select().from(complaints).where(and(eq(complaints.id, id), eq(complaints.orgId, orgId)));
  if (!c) throw new NotFoundError();
  return c;
}

export async function getComplaint(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const c = await loadComplaint(tx, p.orgId, id);
    const a = access(p, c);
    if (!a.read) throw new NotFoundError();
    const levels: Visibility[] = a.staff ? ["public", "vendor", "internal"] : ["public"];
    const [labels] = await tx.select({ propertyName: properties.name, buildingName: buildings.name, unitNumber: units.number })
      .from(properties).leftJoin(buildings, eq(buildings.id, sql`${c.buildingId}`)).leftJoin(units, eq(units.id, sql`${c.unitId}`)).where(eq(properties.id, c.propertyId));
    const [submitter] = a.staff && c.submittedByUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, c.submittedByUserId)) : [];
    const [assignee] = c.assignedMembershipId ? await tx.select({ name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.id, c.assignedMembershipId)) : [];
    const [incident] = a.staff && c.relatedIncidentId ? await tx.select({ id: incidents.id, number: incidents.number, title: incidents.title }).from(incidents).where(eq(incidents.id, c.relatedIncidentId)) : [];
    const timeline = await listTimeline(tx, p.orgId, "complaint", id, levels);
    const history = a.staff && c.unitId
      ? await tx.select({ id: complaints.id, number: complaints.number, subject: complaints.subject, status: complaints.status, createdAt: complaints.createdAt })
          .from(complaints).where(and(eq(complaints.unitId, c.unitId), sql`${complaints.id} <> ${id}`)).orderBy(desc(complaints.createdAt)).limit(10)
      : [];
    const incidentOptions = a.manage
      ? await tx.select({ id: incidents.id, number: incidents.number, title: incidents.title }).from(incidents).where(eq(incidents.propertyId, c.propertyId)).orderBy(desc(incidents.occurredAt)).limit(30)
      : [];
    return {
      complaint: c, labels, submitterName: submitter?.name ?? null, assigneeName: assignee?.name ?? null, incident: incident ?? null,
      timeline, access: a, history, incidentOptions, assignees: a.manage ? await taskAssignees(tx, p.orgId, c.propertyId) : [],
    };
  });
}

export const complaintUpdateSchema = z.object({
  status: z.union([z.literal(""), z.enum(COMPLAINT_STATUSES)]).optional().transform((v) => v || null),
  priority: z.union([z.literal(""), z.enum(["low", "normal", "high", "urgent"])]).optional().transform((v) => v || null),
  assignedMembershipId: z.string().optional(),
  relatedIncidentId: z.string().optional(),
  resolution: z.string().trim().max(4000).optional().transform(blankToNull),
});

export async function updateComplaint(ctx: TenantCtx, id: string, input: z.infer<typeof complaintUpdateSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const c = await loadComplaint(tx, p.orgId, id);
    const a = access(p, c);
    if (!a.read) throw new NotFoundError();
    if (!a.manage) throw new ForbiddenError();
    if (input.status && ["resolved", "dismissed"].includes(input.status) && !input.resolution && !c.resolution) throw new ValidationError("Explain the outcome to the resident.", "resolution");
    const patch: Partial<CmpRow> = {};
    if (input.status && input.status !== c.status) { patch.status = input.status; if (["resolved", "dismissed"].includes(input.status)) patch.resolvedAt = new Date(); }
    if (input.priority && input.priority !== c.priority) patch.priority = input.priority;
    if (input.resolution) patch.resolution = input.resolution;
    if (input.assignedMembershipId !== undefined) {
      const m = input.assignedMembershipId || null;
      if (m && !(await taskAssignees(tx, p.orgId, c.propertyId)).some((x) => x.membershipId === m)) throw new ValidationError("That person can't handle this property.", "assignedMembershipId");
      if (m !== c.assignedMembershipId) patch.assignedMembershipId = m;
    }
    if (input.relatedIncidentId !== undefined) {
      const inc = input.relatedIncidentId || null;
      if (inc) {
        const [i] = await tx.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.id, inc), eq(incidents.orgId, p.orgId), eq(incidents.propertyId, c.propertyId)));
        if (!i) throw new ValidationError("Incident not found at this property.", "relatedIncidentId");
      }
      if (inc !== c.relatedIncidentId) patch.relatedIncidentId = inc;
    }
    if (!Object.keys(patch).length) return;
    await tx.update(complaints).set(patch).where(eq(complaints.id, id));
    if (patch.status) await addTimeline(tx, ctx, { entityType: "complaint", entityId: id, kind: "status", fromStatus: c.status, toStatus: patch.status, visibility: "public", body: ["resolved", "dismissed"].includes(patch.status) ? (input.resolution ?? c.resolution) : null });
    if ("assignedMembershipId" in patch) await addTimeline(tx, ctx, { entityType: "complaint", entityId: id, kind: "assigned", body: patch.assignedMembershipId ? "Assigned." : "Unassigned." });
    await auditAs(tx, ctx, "complaint.updated", "complaint", id, { status: c.status, priority: c.priority, assignedMembershipId: c.assignedMembershipId }, patch);
    if (patch.status) await emit(tx, ctx, "complaint.status_changed", { complaintId: id, from: c.status, to: patch.status });
  });
}

export const complaintCommentSchema = z.object({
  body: z.string().trim().min(1, "Write a message.").max(4000),
  visibility: z.enum(["public", "internal"]).default("public"),
});

// residents and staff exchange public messages; staff can add internal notes
export async function commentOnComplaint(ctx: TenantCtx, id: string, input: z.infer<typeof complaintCommentSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const c = await loadComplaint(tx, p.orgId, id);
    const a = access(p, c);
    if (!a.read) throw new NotFoundError();
    if (input.visibility === "internal" && !a.staff) throw new ForbiddenError();
    const ev = await addTimeline(tx, ctx, { entityType: "complaint", entityId: id, kind: "comment", body: input.body, visibility: input.visibility });
    if (input.visibility === "public") await emit(tx, ctx, "complaint.commented", { complaintId: id, eventId: ev.id, byStaff: a.staff });
  });
}
