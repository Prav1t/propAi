import "server-only";
import { and, eq, or, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { memberships, roles } from "../../db/schema";

// active users whose role grants `perm` and whose scope covers the property (or building)
export async function usersWithPermAt(tx: Tx, orgId: string, perm: string, propertyId: string, buildingId: string | null): Promise<string[]> {
  const rows = await tx.selectDistinct({ userId: memberships.userId }).from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(
      eq(memberships.orgId, orgId), eq(memberships.status, "active"), sql`${perm} = any(${roles.permissions})`,
      or(eq(roles.scopeLevel, "org"), sql`exists (select 1 from membership_scopes s where s.membership_id = ${memberships.id} and (
        s.property_id = ${propertyId}
        or s.portfolio_id = (select portfolio_id from properties where id = ${propertyId})
        or ${buildingId ? sql`s.building_id = ${buildingId}` : sql`s.building_id in (select id from buildings where property_id = ${propertyId})`}))`),
    ));
  return rows.map((r) => r.userId);
}

export async function membershipUser(tx: Tx, membershipId: string | null): Promise<string[]> {
  if (!membershipId) return [];
  const [m] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.status, "active")));
  return m ? [m.userId] : [];
}

export async function vendorUsers(tx: Tx, vendorId: string | null): Promise<string[]> {
  if (!vendorId) return [];
  const rows = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.vendorId, vendorId), eq(memberships.status, "active")));
  return rows.map((r) => r.userId);
}
