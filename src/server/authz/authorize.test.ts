import { describe, expect, it } from "vitest";
import { authorize, can, ForbiddenError, NotFoundError, scopeFilter, type Principal } from "./authorize";
import { SYSTEM_ROLES } from "./system-roles";

const ORG = "org-a";
const role = (key: string) => {
  const r = SYSTEM_ROLES.find((x) => x.key === key)!;
  return { id: key, key, name: r.name, scopeLevel: r.scopeLevel, category: r.category };
};
function principal(key: string, over: Partial<Principal> = {}): Principal {
  return {
    userId: "u1", orgId: ORG, orgSlug: "a", membershipId: "m1", role: role(key),
    permissions: new Set(SYSTEM_ROLES.find((x) => x.key === key)!.permissions),
    portfolioIds: new Set(), propertyIds: new Set(), buildingIds: new Set(), partialPropertyIds: new Set(),
    unitIds: new Set(), occupantBuildingIds: new Set(), occupantPropertyIds: new Set(), residentId: null, vendorId: null,
    ...over,
  };
}

describe("authorize: organization boundary", () => {
  it("never allows a resource from another org, even for org admins", () => {
    const admin = principal("org_admin");
    expect(can(admin, "property.read", { orgId: "org-b", propertyId: "p1" })).toBe(false);
    expect(() => authorize(admin, "property.read", { orgId: "org-b", propertyId: "p1" })).toThrow(NotFoundError);
  });
  it("org-wide roles can act on any property in their org", () => {
    expect(can(principal("org_admin"), "property.manage", { orgId: ORG, propertyId: "p9" })).toBe(true);
  });
});

describe("authorize: scoped roles", () => {
  const pm = principal("property_manager", { propertyIds: new Set(["pA"]) });
  it("allows the assigned property", () => {
    expect(can(pm, "unit.read", { orgId: ORG, propertyId: "pA", buildingId: "b1", unitId: "u1" })).toBe(true);
  });
  it("denies a different property in the same org", () => {
    expect(can(pm, "unit.read", { orgId: ORG, propertyId: "pB", buildingId: "b2" })).toBe(false);
    expect(() => authorize(pm, "unit.read", { orgId: ORG, propertyId: "pB" })).toThrow(ForbiddenError);
  });
  it("denies org-level administration", () => {
    expect(can(pm, "member.manage")).toBe(false);
    expect(can(pm, "org.settings.manage")).toBe(false);
    expect(can(pm, "audit.read")).toBe(false);
  });
  it("building scope grants its building and read-only view of the parent property", () => {
    const tech = principal("building_manager", { buildingIds: new Set(["b1"]), partialPropertyIds: new Set(["pA"]) });
    expect(can(tech, "unit.read", { orgId: ORG, propertyId: "pA", buildingId: "b1" })).toBe(true);
    expect(can(tech, "unit.read", { orgId: ORG, propertyId: "pA", buildingId: "b2" })).toBe(false);
    expect(can(tech, "property.read", { orgId: ORG, propertyId: "pA" })).toBe(true);
    expect(can(tech, "resident.manage", { orgId: ORG, propertyId: "pA" })).toBe(false);
  });
  it("a scoped role with no scopes sees nothing", () => {
    const none = principal("property_manager");
    expect(scopeFilter(none)).toEqual({ kind: "none" });
    expect(can(none, "property.read", { orgId: ORG, propertyId: "pA" })).toBe(false);
  });
});

describe("authorize: residents (occupant scope)", () => {
  const res = principal("resident", { unitIds: new Set(["u1"]), occupantBuildingIds: new Set(["b1"]), occupantPropertyIds: new Set(["pA"]) });
  it("can read their own unit via unit.read.own", () => {
    expect(can(res, "unit.read", { orgId: ORG, propertyId: "pA", unitId: "u1" })).toBe(true);
  });
  it("cannot read a neighbour's unit", () => {
    expect(can(res, "unit.read", { orgId: ORG, propertyId: "pA", unitId: "u2" })).toBe(false);
  });
  it("cannot read the resident directory", () => {
    expect(can(res, "resident.read", { orgId: ORG, propertyId: "pA" })).toBe(false);
    expect(can(res, "resident.read")).toBe(false);
  });
  it("sees only their own work orders", () => {
    expect(can(res, "workorder.read", { orgId: ORG, propertyId: "pA", ownerUserId: "u1" })).toBe(true);
    expect(can(res, "workorder.read", { orgId: ORG, propertyId: "pA", ownerUserId: "someone-else" })).toBe(false);
  });
  it("community reads are limited to their own property", () => {
    expect(can(res, "amenity.read", { orgId: ORG, propertyId: "pA" })).toBe(true);
    expect(can(res, "amenity.read", { orgId: ORG, propertyId: "pB" })).toBe(false);
  });
});

describe("authorize: vendors (assigned scope)", () => {
  const vendor = principal("vendor", { vendorId: "v1" });
  it("sees only work assigned to their company", () => {
    expect(can(vendor, "workorder.read", { orgId: ORG, propertyId: "pA", vendorId: "v1" })).toBe(true);
    expect(can(vendor, "workorder.read", { orgId: ORG, propertyId: "pA", vendorId: "v2" })).toBe(false);
    expect(can(vendor, "property.read", { orgId: ORG, propertyId: "pA" })).toBe(false);
    expect(scopeFilter(vendor)).toEqual({ kind: "none" });
  });
});
