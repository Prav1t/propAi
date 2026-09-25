import { ALL_PERMISSIONS, type Permission } from "./permissions";

export type ScopeLevel = "org" | "scoped" | "occupant" | "assigned";
export type RoleCategory = "staff" | "resident" | "external";

export type SystemRole = {
  key: string;
  name: string;
  description: string;
  category: RoleCategory;
  scopeLevel: ScopeLevel;
  permissions: Permission[];
};

// org-level administration stays with org admins (audit log spans every property)
const exceptOrgAdmin = (p: Permission) => !["org.settings.manage", "member.manage", "ai.settings.manage", "audit.read"].includes(p);

const OPS_READ: Permission[] = [
  "org.read", "member.read", "portfolio.read", "property.read", "unit.read", "resident.read",
  "workorder.read", "vendor.read", "task.read", "inspection.read", "incident.read", "complaint.read",
  "amenity.read", "announcement.read", "document.read", "asset.read", "meeting.read", "message.use", "ai.use",
];

const RESIDENT_BASE: Permission[] = [
  "org.read", "unit.read.own", "workorder.read.own", "workorder.create", "incident.create", "complaint.create",
  "amenity.read", "booking.create", "package.read.own", "announcement.read", "message.use", "document.read", "ai.use",
];

// system roles are seeded on every migrate; keys are stable identifiers
export const SYSTEM_ROLES: SystemRole[] = [
  {
    key: "org_admin", name: "Organization Admin", category: "staff", scopeLevel: "org",
    description: "Full control of the organization, members and settings.",
    permissions: ALL_PERMISSIONS,
  },
  {
    key: "portfolio_manager", name: "Portfolio Manager", category: "staff", scopeLevel: "scoped",
    description: "Manages every property in assigned portfolios.",
    permissions: ALL_PERMISSIONS.filter(exceptOrgAdmin),
  },
  {
    key: "property_manager", name: "Property Manager", category: "staff", scopeLevel: "scoped",
    description: "Manages assigned properties end to end.",
    permissions: ALL_PERMISSIONS.filter(exceptOrgAdmin).filter((p) => p !== "portfolio.manage"),
  },
  {
    key: "building_manager", name: "Building Manager", category: "staff", scopeLevel: "scoped",
    description: "Runs day-to-day operations of assigned buildings.",
    permissions: [...OPS_READ, "workorder.manage", "workorder.create", "task.manage", "inspection.manage",
      "incident.create", "incident.manage", "complaint.manage", "booking.manage", "package.manage", "visitor.manage",
      "parking.manage", "announcement.manage", "shift.manage", "resident.manage", "analytics.read"],
  },
  {
    key: "facility_manager", name: "Facility Manager", category: "staff", scopeLevel: "scoped",
    description: "Assets, preventive maintenance, inspections and vendors.",
    permissions: [...OPS_READ, "workorder.manage", "workorder.create", "vendor.manage", "task.manage",
      "inspection.manage", "incident.create", "incident.manage", "asset.manage", "finance.read", "analytics.read"],
  },
  {
    key: "staff", name: "Staff", category: "staff", scopeLevel: "scoped",
    description: "General building staff.",
    permissions: ["org.read", "property.read", "unit.read", "task.read", "incident.read", "incident.create",
      "announcement.read", "document.read", "message.use", "ai.use"],
  },
  {
    key: "maintenance_staff", name: "Maintenance Staff", category: "staff", scopeLevel: "scoped",
    description: "Works on assigned work orders and tasks.",
    permissions: ["org.read", "property.read", "unit.read", "workorder.read.assigned", "workorder.create",
      "task.read", "inspection.read", "incident.create", "asset.read", "announcement.read", "document.read",
      "message.use", "ai.use"],
  },
  {
    key: "concierge", name: "Concierge", category: "staff", scopeLevel: "scoped",
    description: "Front desk: packages, visitors, resident questions, shift logs.",
    permissions: ["org.read", "property.read", "unit.read", "resident.read", "workorder.create", "task.read",
      "incident.read", "incident.create", "complaint.create", "amenity.read", "booking.manage", "package.manage",
      "visitor.manage", "parking.manage", "announcement.read", "document.read", "shift.manage", "message.use", "ai.use"],
  },
  {
    key: "security", name: "Security", category: "staff", scopeLevel: "scoped",
    description: "Incidents, visitors, parking enforcement, patrol logs.",
    permissions: ["org.read", "property.read", "unit.read", "resident.read", "incident.read", "incident.create",
      "incident.manage", "visitor.manage", "parking.manage", "announcement.read", "document.read", "shift.manage",
      "message.use", "ai.use"],
  },
  {
    key: "accountant", name: "Accountant", category: "staff", scopeLevel: "org",
    description: "Read access to costs, vendors and reports.",
    permissions: ["org.read", "portfolio.read", "property.read", "unit.read", "vendor.read", "workorder.read",
      "finance.read", "analytics.read", "document.read"],
  },
  {
    key: "council_member", name: "Strata Council Member", category: "staff", scopeLevel: "scoped",
    description: "Governance: meetings, motions, bylaws and reports.",
    permissions: ["org.read", "property.read", "unit.read", "workorder.read", "complaint.read", "incident.read",
      "announcement.read", "document.read", "meeting.read", "meeting.manage", "finance.read", "analytics.read",
      "message.use", "ai.use"],
  },
  {
    key: "vendor", name: "Vendor", category: "external", scopeLevel: "assigned",
    description: "Sees only work orders assigned to their company.",
    permissions: ["org.read", "workorder.read.assigned", "message.use"],
  },
  { key: "resident", name: "Resident", category: "resident", scopeLevel: "occupant",
    description: "Lives in a unit.", permissions: RESIDENT_BASE },
  { key: "tenant", name: "Tenant", category: "resident", scopeLevel: "occupant",
    description: "Rents a unit.", permissions: RESIDENT_BASE },
  { key: "owner", name: "Owner", category: "resident", scopeLevel: "occupant",
    description: "Owns a unit.", permissions: [...RESIDENT_BASE, "meeting.read"] },
  { key: "occupant", name: "Occupant", category: "resident", scopeLevel: "occupant",
    description: "Other household member.", permissions: RESIDENT_BASE.filter((p) => p !== "booking.create") },
];

export const SYSTEM_ROLE_KEYS = SYSTEM_ROLES.map((r) => r.key);
