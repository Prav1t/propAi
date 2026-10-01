import "server-only";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { properties, slaPolicies, triageRules, vendors, memberships, users } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError } from "../../authz/authorize";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { visiblePropertyIds } from "../scope";
import { DEFAULT_SLA, PRIORITY_ORDER, WO_CATEGORIES } from "./rules";

// org defaults need an org-wide role; property overrides need the permission on that property
function authorizeScope(ctx: TenantCtx, propertyId: string | null) {
  const p = ctx.principal;
  if (propertyId) authorize(p, "workorder.configure", { orgId: p.orgId, propertyId });
  else if (p.role.scopeLevel === "org") authorize(p, "workorder.configure");
  else throw new ForbiddenError("Organization-wide settings need an organization-wide role. Choose one of your properties.");
}

export async function getMaintenanceConfig(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.permissions.has("workorder.configure")) throw new ForbiddenError();
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, async (tx) => {
    const propFilter = visible ? (visible.length ? or(isNull(slaPolicies.propertyId), inArray(slaPolicies.propertyId, visible)) : isNull(slaPolicies.propertyId)) : undefined;
    const sla = await tx.select({ s: slaPolicies, propertyName: properties.name }).from(slaPolicies).leftJoin(properties, eq(properties.id, slaPolicies.propertyId))
      .where(and(eq(slaPolicies.orgId, p.orgId), propFilter)).orderBy(asc(properties.name), sql`array_position(array['urgent','high','normal','low'], ${slaPolicies.priority})`);
    const ruleFilter = visible ? (visible.length ? or(isNull(triageRules.propertyId), inArray(triageRules.propertyId, visible)) : isNull(triageRules.propertyId)) : undefined;
    const rules = await tx.select({ r: triageRules, propertyName: properties.name, vendorName: vendors.name, assigneeName: users.name })
      .from(triageRules).leftJoin(properties, eq(properties.id, triageRules.propertyId)).leftJoin(vendors, eq(vendors.id, triageRules.assignVendorId))
      .leftJoin(memberships, eq(memberships.id, triageRules.assignMembershipId)).leftJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(triageRules.orgId, p.orgId), ruleFilter)).orderBy(asc(triageRules.position), asc(triageRules.name));
    const props = await tx.select({ id: properties.id, name: properties.name }).from(properties)
      .where(and(eq(properties.orgId, p.orgId), visible ? (visible.length ? inArray(properties.id, visible) : sql`false`) : undefined)).orderBy(asc(properties.name));
    const vendorOpts = await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(and(eq(vendors.orgId, p.orgId), eq(vendors.status, "active"))).orderBy(asc(vendors.name));
    return {
      sla, rules, properties: props.filter((x) => can(p, "workorder.configure", { orgId: p.orgId, propertyId: x.id })), vendors: vendorOpts,
      canEditOrgDefaults: p.role.scopeLevel === "org", defaults: DEFAULT_SLA,
    };
  });
}

const hours = z.coerce.number().min(0.25, "At least 15 minutes.").max(24 * 90);

export const slaSchema = z.object({
  propertyId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  priority: z.enum(PRIORITY_ORDER),
  respondHours: hours,
  resolveHours: hours,
}).refine((v) => v.resolveHours >= v.respondHours, { message: "Resolution can't be faster than first response.", path: ["resolveHours"] });

export async function upsertSla(ctx: TenantCtx, input: z.infer<typeof slaSchema>) {
  authorizeScope(ctx, input.propertyId);
  const respondMinutes = Math.round(input.respondHours * 60);
  const resolveMinutes = Math.round(input.resolveHours * 60);
  await tenantTx(ctx, async (tx) => {
    const [existing] = await tx.select().from(slaPolicies).where(and(eq(slaPolicies.orgId, ctx.principal.orgId), eq(slaPolicies.priority, input.priority),
      input.propertyId ? eq(slaPolicies.propertyId, input.propertyId) : isNull(slaPolicies.propertyId)));
    if (existing) await tx.update(slaPolicies).set({ respondMinutes, resolveMinutes }).where(eq(slaPolicies.id, existing.id));
    else await tx.insert(slaPolicies).values({ orgId: ctx.principal.orgId, propertyId: input.propertyId, priority: input.priority, respondMinutes, resolveMinutes });
    await auditAs(tx, ctx, "sla_policy.saved", "sla_policy", existing?.id ?? null, existing ?? undefined, { ...input, respondMinutes, resolveMinutes });
  });
}

export async function deleteSla(ctx: TenantCtx, id: string) {
  await tenantTx(ctx, async (tx) => {
    const [s] = await tx.select().from(slaPolicies).where(and(eq(slaPolicies.id, id), eq(slaPolicies.orgId, ctx.principal.orgId)));
    if (!s) throw new NotFoundError();
    authorizeScope(ctx, s.propertyId);
    await tx.delete(slaPolicies).where(eq(slaPolicies.id, id));
    await auditAs(tx, ctx, "sla_policy.deleted", "sla_policy", id, s);
  });
}

export const ruleSchema = z.object({
  name: z.string().trim().min(2, "Name the rule.").max(120),
  propertyId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  keywords: z.string().max(1000).optional().transform((v) => [...new Set((v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 30)),
  category: z.union([z.literal(""), z.enum(WO_CATEGORIES)]).optional().transform((v) => v || null),
  setPriority: z.union([z.literal(""), z.enum(PRIORITY_ORDER)]).optional().transform((v) => v || null),
  setEmergency: z.union([z.literal("on"), z.literal("")]).optional().transform((v) => v === "on"),
  setCategory: z.union([z.literal(""), z.enum(WO_CATEGORIES)]).optional().transform((v) => v || null),
  assignVendorId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  residentInstructions: z.string().trim().max(1000).optional().transform(blankToNull),
  position: z.coerce.number().int().min(0).max(1000).default(100),
}).refine((v) => v.keywords.length > 0 || v.category, { message: "Add keywords or a category to match on.", path: ["keywords"] })
  .refine((v) => v.setPriority || v.setEmergency || v.setCategory || v.assignVendorId || v.residentInstructions, { message: "Choose at least one outcome.", path: ["setPriority"] });

export async function createRule(ctx: TenantCtx, input: z.infer<typeof ruleSchema>) {
  authorizeScope(ctx, input.propertyId);
  return tenantTx(ctx, async (tx) => {
    if (input.assignVendorId) {
      const [v] = await tx.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.id, input.assignVendorId), eq(vendors.orgId, ctx.principal.orgId)));
      if (!v) throw new ValidationError("Vendor not found.", "assignVendorId");
    }
    const [r] = await tx.insert(triageRules).values({ orgId: ctx.principal.orgId, ...input }).returning();
    await auditAs(tx, ctx, "triage_rule.created", "triage_rule", r.id, undefined, r);
    return r;
  });
}

export async function setRuleActive(ctx: TenantCtx, id: string, active: boolean) {
  await tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(triageRules).where(and(eq(triageRules.id, id), eq(triageRules.orgId, ctx.principal.orgId)));
    if (!r) throw new NotFoundError();
    authorizeScope(ctx, r.propertyId);
    await tx.update(triageRules).set({ active }).where(eq(triageRules.id, id));
    await auditAs(tx, ctx, active ? "triage_rule.enabled" : "triage_rule.disabled", "triage_rule", id);
  });
}

export async function deleteRule(ctx: TenantCtx, id: string) {
  await tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(triageRules).where(and(eq(triageRules.id, id), eq(triageRules.orgId, ctx.principal.orgId)));
    if (!r) throw new NotFoundError();
    authorizeScope(ctx, r.propertyId);
    await tx.delete(triageRules).where(eq(triageRules.id, id));
    await auditAs(tx, ctx, "triage_rule.deleted", "triage_rule", id, r);
  });
}
