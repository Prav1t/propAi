import "server-only";
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, setTxOrg, withContext } from "../../db/client";
import {
  auditLogs, buildings, memberships, organizations, properties, residents, roles, unitOccupancies, units, users,
} from "../../db/schema";
import { authorize, scopeFilter, ForbiddenError } from "../../authz/authorize";
import { writeAudit } from "../../audit";
import type { RequestMeta } from "../../request-meta";
import { tenantTx, ValidationError, type TenantCtx } from "../context";

export const ORG_KINDS = ["property_management", "strata", "rental", "facility", "concierge", "owner_operator"] as const;
export const TIMEZONES = [
  "America/Vancouver", "America/Edmonton", "America/Regina", "America/Winnipeg", "America/Toronto",
  "America/Halifax", "America/St_Johns", "America/Los_Angeles", "America/Denver", "America/Chicago",
  "America/New_York", "Europe/London", "UTC",
] as const;

const RESERVED_SLUGS = new Set(["admin", "api", "app", "login", "new", "settings", "account", "o", "www"]);

export const createOrgSchema = z.object({
  name: z.string().trim().min(2, "Enter an organization name.").max(120),
  kind: z.enum(ORG_KINDS),
  timezone: z.enum(TIMEZONES),
});

export function slugify(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 40).replace(/-+$/g, "");
  return s.length >= 2 ? s : "org";
}

const isUniqueViolation = (e: unknown) =>
  !!e && typeof e === "object" && ((e as { code?: string }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505");

// any verified user can create an org and becomes its admin
export async function createOrganization(userId: string, input: z.infer<typeof createOrgSchema>, meta: RequestMeta | null) {
  const user = await db().query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.emailVerifiedAt) throw new ForbiddenError("Verify your email before creating an organization.");
  const base = slugify(input.name);
  const orgId = crypto.randomUUID();
  return withContext({ userId, orgId }, async (tx) => {
    // slugs are globally unique: retry with a suffix inside a savepoint on collision
    let org: typeof organizations.$inferSelect | undefined;
    for (let i = 0; i < 10 && !org; i++) {
      const slug = i === 0 && !RESERVED_SLUGS.has(base) ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        org = await tx.transaction(async (sp) =>
          (await sp.insert(organizations).values({ id: orgId, name: input.name, slug, kind: input.kind, timezone: input.timezone }).returning())[0],
        );
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    }
    if (!org) throw new Error("Could not allocate an organization URL. Try a different name.");
    const [adminRole] = await tx.select().from(roles).where(and(isNull(roles.orgId), eq(roles.key, "org_admin"))).limit(1);
    if (!adminRole) throw new Error("System roles are not seeded. Run `npm run db:migrate`.");
    const [m] = await tx.insert(memberships).values({ orgId, userId, roleId: adminRole.id }).returning();
    await writeAudit(tx, { orgId, actorUserId: userId, action: "org.created", entityType: "organization", entityId: orgId, after: org }, meta);
    await writeAudit(tx, { orgId, actorUserId: userId, action: "member.added", entityType: "membership", entityId: m.id, after: { userId, role: "org_admin" } }, meta);
    return org;
  });
}

export const orgSettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.enum(TIMEZONES),
  parkingSecondReviewer: z.boolean().default(false),
});

// typed view of organizations.settings (jsonb)
export type OrgSettings = { parkingSecondReviewer?: boolean };
export const orgSettings = (raw: unknown): OrgSettings => (raw && typeof raw === "object" ? (raw as OrgSettings) : {});

export async function updateOrganizationSettings(ctx: TenantCtx, input: z.infer<typeof orgSettingsSchema>) {
  authorize(ctx.principal, "org.settings.manage");
  return tenantTx(ctx, async (tx) => {
    const [before] = await tx.select().from(organizations).where(eq(organizations.id, ctx.principal.orgId));
    const settings = { ...orgSettings(before.settings), parkingSecondReviewer: input.parkingSecondReviewer };
    const [after] = await tx.update(organizations).set({ name: input.name, timezone: input.timezone, settings }).where(eq(organizations.id, ctx.principal.orgId)).returning();
    await writeAudit(tx, {
      orgId: ctx.principal.orgId, actorUserId: ctx.principal.userId, action: "org.settings.updated", entityType: "organization",
      entityId: ctx.principal.orgId, before: { name: before.name, timezone: before.timezone, settings: before.settings }, after: { name: after.name, timezone: after.timezone, settings },
    }, ctx.meta);
    return after;
  });
}

export async function getOrganization(ctx: TenantCtx) {
  authorize(ctx.principal, "org.read");
  return tenantTx(ctx, async (tx) => (await tx.select().from(organizations).where(eq(organizations.id, ctx.principal.orgId)))[0]);
}

export type PropertySummary = {
  id: string; name: string; code: string; type: string; city: string | null;
  buildingCount: number; unitCount: number; occupiedCount: number;
};

// properties visible to the principal with real counts (dashboard)
export async function listVisibleProperties(ctx: TenantCtx): Promise<PropertySummary[]> {
  const p = ctx.principal;
  if (!p.permissions.has("property.read") && !p.permissions.has("unit.read.own")) throw new ForbiddenError();
  const f = scopeFilter(p);
  if (f.kind === "none") return [];
  return tenantTx(ctx, async (tx) => {
    const propertyCond =
      f.kind === "all" ? undefined
      : f.kind === "some" ? (f.propertyIds.length || f.buildingIds.length
          ? or(
              f.propertyIds.length ? inArray(properties.id, f.propertyIds) : undefined,
              f.buildingIds.length ? inArray(properties.id, tx.select({ id: buildings.propertyId }).from(buildings).where(inArray(buildings.id, f.buildingIds))) : undefined,
            )
          : sql`false`)
      : f.propertyIds.length ? inArray(properties.id, f.propertyIds) : sql`false`;

    // unit counts are restricted to buildings/units the principal may see
    const unitCond =
      f.kind === "all" ? undefined
      : f.kind === "some" ? (or(
          f.propertyIds.length ? inArray(units.propertyId, f.propertyIds) : undefined,
          f.buildingIds.length ? inArray(units.buildingId, f.buildingIds) : undefined,
        ) ?? sql`false`)
      : f.unitIds.length ? inArray(units.id, f.unitIds) : sql`false`;

    const props = await tx.select().from(properties).where(and(eq(properties.orgId, p.orgId), propertyCond)).orderBy(properties.name);
    if (props.length === 0) return [];
    const ids = props.map((x) => x.id);
    const bCounts = await tx.select({ propertyId: buildings.propertyId, n: count() }).from(buildings)
      .where(and(inArray(buildings.propertyId, ids), f.kind === "some" && f.buildingIds.length && !f.propertyIds.length ? inArray(buildings.id, f.buildingIds) : undefined))
      .groupBy(buildings.propertyId);
    const uCounts = await tx
      .select({ propertyId: units.propertyId, n: count(), occupied: sql<number>`count(*) filter (where ${units.status} = 'occupied')::int` })
      .from(units).where(and(inArray(units.propertyId, ids), unitCond)).groupBy(units.propertyId);
    return props.map((x) => {
      const u = uCounts.find((c) => c.propertyId === x.id);
      return {
        id: x.id, name: x.name, code: x.code, type: x.type, city: x.city,
        buildingCount: bCounts.find((c) => c.propertyId === x.id)?.n ?? 0,
        unitCount: u?.n ?? 0, occupiedCount: u?.occupied ?? 0,
      };
    });
  });
}

export async function getOrgStats(ctx: TenantCtx) {
  const props = await listVisibleProperties(ctx);
  const p = ctx.principal;
  const [memberCount, residentCount] = await tenantTx(ctx, async (tx) => {
    const mc = p.permissions.has("member.read")
      ? (await tx.select({ n: count() }).from(memberships).where(and(eq(memberships.orgId, p.orgId), eq(memberships.status, "active"))))[0].n
      : null;
    let rc: number | null = null;
    if (p.permissions.has("resident.read")) {
      const f = scopeFilter(p);
      const cond = f.kind === "all" ? undefined
        : f.kind === "some" ? or(
            f.propertyIds.length ? inArray(units.propertyId, f.propertyIds) : undefined,
            f.buildingIds.length ? inArray(units.buildingId, f.buildingIds) : undefined,
          ) ?? sql`false`
        : sql`false`;
      rc = (await tx.select({ n: sql<number>`count(distinct ${unitOccupancies.residentId})::int` }).from(unitOccupancies)
        .innerJoin(units, eq(units.id, unitOccupancies.unitId)).where(cond))[0].n;
    }
    return [mc, rc] as const;
  });
  return {
    properties: props.length,
    buildings: props.reduce((a, x) => a + x.buildingCount, 0),
    units: props.reduce((a, x) => a + x.unitCount, 0),
    occupied: props.reduce((a, x) => a + x.occupiedCount, 0),
    members: memberCount,
    residents: residentCount,
    propertyList: props,
  };
}

// resident home: their units with building/property names
export async function listMyUnits(ctx: TenantCtx) {
  const p = ctx.principal;
  if (p.unitIds.size === 0) return [];
  return tenantTx(ctx, (tx) =>
    tx.select({ unitId: units.id, number: units.number, building: buildings.name, property: properties.name, relationship: unitOccupancies.relationship })
      .from(units)
      .innerJoin(buildings, eq(buildings.id, units.buildingId))
      .innerJoin(properties, eq(properties.id, units.propertyId))
      .innerJoin(unitOccupancies, eq(unitOccupancies.unitId, units.id))
      .innerJoin(residents, and(eq(residents.id, unitOccupancies.residentId), eq(residents.userId, p.userId)))
      .where(inArray(units.id, [...p.unitIds])),
  );
}

export async function listAuditLogs(ctx: TenantCtx, opts: { page: number; pageSize?: number }) {
  authorize(ctx.principal, "audit.read");
  const pageSize = Math.min(opts.pageSize ?? 50, 100);
  const offset = (Math.max(1, opts.page) - 1) * pageSize;
  return tenantTx(ctx, async (tx) => {
    const rows = await tx
      .select({ log: auditLogs, actorName: users.name, actorEmail: users.email })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(eq(auditLogs.orgId, ctx.principal.orgId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(pageSize + 1)
      .offset(offset);
    return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
  });
}

/* ───────── platform admin (super admin only; callers must verify users.is_platform_admin) ───────── */

export async function adminListOrganizations() {
  return withContext({ platformAdmin: true }, async (tx) => {
    const orgs = await tx.select().from(organizations).orderBy(desc(organizations.createdAt));
    const counts = await tx.select({ orgId: memberships.orgId, n: count() }).from(memberships).groupBy(memberships.orgId);
    const unitCounts = await tx.select({ orgId: units.orgId, n: count() }).from(units).groupBy(units.orgId);
    return orgs.map((o) => ({
      ...o,
      memberCount: counts.find((c) => c.orgId === o.id)?.n ?? 0,
      unitCount: unitCounts.find((c) => c.orgId === o.id)?.n ?? 0,
    }));
  });
}

export async function adminSetOrganizationStatus(actorUserId: string, orgId: string, status: "active" | "suspended", meta: RequestMeta | null) {
  const actor = await db().query.users.findFirst({ where: eq(users.id, actorUserId) });
  if (!actor?.isPlatformAdmin) throw new ForbiddenError();
  await withContext({ platformAdmin: true, userId: actorUserId }, async (tx) => {
    const [before] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
    if (!before) throw new ValidationError("Organization not found.");
    await tx.update(organizations).set({ status }).where(eq(organizations.id, orgId));
    await setTxOrg(tx, orgId);
    await writeAudit(tx, { orgId, actorUserId, action: status === "suspended" ? "org.suspended" : "org.reactivated", entityType: "organization", entityId: orgId, before: { status: before.status }, after: { status } }, meta);
  });
}
