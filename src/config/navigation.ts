import type { Permission } from "@/server/authz/permissions";

export type NavItem = { label: string; href: (slug: string) => string; anyOf?: Permission[]; icon: string };
export type NavSection = { title?: string; items: NavItem[] };

// only modules that are actually built are listed; later iterations append here
export const NAV: NavSection[] = [
  { items: [{ label: "Dashboard", href: (s) => `/o/${s}/dashboard`, icon: "home" }] },
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
