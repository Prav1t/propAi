import "server-only";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Tx } from "../db/client";
import { memberships, roles, users } from "../db/schema";
import { onCallFor } from "../modules/shifts/service";
import type { Recipients, Subject } from "@/lib/automation";

export type Person = { userId: string; membershipId: string; name: string };

// active members whose role is one of `keys` and whose scope covers the property (any scope when there's no property)
export async function membersWithRoleAt(tx: Tx, orgId: string, keys: string[], propertyId: string | null, buildingId: string | null): Promise<Person[]> {
  if (!keys.length) return [];
  const covers = propertyId
    ? or(eq(roles.scopeLevel, "org"), sql`exists (select 1 from membership_scopes s where s.membership_id = ${memberships.id} and (
        s.property_id = ${propertyId}
        or s.portfolio_id = (select portfolio_id from properties where id = ${propertyId})
        or ${buildingId ? sql`s.building_id = ${buildingId}` : sql`s.building_id in (select id from buildings where property_id = ${propertyId})`}))`)
    : undefined;
  const rows = await tx.select({ userId: memberships.userId, membershipId: memberships.id, name: users.name }).from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId)).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active"), inArray(roles.key, keys), covers));
  return rows;
}

async function membersById(tx: Tx, orgId: string, ids: string[]): Promise<Person[]> {
  if (!ids.length) return [];
  return tx.select({ userId: memberships.userId, membershipId: memberships.id, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active"), inArray(memberships.id, ids)));
}

export async function onCallPerson(tx: Tx, orgId: string, propertyId: string | null, buildingId: string | null): Promise<Person | null> {
  if (!propertyId) return null;
  const oc = await onCallFor(tx, orgId, propertyId, buildingId);
  if (!oc) return null;
  const [m] = await membersById(tx, orgId, [oc.membershipId]);
  return m ?? null;
}

// everyone a notify/report step addresses, resolved when the step runs (people change roles and shifts)
export async function resolveRecipients(tx: Tx, orgId: string, r: Recipients, subject: Subject | null, propertyId: string | null): Promise<Person[]> {
  const buildingId = subject?.buildingId ?? null;
  const out = new Map<string, Person>();
  const add = (ps: (Person | null)[]) => ps.forEach((x) => x && out.set(x.userId, x));
  add(await membersWithRoleAt(tx, orgId, r.roles, propertyId, buildingId));
  add(await membersById(tx, orgId, r.members));
  if (r.onCall) add([await onCallPerson(tx, orgId, propertyId, buildingId)]);
  if (r.assignee && subject?.assigneeMembershipId) add(await membersById(tx, orgId, [subject.assigneeMembershipId]));
  if (r.submitter && subject?.submitterUserId) {
    const [u] = await tx.select({ userId: memberships.userId, membershipId: memberships.id, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, subject.submitterUserId), eq(memberships.status, "active")));
    add([u ?? null]);
  }
  return [...out.values()];
}

export const names = (ps: Person[], max = 4) => (ps.length <= max ? ps.map((p) => p.name).join(", ") : `${ps.slice(0, max).map((p) => p.name).join(", ")} and ${ps.length - max} more`);
