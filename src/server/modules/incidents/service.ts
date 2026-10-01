import "server-only";
import { and, count, desc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { buildings, incidents, properties, units, users, INCIDENT_TYPES } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { addTimeline, emit, listTimeline, nextNumber, type Visibility } from "../ops/core";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const INCIDENT_STATUSES = ["open", "investigating", "resolved", "closed"] as const;
type IncRow = typeof incidents.$inferSelect;

function access(p: Principal, i: IncRow) {
  const res = { orgId: i.orgId, propertyId: i.propertyId, buildingId: i.buildingId };
  const manage = can(p, "incident.manage", res);
  const read = manage || can(p, "incident.read", res);
  const reporter = i.reportedByUserId === p.userId;
  return { manage, read: read || reporter, staff: read, reporter };
}

function visibleWhere(p: Principal): SQL {
  const parts: (SQL | undefined)[] = [eq(incidents.reportedByUserId, p.userId)];
  if (p.permissions.has("incident.read")) parts.push(scopeCondition(p, { property: incidents.propertyId, building: incidents.buildingId }) ?? sql`true`);
  return or(...parts.filter(Boolean)) ?? sql`false`;
}

export const canUseIncidents = (p: Principal) => p.permissions.has("incident.read") || p.permissions.has("incident.create");

export type IncidentRow = { id: string; number: number; title: string; type: string; severity: string; status: string; occurredAt: Date; propertyName: string; location: string | null; reporterName: string | null };

export async function listIncidents(ctx: TenantCtx, opts: { view?: "open" | "recent" | "all"; type?: string; severity?: string; propertyId?: string; page?: number }): Promise<Page<IncidentRow>> {
  const p = ctx.principal;
  if (!canUseIncidents(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page);
  const viewCond = { open: inArray(incidents.status, ["open", "investigating"]), recent: gte(incidents.occurredAt, new Date(Date.now() - 7 * 86_400_000)), all: undefined }[opts.view ?? "open"];
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(incidents.orgId, p.orgId), visibleWhere(p), viewCond,
      opts.type ? eq(incidents.type, opts.type) : undefined, opts.severity ? eq(incidents.severity, opts.severity) : undefined,
      opts.propertyId ? eq(incidents.propertyId, opts.propertyId) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(incidents).where(where);
    const rows = await tx.select({
      id: incidents.id, number: incidents.number, title: incidents.title, type: incidents.type, severity: incidents.severity, status: incidents.status,
      occurredAt: incidents.occurredAt, location: incidents.location, propertyName: properties.name, reporterName: users.name,
    }).from(incidents).innerJoin(properties, eq(properties.id, incidents.propertyId)).leftJoin(users, eq(users.id, incidents.reportedByUserId))
      .where(where).orderBy(sql`case ${incidents.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`, desc(incidents.occurredAt))
      .limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

export const incidentSchema = z.object({
  type: z.enum(INCIDENT_TYPES),
  severity: z.enum(SEVERITIES).default("medium"),
  title: z.string().trim().min(3, "Summarize what happened.").max(160),
  description: z.string().trim().max(10_000).default(""),
  buildingId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  unitNumber: z.string().trim().max(20).optional().transform(blankToNull),
  unitId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  location: z.string().trim().max(200).optional().transform(blankToNull),
  occurredAt: z.string().min(1, "When did it happen?"),
  peopleInvolved: z.string().trim().max(2000).optional().transform(blankToNull),
  externalReference: z.string().trim().max(120).optional().transform(blankToNull),
});

export async function createIncident(ctx: TenantCtx, input: z.infer<typeof incidentSchema>, occurredUtc: Date) {
  const p = ctx.principal;
  if (!p.permissions.has("incident.create")) throw new ForbiddenError();
  if (Number.isNaN(occurredUtc.getTime()) || occurredUtc.getTime() > Date.now() + 5 * 60_000) throw new ValidationError("Enter when it happened (not in the future).", "occurredAt");
  const isResident = p.role.category === "resident";
  return tenantTx(ctx, async (tx) => {
    let loc: { propertyId: string; buildingId: string | null; unitId: string | null };
    if (input.unitId || (input.buildingId && input.unitNumber)) {
      const [u] = await tx.select().from(units).where(and(eq(units.orgId, p.orgId), input.unitId ? eq(units.id, input.unitId) : and(eq(units.buildingId, input.buildingId!), sql`lower(${units.number}) = lower(${input.unitNumber})`)));
      if (!u) throw new ValidationError("Unit not found.", "unitNumber");
      loc = { propertyId: u.propertyId, buildingId: u.buildingId, unitId: u.id };
    } else if (input.buildingId) {
      const [b] = await tx.select().from(buildings).where(and(eq(buildings.orgId, p.orgId), eq(buildings.id, input.buildingId)));
      if (!b) throw new ValidationError("Building not found.", "buildingId");
      loc = { propertyId: b.propertyId, buildingId: b.id, unitId: null };
    } else throw new ValidationError("Choose where it happened.", "buildingId");
    if (isResident) {
      // residents report incidents in their own buildings
      if (!loc.buildingId || !p.occupantBuildingIds.has(loc.buildingId)) throw new ForbiddenError("You can only report incidents in your building.");
    } else authorize(p, "incident.create", { orgId: p.orgId, ...loc });
    const number = await nextNumber(tx, p.orgId, "incident");
    const [i] = await tx.insert(incidents).values({
      orgId: p.orgId, number, ...loc, type: input.type, severity: input.severity, title: input.title, description: input.description,
      location: input.location, occurredAt: occurredUtc, reportedByUserId: p.userId, peopleInvolved: input.peopleInvolved, externalReference: input.externalReference,
    }).returning();
    await addTimeline(tx, ctx, { entityType: "incident", entityId: i.id, kind: "created", toStatus: "open", visibility: "public", body: `Incident #${number} reported.` });
    await auditAs(tx, ctx, "incident.created", "incident", i.id, undefined, i);
    await emit(tx, ctx, "incident.created", { incidentId: i.id, severity: i.severity });
    return i;
  });
}

async function loadIncident(tx: Tx, orgId: string, id: string) {
  const [i] = await tx.select().from(incidents).where(and(eq(incidents.id, id), eq(incidents.orgId, orgId)));
  if (!i) throw new NotFoundError();
  return i;
}

export async function getIncident(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const i = await loadIncident(tx, p.orgId, id);
    const a = access(p, i);
    if (!a.read) throw new NotFoundError();
    const levels: Visibility[] = a.staff ? ["public", "vendor", "internal"] : ["public"];
    const [labels] = await tx.select({ propertyName: properties.name, buildingName: buildings.name, unitNumber: units.number })
      .from(properties).leftJoin(buildings, eq(buildings.id, sql`${i.buildingId}`)).leftJoin(units, eq(units.id, sql`${i.unitId}`)).where(eq(properties.id, i.propertyId));
    const [reporter] = i.reportedByUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, i.reportedByUserId)) : [];
    const timeline = await listTimeline(tx, p.orgId, "incident", id, levels);
    // reporters who aren't staff don't see names of other people involved
    return { incident: a.staff ? i : { ...i, peopleInvolved: null, externalReference: null }, labels, reporterName: reporter?.name ?? null, timeline, access: a };
  });
}

export const incidentUpdateSchema = z.object({
  status: z.union([z.literal(""), z.enum(INCIDENT_STATUSES)]).optional().transform((v) => v || null),
  severity: z.union([z.literal(""), z.enum(SEVERITIES)]).optional().transform((v) => v || null),
  note: z.string().trim().max(4000).optional().transform(blankToNull),
  visibility: z.enum(["public", "internal"]).default("internal"),
  resolution: z.string().trim().max(4000).optional().transform(blankToNull),
});

// status/severity changes and notes; raising severity to high/critical counts as an escalation
export async function updateIncident(ctx: TenantCtx, id: string, input: z.infer<typeof incidentUpdateSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const i = await loadIncident(tx, p.orgId, id);
    const a = access(p, i);
    if (!a.read) throw new NotFoundError();
    const changesState = !!(input.status && input.status !== i.status) || !!(input.severity && input.severity !== i.severity);
    if (changesState && !a.manage) throw new ForbiddenError();
    if (!a.staff && input.visibility === "internal") throw new ForbiddenError();
    if (input.status === "resolved" && !input.resolution && !i.resolution) throw new ValidationError("Describe how it was resolved.", "resolution");
    const patch: Partial<IncRow> = {};
    if (input.status && input.status !== i.status) { patch.status = input.status; if (input.status === "resolved") patch.resolvedAt = new Date(); }
    if (input.severity && input.severity !== i.severity) patch.severity = input.severity;
    if (input.resolution) patch.resolution = input.resolution;
    if (Object.keys(patch).length) await tx.update(incidents).set(patch).where(eq(incidents.id, id));
    if (patch.status) await addTimeline(tx, ctx, { entityType: "incident", entityId: id, kind: "status", fromStatus: i.status, toStatus: patch.status, visibility: "public", body: patch.status === "resolved" ? input.resolution : null });
    const escalated = !!patch.severity && SEVERITIES.indexOf(patch.severity as (typeof SEVERITIES)[number]) > SEVERITIES.indexOf(i.severity as (typeof SEVERITIES)[number]);
    if (patch.severity) await addTimeline(tx, ctx, { entityType: "incident", entityId: id, kind: escalated ? "escalated" : "updated", body: `Severity ${i.severity} → ${patch.severity}.` });
    if (input.note) await addTimeline(tx, ctx, { entityType: "incident", entityId: id, kind: "comment", body: input.note, visibility: input.visibility });
    if (Object.keys(patch).length) await auditAs(tx, ctx, "incident.updated", "incident", id, { status: i.status, severity: i.severity }, patch);
    if (escalated && ["high", "critical"].includes(patch.severity!)) await emit(tx, ctx, "incident.escalated", { incidentId: id, severity: patch.severity });
  });
}
