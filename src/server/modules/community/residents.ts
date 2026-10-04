import "server-only";
import { and, asc, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import { memberships, residents, unitOccupancies } from "../../db/schema";
import type { Tx } from "../../db/client";

const current = or(isNull(unitOccupancies.endsOn), gte(unitOccupancies.endsOn, sql`current_date`));

// people currently living in a unit, primary occupant first
export async function unitOccupants(tx: Tx, orgId: string, unitId: string) {
  return tx.select({ residentId: residents.id, firstName: residents.firstName, lastName: residents.lastName, userId: residents.userId, isPrimary: unitOccupancies.isPrimary, relationship: unitOccupancies.relationship })
    .from(unitOccupancies).innerJoin(residents, eq(residents.id, unitOccupancies.residentId))
    .where(and(eq(unitOccupancies.orgId, orgId), eq(unitOccupancies.unitId, unitId), current))
    .orderBy(desc(unitOccupancies.isPrimary), asc(residents.lastName));
}

// app users who currently live in a unit and whose membership is active
export async function unitResidentUsers(tx: Tx, orgId: string, unitId: string): Promise<string[]> {
  const rows = await tx.selectDistinct({ userId: residents.userId }).from(unitOccupancies)
    .innerJoin(residents, eq(residents.id, unitOccupancies.residentId))
    .innerJoin(memberships, and(eq(memberships.userId, residents.userId), eq(memberships.orgId, orgId), eq(memberships.status, "active")))
    .where(and(eq(unitOccupancies.orgId, orgId), eq(unitOccupancies.unitId, unitId), current, isNotNull(residents.userId)));
  return rows.map((r) => r.userId!).filter(Boolean);
}
