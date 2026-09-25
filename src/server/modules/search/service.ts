import "server-only";
import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { buildings, memberships, properties, residents, roles, units, users, vendors } from "../../db/schema";
import { can } from "../../authz/authorize";
import { tenantTx, type TenantCtx } from "../context";
import { matches, scopeCondition, toPrefixQuery, visiblePropertyIds } from "../scope";

export type SearchHit = { type: "property" | "building" | "unit" | "resident" | "vendor" | "staff"; id: string; title: string; subtitle: string; href: string };

// permission-aware global search; each entity type is only queried when the principal may read it
export async function globalSearch(ctx: TenantCtx, q: string, perType = 5): Promise<SearchHit[]> {
  const p = ctx.principal;
  const tsq = toPrefixQuery(q);
  if (!tsq) return [];
  const base = `/o/${p.orgSlug}`;
  const visible = visiblePropertyIds(p);
  const propIn = (col: typeof properties.id) => (visible ? (visible.length ? inArray(col, visible) : sql`false`) : undefined);
  const limit = Math.min(Math.max(perType, 1), 20);

  return tenantTx(ctx, async (tx) => {
    const hits: SearchHit[] = [];
    if (can(p, "property.read")) {
      const rows = await tx.select({ id: properties.id, name: properties.name, code: properties.code, city: properties.city }).from(properties)
        .where(and(eq(properties.orgId, p.orgId), propIn(properties.id), matches("properties", tsq))).orderBy(asc(properties.name)).limit(limit);
      hits.push(...rows.map((r) => ({ type: "property" as const, id: r.id, title: r.name, subtitle: [r.code, r.city].filter(Boolean).join(" · "), href: `${base}/properties/${r.id}` })));
      const bRows = await tx.select({ id: buildings.id, name: buildings.name, property: properties.name }).from(buildings)
        .innerJoin(properties, eq(properties.id, buildings.propertyId))
        .where(and(eq(buildings.orgId, p.orgId), scopeCondition(p, { property: buildings.propertyId, building: buildings.id }), matches("buildings", tsq)))
        .orderBy(asc(buildings.name)).limit(limit);
      hits.push(...bRows.map((r) => ({ type: "building" as const, id: r.id, title: r.name, subtitle: r.property, href: `${base}/buildings/${r.id}` })));
    }
    if (can(p, "unit.read") || p.permissions.has("unit.read.own")) {
      const scope = p.permissions.has("unit.read")
        ? scopeCondition(p, { property: units.propertyId, building: units.buildingId })
        : p.unitIds.size ? inArray(units.id, [...p.unitIds]) : sql`false`;
      const rows = await tx.select({ id: units.id, number: units.number, building: buildings.name, property: properties.name }).from(units)
        .innerJoin(buildings, eq(buildings.id, units.buildingId)).innerJoin(properties, eq(properties.id, units.propertyId))
        .where(and(eq(units.orgId, p.orgId), scope, matches("units", tsq))).orderBy(asc(properties.name), asc(units.number)).limit(limit);
      hits.push(...rows.map((r) => ({ type: "unit" as const, id: r.id, title: `Unit ${r.number}`, subtitle: `${r.building} · ${r.property}`, href: `${base}/units/${r.id}` })));
    }
    if (can(p, "resident.read")) {
      const inScope = p.role.scopeLevel === "org" ? undefined : sql`exists (select 1 from unit_occupancies o join units u on u.id = o.unit_id
        where o.resident_id = residents.id and (o.ends_on is null or o.ends_on >= current_date)
        and ${scopeCondition(p, { property: sql.raw("u.property_id"), building: sql.raw("u.building_id") }) ?? sql`true`})`;
      const rows = await tx.select({
        id: residents.id, first: residents.firstName, last: residents.lastName,
        unit: sql<string | null>`(select b.code || '-' || u.number || ' · ' || pr.name from unit_occupancies o join units u on u.id = o.unit_id
          join buildings b on b.id = u.building_id join properties pr on pr.id = u.property_id
          where o.resident_id = residents.id and (o.ends_on is null or o.ends_on >= current_date) order by o.is_primary desc limit 1)`,
      }).from(residents).where(and(eq(residents.orgId, p.orgId), inScope, matches("residents", tsq))).orderBy(asc(residents.lastName)).limit(limit);
      hits.push(...rows.map((r) => ({ type: "resident" as const, id: r.id, title: `${r.first} ${r.last}`, subtitle: r.unit ?? "No current unit", href: `${base}/residents/${r.id}` })));
    }
    if (can(p, "vendor.read")) {
      const rows = await tx.select({ id: vendors.id, name: vendors.name, categories: vendors.categories }).from(vendors)
        .where(and(eq(vendors.orgId, p.orgId), matches("vendors", tsq))).orderBy(asc(vendors.name)).limit(limit);
      hits.push(...rows.map((r) => ({ type: "vendor" as const, id: r.id, title: r.name, subtitle: r.categories.map((c) => c.replace(/_/g, " ")).join(", ") || "Vendor", href: `${base}/vendors/${r.id}` })));
    }
    if (can(p, "member.read")) {
      const like = `%${q.trim().replace(/[%_\\]/g, "\\$&")}%`;
      const rows = await tx.select({ id: memberships.id, name: users.name, role: roles.name }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId)).innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(and(eq(memberships.orgId, p.orgId), eq(roles.category, "staff"), eq(memberships.status, "active"), or(ilike(users.name, like), ilike(users.email, like))))
        .orderBy(asc(users.name)).limit(limit);
      hits.push(...rows.map((r) => ({ type: "staff" as const, id: r.id, title: r.name, subtitle: r.role, href: `${base}/staff/${r.id}` })));
    }
    return hits;
  });
}
