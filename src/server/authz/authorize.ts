import type { Permission } from "./permissions";
import type { RoleCategory, ScopeLevel } from "./system-roles";

// everything the server knows about "who is acting, where"
export type Principal = {
  userId: string;
  orgId: string;
  orgSlug: string;
  membershipId: string;
  role: { id: string; key: string; name: string; scopeLevel: ScopeLevel; category: RoleCategory };
  permissions: ReadonlySet<string>;
  // scoped roles
  portfolioIds: ReadonlySet<string>;
  propertyIds: ReadonlySet<string>; // full access (direct or via portfolio)
  buildingIds: ReadonlySet<string>; // building-level scopes
  partialPropertyIds: ReadonlySet<string>; // parents of building scopes (read-only visibility of the property shell)
  // occupant roles
  unitIds: ReadonlySet<string>;
  occupantBuildingIds: ReadonlySet<string>;
  occupantPropertyIds: ReadonlySet<string>;
  residentId: string | null;
  // assigned roles (Iteration 3)
  vendorId: string | null;
};

export type Resource = {
  orgId: string;
  portfolioId?: string | null;
  propertyId?: string | null;
  buildingId?: string | null;
  unitId?: string | null;
  ownerUserId?: string | null; // record submitted/owned by this user
  assignedUserIds?: string[];
  vendorId?: string | null;
};

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "You don't have permission to do that.") {
    super(message);
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message = "Not found.") {
    super(message);
  }
}

const isReadPermission = (perm: string) => perm.endsWith(".read");

function inScope(p: Principal, perm: string, r: Resource): boolean {
  switch (p.role.scopeLevel) {
    case "org":
      return true;
    case "scoped":
      if (r.buildingId) return p.buildingIds.has(r.buildingId) || (!!r.propertyId && p.propertyIds.has(r.propertyId));
      if (r.propertyId)
        return p.propertyIds.has(r.propertyId) || (isReadPermission(perm) && p.partialPropertyIds.has(r.propertyId));
      if (r.portfolioId) return p.portfolioIds.has(r.portfolioId);
      return false; // org-level resource: scoped roles need an explicit org-level check without a resource
    case "occupant":
      if (r.unitId) return p.unitIds.has(r.unitId);
      if (r.buildingId) return p.occupantBuildingIds.has(r.buildingId);
      if (r.propertyId) return p.occupantPropertyIds.has(r.propertyId);
      return false;
    case "assigned":
      return false;
  }
}

function isOwn(p: Principal, r: Resource): boolean {
  if (r.ownerUserId !== undefined) return r.ownerUserId === p.userId;
  return !!r.unitId && p.unitIds.has(r.unitId);
}

function isAssigned(p: Principal, r: Resource): boolean {
  if (r.assignedUserIds?.includes(p.userId)) return true;
  return !!p.vendorId && !!r.vendorId && p.vendorId === r.vendorId;
}

// the single authorization decision point; UI checks are cosmetic only
export function can(p: Principal, perm: Permission, r?: Resource): boolean {
  if (r && r.orgId !== p.orgId) return false;
  const hasBase = p.permissions.has(perm);
  const hasOwn = p.permissions.has(`${perm}.own`);
  const hasAssigned = p.permissions.has(`${perm}.assigned`);
  if (!hasBase && !hasOwn && !hasAssigned) return false;
  if (!r) return hasBase; // org-level action; list queries must still apply scopeFilter()
  if (hasBase && inScope(p, perm, r)) return true;
  if (hasOwn && isOwn(p, r)) return true;
  if (hasAssigned && isAssigned(p, r)) return true;
  return false;
}

// throws NotFound for cross-org resources (don't confirm existence), Forbidden otherwise
export function authorize(p: Principal, perm: Permission, r?: Resource): void {
  if (r && r.orgId !== p.orgId) throw new NotFoundError();
  if (!can(p, perm, r)) throw new ForbiddenError();
}

export type ScopeFilter =
  | { kind: "all" }
  | { kind: "some"; propertyIds: string[]; buildingIds: string[] }
  | { kind: "units"; unitIds: string[]; buildingIds: string[]; propertyIds: string[] }
  | { kind: "none" };

// what subset of the org's property tree a list query may return
export function scopeFilter(p: Principal): ScopeFilter {
  switch (p.role.scopeLevel) {
    case "org":
      return { kind: "all" };
    case "scoped":
      if (p.propertyIds.size === 0 && p.buildingIds.size === 0) return { kind: "none" };
      return { kind: "some", propertyIds: [...p.propertyIds], buildingIds: [...p.buildingIds] };
    case "occupant":
      return {
        kind: "units",
        unitIds: [...p.unitIds],
        buildingIds: [...p.occupantBuildingIds],
        propertyIds: [...p.occupantPropertyIds],
      };
    case "assigned":
      return { kind: "none" };
  }
}
