import "server-only";
import { and, eq, inArray, isNull, or, gte, sql } from "drizzle-orm";
import { setTxOrg, withContext } from "../../db/client";
import {
  buildings, membershipScopes, memberships, organizations, properties, residents, roles, unitOccupancies, units,
} from "../../db/schema";
import type { Principal } from "../../authz/authorize";
import type { RoleCategory, ScopeLevel } from "../../authz/system-roles";

export type OrgSummary = { id: string; name: string; slug: string; status: string; roleName: string; roleKey: string };

// orgs the user belongs to (active memberships only)
export async function listMyOrganizations(userId: string): Promise<OrgSummary[]> {
  return withContext({ userId }, (tx) =>
    tx
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, status: organizations.status, roleName: roles.name, roleKey: roles.key })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.userId, userId), eq(memberships.status, "active")))
      .orderBy(organizations.name),
  );
}

// builds the Principal for (user, org slug); null = not a member / org unavailable
export async function loadPrincipal(userId: string, orgSlug: string): Promise<(Principal & { orgName: string; orgTimezone: string }) | null> {
  return withContext({ userId }, async (tx) => {
    const [m] = await tx
      .select({ membership: memberships, org: organizations, role: roles })
      .from(memberships)
      .innerJoin(organizations, eq(organizations.id, memberships.orgId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.userId, userId), eq(organizations.slug, orgSlug), eq(memberships.status, "active")))
      .limit(1);
    if (!m || m.org.status !== "active") return null;
    await setTxOrg(tx, m.org.id);

    const portfolioIds = new Set<string>();
    const propertyIds = new Set<string>();
    const buildingIds = new Set<string>();
    const partialPropertyIds = new Set<string>();
    const unitIds = new Set<string>();
    const occupantBuildingIds = new Set<string>();
    const occupantPropertyIds = new Set<string>();
    let residentId: string | null = null;

    if (m.role.scopeLevel === "scoped") {
      const scopes = await tx.select().from(membershipScopes).where(eq(membershipScopes.membershipId, m.membership.id));
      for (const s of scopes) {
        if (s.portfolioId) portfolioIds.add(s.portfolioId);
        if (s.propertyId) propertyIds.add(s.propertyId);
        if (s.buildingId) buildingIds.add(s.buildingId);
      }
      if (portfolioIds.size) {
        const rows = await tx.select({ id: properties.id }).from(properties).where(inArray(properties.portfolioId, [...portfolioIds]));
        rows.forEach((r) => propertyIds.add(r.id));
      }
      if (buildingIds.size) {
        const rows = await tx.select({ propertyId: buildings.propertyId }).from(buildings).where(inArray(buildings.id, [...buildingIds]));
        rows.forEach((r) => partialPropertyIds.add(r.propertyId));
      }
    }

    if (m.role.scopeLevel === "occupant") {
      const today = sql`current_date`;
      const rows = await tx
        .select({ residentId: residents.id, unitId: units.id, buildingId: units.buildingId, propertyId: units.propertyId })
        .from(residents)
        .innerJoin(unitOccupancies, eq(unitOccupancies.residentId, residents.id))
        .innerJoin(units, eq(units.id, unitOccupancies.unitId))
        .where(and(eq(residents.userId, userId), or(isNull(unitOccupancies.endsOn), gte(unitOccupancies.endsOn, today))));
      for (const r of rows) {
        residentId = r.residentId;
        unitIds.add(r.unitId);
        occupantBuildingIds.add(r.buildingId);
        occupantPropertyIds.add(r.propertyId);
      }
    }

    return {
      userId,
      orgId: m.org.id,
      orgSlug: m.org.slug,
      orgName: m.org.name,
      orgTimezone: m.org.timezone,
      membershipId: m.membership.id,
      role: { id: m.role.id, key: m.role.key, name: m.role.name, scopeLevel: m.role.scopeLevel as ScopeLevel, category: m.role.category as RoleCategory },
      permissions: new Set(m.role.permissions),
      portfolioIds, propertyIds, buildingIds, partialPropertyIds,
      unitIds, occupantBuildingIds, occupantPropertyIds, residentId,
      vendorId: null,
    };
  });
}
