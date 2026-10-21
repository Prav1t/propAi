import { describe, expect, it } from "vitest";
import { generateApiKey, looksLikeApiKey, narrowPrincipal } from "./keys";
import { can, scopeFilter, type Principal } from "../authz/authorize";
import { matchRoute, ROUTES } from "./v1/routes";

const ORG = "a0000000-0000-4000-8000-000000000001";
const P1 = "a0000000-0000-4000-8000-0000000000p1".replace("p1", "01");
const P2 = "a0000000-0000-4000-8000-000000000002";

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: "u", orgId: ORG, orgSlug: "acme", membershipId: "m",
  role: { id: "r", key: "org_admin", name: "Organization Admin", scopeLevel: "org", category: "staff" },
  permissions: new Set(["workorder.read", "workorder.create", "workorder.manage", "property.read", "member.manage", "resident.read"]),
  portfolioIds: new Set(), propertyIds: new Set(), buildingIds: new Set(), partialPropertyIds: new Set(),
  unitIds: new Set(), occupantBuildingIds: new Set(), occupantPropertyIds: new Set(), residentId: null, vendorId: null, ...over,
});

describe("API keys", () => {
  it("have a recognisable, high-entropy format", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.token).toMatch(/^ak_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(looksLikeApiKey(a.token)).toBe(true);
    expect(a.token).not.toBe(b.token);
    expect(looksLikeApiKey("ak_short_x")).toBe(false);
    expect(looksLikeApiKey("Bearer something")).toBe(false);
  });
  it("can do only what both the key and its creator allow", () => {
    const p = narrowPrincipal(principal(), { permissions: ["workorder.read", "vendor.read", "member.manage"], propertyIds: [] });
    expect([...p.permissions].sort()).toEqual(["workorder.read"]); // vendor.read: creator lacks it; member.manage: not an API scope
    expect(scopeFilter(p)).toEqual({ kind: "all" });
  });
  it("a property-limited key behaves like a role scoped to those properties", () => {
    const p = narrowPrincipal(principal(), { permissions: ["workorder.read"], propertyIds: [P1] });
    expect(p.role.scopeLevel).toBe("scoped");
    expect(can(p, "workorder.read", { orgId: ORG, propertyId: P1 })).toBe(true);
    expect(can(p, "workorder.read", { orgId: ORG, propertyId: P2 })).toBe(false);
    expect(can(p, "workorder.read", { orgId: "b0000000-0000-4000-8000-000000000009", propertyId: P1 })).toBe(false);
  });
  it("never widens a scoped creator", () => {
    const scoped = principal({ role: { id: "r", key: "property_manager", name: "PM", scopeLevel: "scoped", category: "staff" }, propertyIds: new Set([P1]) });
    const p = narrowPrincipal(scoped, { permissions: ["workorder.read"], propertyIds: [P1, P2] });
    expect([...p.propertyIds]).toEqual([P1]);
  });
});

describe("API routes", () => {
  it("match paths with parameters and report allowed methods", () => {
    const m = matchRoute("GET", `/work-orders/${P1}`);
    expect(m && "route" in m && m.route.operationId).toBe("getWorkOrder");
    expect(m && "route" in m && m.params.id).toBe(P1);
    expect(matchRoute("DELETE", "/work-orders")).toEqual({ allowed: ["GET", "POST"] });
    expect(matchRoute("GET", "/nope")).toBeNull();
  });
  it("every route declares the permission it needs (except /me) and has a unique operation id", () => {
    expect(new Set(ROUTES.map((r) => r.operationId)).size).toBe(ROUTES.length);
    for (const r of ROUTES) if (r.path !== "/me") expect(r.scope, r.operationId).toBeTruthy();
  });
});
