import "server-only";
import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { documents } from "../../db/schema";
import { can, type Principal } from "../../authz/authorize";
import { scopeCondition } from "../scope";

type Doc = Pick<typeof documents.$inferSelect, "orgId" | "propertyId" | "buildingId" | "unitId" | "audience" | "status">;

const res = (d: Doc) => ({ orgId: d.orgId, propertyId: d.propertyId, buildingId: d.buildingId });

// managers: document.manage on the property (org-wide documents need an org-wide role)
export function canManageDocument(p: Principal, d: Doc): boolean {
  if (d.orgId !== p.orgId) return false;
  return d.propertyId ? can(p, "document.manage", res(d)) : p.role.scopeLevel === "org" && can(p, "document.manage");
}

// staff read everything in scope (incl. org-wide); residents read published documents for their audience and place
export function canReadDocument(p: Principal, d: Doc): boolean {
  if (d.orgId !== p.orgId) return false;
  if (canManageDocument(p, d)) return true;
  if (!p.permissions.has("document.read")) return false;
  if (p.role.category === "staff") return d.propertyId ? can(p, "document.read", res(d)) : true;
  if (p.role.category !== "resident" || d.status !== "active" || d.audience === "staff") return false;
  if (d.audience === "owners" && p.role.key !== "owner") return false;
  if (d.unitId) return p.unitIds.has(d.unitId);
  if (d.buildingId) return p.occupantBuildingIds.has(d.buildingId);
  if (d.propertyId) return p.occupantPropertyIds.has(d.propertyId);
  return true;
}

// the same rule as SQL, for lists and search
export function documentVisibleWhere(p: Principal): SQL {
  if (!p.permissions.has("document.read") && !p.permissions.has("document.manage")) return sql`false`;
  if (p.role.category === "staff") {
    return or(isNull(documents.propertyId), scopeCondition(p, { property: documents.propertyId, building: documents.buildingId }) ?? sql`true`) ?? sql`false`;
  }
  if (p.role.category !== "resident") return sql`false`;
  const units = [...p.unitIds], blds = [...p.occupantBuildingIds], props = [...p.occupantPropertyIds];
  const place = or(
    units.length ? inArray(documents.unitId, units) : undefined,
    and(isNull(documents.unitId), blds.length ? inArray(documents.buildingId, blds) : sql`false`),
    and(isNull(documents.unitId), isNull(documents.buildingId), props.length ? inArray(documents.propertyId, props) : sql`false`),
    and(isNull(documents.unitId), isNull(documents.buildingId), isNull(documents.propertyId)),
  );
  return and(
    eq(documents.status, "active"),
    ne(documents.audience, "staff"),
    p.role.key === "owner" ? undefined : ne(documents.audience, "owners"),
    place,
  ) ?? sql`false`;
}
