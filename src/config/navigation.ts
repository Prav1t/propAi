import type { Permission } from "@/server/authz/permissions";

export type NavItem = { label: string; href: (slug: string) => string; anyOf?: Permission[]; icon: string };
export type NavSection = { title?: string; items: NavItem[] };

// only modules that are actually built are listed; later iterations append here
export const NAV: NavSection[] = [
  { items: [{ label: "Dashboard", href: (s) => `/o/${s}/dashboard`, icon: "home" }] },
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
      { label: "Roles", href: (s) => `/o/${s}/settings/roles`, anyOf: ["role.read"], icon: "shield" },
      { label: "Audit log", href: (s) => `/o/${s}/settings/audit`, anyOf: ["audit.read"], icon: "list" },
    ],
  },
];

// filters nav by the principal's permissions (cosmetic; the server enforces access)
export function visibleNav(permissions: ReadonlySet<string>): NavSection[] {
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.anyOf || i.anyOf.some((p) => permissions.has(p))) })).filter((s) => s.items.length);
}
