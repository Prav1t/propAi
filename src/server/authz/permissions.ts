// permission catalog — single source of truth, synced to the `permissions` table on migrate
export const PERMISSIONS = {
  // organization
  "org.read": { module: "organization", description: "View organization profile" },
  "org.settings.manage": { module: "organization", description: "Edit organization settings" },
  "member.read": { module: "organization", description: "View team members" },
  "member.manage": { module: "organization", description: "Invite, change roles, deactivate members" },
  "role.read": { module: "organization", description: "View roles and permissions" },
  "audit.read": { module: "organization", description: "View the audit log" },
  // portfolio
  "portfolio.read": { module: "portfolio", description: "View portfolios" },
  "portfolio.manage": { module: "portfolio", description: "Create and edit portfolios" },
  "property.read": { module: "portfolio", description: "View properties, buildings, floors" },
  "property.manage": { module: "portfolio", description: "Create and edit properties, buildings, floors" },
  "unit.read": { module: "portfolio", description: "View units" },
  "unit.read.own": { module: "portfolio", description: "View own unit(s)" },
  "unit.manage": { module: "portfolio", description: "Create and edit units" },
  "resident.read": { module: "people", description: "View residents and occupancies" },
  "resident.manage": { module: "people", description: "Create and edit residents and occupancies" },
  // operations (enforced from Iteration 3)
  "workorder.read": { module: "maintenance", description: "View all work orders in scope" },
  "workorder.read.own": { module: "maintenance", description: "View own submitted work orders" },
  "workorder.read.assigned": { module: "maintenance", description: "View work orders assigned to me / my company" },
  "workorder.create": { module: "maintenance", description: "Submit work orders" },
  "workorder.manage": { module: "maintenance", description: "Triage, assign, update work orders" },
  "vendor.read": { module: "vendors", description: "View vendors" },
  "vendor.manage": { module: "vendors", description: "Manage vendors" },
  "task.read": { module: "tasks", description: "View tasks" },
  "task.manage": { module: "tasks", description: "Create and assign tasks" },
  "inspection.read": { module: "inspections", description: "View inspections" },
  "inspection.manage": { module: "inspections", description: "Schedule and perform inspections" },
  "incident.read": { module: "incidents", description: "View incidents" },
  "incident.create": { module: "incidents", description: "Report incidents" },
  "incident.manage": { module: "incidents", description: "Manage incidents" },
  "complaint.read": { module: "complaints", description: "View complaints" },
  "complaint.create": { module: "complaints", description: "Submit complaints" },
  "complaint.manage": { module: "complaints", description: "Manage complaints" },
  // community (enforced from Iteration 4–5)
  "amenity.read": { module: "amenities", description: "View amenities" },
  "amenity.manage": { module: "amenities", description: "Configure amenities" },
  "booking.create": { module: "amenities", description: "Book amenities" },
  "booking.manage": { module: "amenities", description: "Approve and manage all bookings" },
  "package.read.own": { module: "packages", description: "View own packages" },
  "package.manage": { module: "packages", description: "Log and release packages" },
  "visitor.manage": { module: "visitors", description: "Register and check in visitors" },
  "parking.manage": { module: "parking", description: "Manage parking" },
  "announcement.read": { module: "communications", description: "Read announcements" },
  "announcement.manage": { module: "communications", description: "Publish announcements" },
  "message.use": { module: "communications", description: "Send and receive messages" },
  "document.read": { module: "documents", description: "Read documents visible to me" },
  "document.manage": { module: "documents", description: "Upload and manage documents" },
  "shift.manage": { module: "staff", description: "Manage shifts and handoffs" },
  "asset.read": { module: "facility", description: "View assets" },
  "asset.manage": { module: "facility", description: "Manage assets and preventive maintenance" },
  "finance.read": { module: "finance", description: "View costs and financial data" },
  "meeting.read": { module: "governance", description: "View meetings and minutes" },
  "meeting.manage": { module: "governance", description: "Run meetings, motions, votes" },
  "analytics.read": { module: "analytics", description: "View analytics and reports" },
  "ai.use": { module: "ai", description: "Use the AI assistant" },
  "ai.settings.manage": { module: "ai", description: "Configure AI policies" },
} as const satisfies Record<string, { module: string; description: string }>;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(v: string): v is Permission {
  return v in PERMISSIONS;
}
