import type { Permission } from "@/server/authz/permissions";

export type NavItem = { label: string; href: (slug: string) => string; anyOf?: Permission[]; icon: string };
export type NavSection = { title?: string; items: NavItem[] };

// only modules that are actually built are listed; later iterations append here
export const NAV: NavSection[] = [
  { items: [{ label: "Dashboard", href: (s) => `/o/${s}/dashboard`, icon: "home" }] },
  {
    title: "Operations",
    items: [
      { label: "Maintenance", href: (s) => `/o/${s}/maintenance`, anyOf: ["workorder.read", "workorder.read.assigned", "workorder.read.own", "workorder.create"], icon: "wrench" },
      { label: "Tasks", href: (s) => `/o/${s}/tasks`, anyOf: ["task.read", "task.manage"], icon: "check" },
      { label: "Inspections", href: (s) => `/o/${s}/inspections`, anyOf: ["inspection.read", "inspection.manage"], icon: "clipboard" },
      { label: "Incidents", href: (s) => `/o/${s}/incidents`, anyOf: ["incident.read", "incident.create"], icon: "alert" },
      { label: "Complaints", href: (s) => `/o/${s}/complaints`, anyOf: ["complaint.read", "complaint.create", "complaint.manage"], icon: "message" },
    ],
  },
  {
    title: "Portfolio",
    items: [
      { label: "Properties", href: (s) => `/o/${s}/properties`, anyOf: ["property.read"], icon: "building" },
      { label: "Units", href: (s) => `/o/${s}/units`, anyOf: ["unit.read", "unit.read.own"], icon: "door" },
      { label: "Portfolios", href: (s) => `/o/${s}/portfolios`, anyOf: ["portfolio.read"], icon: "folder" },
    ],
  },
  {
    title: "People",
    items: [
      { label: "Residents", href: (s) => `/o/${s}/residents`, anyOf: ["resident.read"], icon: "user" },
      { label: "Staff", href: (s) => `/o/${s}/staff`, anyOf: ["member.read"], icon: "users" },
      { label: "Vendors", href: (s) => `/o/${s}/vendors`, anyOf: ["vendor.read"], icon: "truck" },
    ],
  },
  {
    title: "Organization",
    items: [
      { label: "General", href: (s) => `/o/${s}/settings`, anyOf: ["org.settings.manage"], icon: "settings" },
      { label: "Members", href: (s) => `/o/${s}/settings/members`, anyOf: ["member.read"], icon: "users" },
      { label: "Maintenance rules", href: (s) => `/o/${s}/settings/maintenance`, anyOf: ["workorder.configure"], icon: "sliders" },
      { label: "Roles", href: (s) => `/o/${s}/settings/roles`, anyOf: ["role.read"], icon: "shield" },
      { label: "Audit log", href: (s) => `/o/${s}/settings/audit`, anyOf: ["audit.read"], icon: "list" },
    ],
  },
];

// filters nav by the principal's permissions (cosmetic; the server enforces access)
export function visibleNav(permissions: ReadonlySet<string>): NavSection[] {
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.anyOf || i.anyOf.some((p) => permissions.has(p))) })).filter((s) => s.items.length);
}
