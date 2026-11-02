import type { Permission } from "@/server/authz/permissions";

export type NavItem = {
  label: string; href: (slug: string) => string; anyOf?: Permission[]; icon: string;
  badgeKey?: string; // filled in by the layout with a live count
  residentLabel?: string; // wording for resident roles
  residentsAlso?: Permission[]; // extra permissions that unlock the item for resident roles only
};
export type NavSection = { title?: string; items: NavItem[] };

// only modules that are actually built are listed; later iterations append here
export const NAV: NavSection[] = [
  { items: [
    { label: "Dashboard", href: (s) => `/o/${s}/dashboard`, icon: "home" },
    { label: "Assistant", href: (s) => `/o/${s}/assistant`, anyOf: ["ai.use"], icon: "sparkle" },
    { label: "Analytics", href: (s) => `/o/${s}/analytics`, anyOf: ["analytics.read"], icon: "chart" },
    { label: "Automations", href: (s) => `/o/${s}/automations`, anyOf: ["automation.manage"], icon: "bolt", badgeKey: "approvals" },
  ] },
  {
    title: "Operations",
    items: [
      { label: "Maintenance", href: (s) => `/o/${s}/maintenance`, anyOf: ["workorder.read", "workorder.read.assigned", "workorder.read.own", "workorder.create"], icon: "wrench" },
      { label: "Tasks", href: (s) => `/o/${s}/tasks`, anyOf: ["task.read", "task.manage"], icon: "check" },
      { label: "Inspections", href: (s) => `/o/${s}/inspections`, anyOf: ["inspection.read", "inspection.manage"], icon: "clipboard" },
      { label: "Incidents", href: (s) => `/o/${s}/incidents`, anyOf: ["incident.read", "incident.create"], icon: "alert" },
      { label: "Complaints", href: (s) => `/o/${s}/complaints`, anyOf: ["complaint.read", "complaint.create", "complaint.manage"], icon: "flag" },
      { label: "Assets", href: (s) => `/o/${s}/assets`, anyOf: ["asset.read", "asset.manage"], icon: "gear" },
      { label: "Calendar", href: (s) => `/o/${s}/calendar`, anyOf: ["workorder.read", "workorder.read.assigned", "inspection.read", "booking.manage", "visitor.manage", "shift.read", "asset.read", "task.read"], icon: "clock" },
    ],
  },
  {
    title: "Community",
    items: [
      { label: "Front desk", href: (s) => `/o/${s}/desk`, anyOf: ["visitor.manage", "package.manage"], icon: "desk" },
      { label: "Visitors", residentLabel: "My guests", href: (s) => `/o/${s}/visitors`, anyOf: ["visitor.manage", "visitor.invite"], icon: "badge", badgeKey: "visitors" },
      { label: "Parking", residentLabel: "My parking", href: (s) => `/o/${s}/parking`, anyOf: ["parking.manage", "parking.use"], icon: "car", badgeKey: "parking" },
      { label: "Amenities", residentLabel: "Book amenities", href: (s) => `/o/${s}/amenities`, anyOf: ["amenity.read", "amenity.manage", "booking.manage"], icon: "calendar", badgeKey: "bookings" },
      { label: "Packages", residentLabel: "My packages", href: (s) => `/o/${s}/packages`, anyOf: ["package.manage", "package.read.own"], icon: "box", badgeKey: "packages" },
      { label: "Announcements", href: (s) => `/o/${s}/announcements`, anyOf: ["announcement.read", "announcement.manage"], icon: "megaphone", badgeKey: "announcements" },
      { label: "Messages", href: (s) => `/o/${s}/messages`, anyOf: ["message.manage"], residentsAlso: ["message.use"], icon: "message", badgeKey: "messages" },
      { label: "Documents", href: (s) => `/o/${s}/documents`, anyOf: ["document.read", "document.manage"], icon: "file" },
      { label: "Knowledge base", href: (s) => `/o/${s}/knowledge`, anyOf: ["knowledge.manage"], icon: "book" },
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
      { label: "Shifts", href: (s) => `/o/${s}/shifts`, anyOf: ["shift.read", "shift.manage"], icon: "clock" },
      { label: "Vendors", href: (s) => `/o/${s}/vendors`, anyOf: ["vendor.read"], icon: "truck" },
    ],
  },
  {
    title: "Organization",
    items: [
      { label: "General", href: (s) => `/o/${s}/settings`, anyOf: ["org.settings.manage"], icon: "settings" },
      { label: "Members", href: (s) => `/o/${s}/settings/members`, anyOf: ["member.read"], icon: "users" },
      { label: "Maintenance rules", href: (s) => `/o/${s}/settings/maintenance`, anyOf: ["workorder.configure"], icon: "sliders" },
      { label: "AI assistant", href: (s) => `/o/${s}/settings/ai`, anyOf: ["ai.settings.manage"], icon: "sparkle" },
      { label: "Analytics & automation", href: (s) => `/o/${s}/settings/analytics`, anyOf: ["org.settings.manage"], icon: "chart" },
      { label: "Billing", href: (s) => `/o/${s}/settings/billing`, anyOf: ["billing.manage"], icon: "card" },
      { label: "Integrations", href: (s) => `/o/${s}/settings/integrations`, anyOf: ["integration.manage"], icon: "plug" },
      { label: "Developers", href: (s) => `/o/${s}/settings/developers`, anyOf: ["api.manage"], icon: "code" },
      { label: "Security", href: (s) => `/o/${s}/settings/security`, anyOf: ["security.manage"], icon: "shield" },
      { label: "Privacy", href: (s) => `/o/${s}/settings/privacy`, anyOf: ["privacy.manage"], icon: "lock" },
      { label: "Roles", href: (s) => `/o/${s}/settings/roles`, anyOf: ["role.read"], icon: "shield" },
      { label: "Audit log", href: (s) => `/o/${s}/settings/audit`, anyOf: ["audit.read"], icon: "list" },
    ],
  },
];

// filters nav by the principal's permissions (cosmetic; the server enforces access)
export function visibleNav(permissions: ReadonlySet<string>, category: string = "staff"): NavSection[] {
  const ok = (i: NavItem) => !i.anyOf || i.anyOf.some((p) => permissions.has(p)) || (category === "resident" && !!i.residentsAlso?.some((p) => permissions.has(p)));
  return NAV.map((s) => ({ ...s, items: s.items.filter(ok).map((i) => (category === "resident" && i.residentLabel ? { ...i, label: i.residentLabel } : i)) })).filter((s) => s.items.length);
}

// phone bottom bar: the few places each kind of role goes most, shown when it leaves at least two
export type BottomTab = { label: string; href: (slug: string) => string; icon: string; anyOf?: Permission[]; badgeKey?: string };
const TAB = {
  home: { label: "Home", href: (s: string) => `/o/${s}/dashboard`, icon: "home" },
  assistant: { label: "Assistant", href: (s: string) => `/o/${s}/assistant`, icon: "sparkle", anyOf: ["ai.use"] },
} satisfies Record<string, BottomTab>;
const BOTTOM_TABS: Record<"resident" | "frontdesk" | "maintenance" | "facility" | "vendor" | "manager", BottomTab[]> = {
  resident: [
    TAB.home,
    { label: "Requests", href: (s) => `/o/${s}/maintenance`, icon: "wrench", anyOf: ["workorder.create"] },
    { label: "Book", href: (s) => `/o/${s}/amenities`, icon: "calendar", anyOf: ["amenity.read"] },
    { label: "Packages", href: (s) => `/o/${s}/packages`, icon: "box", anyOf: ["package.read.own"], badgeKey: "packages" },
    { label: "Messages", href: (s) => `/o/${s}/messages`, icon: "message", anyOf: ["message.use"], badgeKey: "messages" },
  ],
  frontdesk: [
    { label: "Desk", href: (s) => `/o/${s}/desk`, icon: "desk", anyOf: ["visitor.manage", "package.manage"] },
    { label: "Packages", href: (s) => `/o/${s}/packages`, icon: "box", anyOf: ["package.manage"] },
    { label: "Visitors", href: (s) => `/o/${s}/visitors`, icon: "badge", anyOf: ["visitor.manage"], badgeKey: "visitors" },
    { label: "Incidents", href: (s) => `/o/${s}/incidents`, icon: "alert", anyOf: ["incident.read", "incident.create"] },
    { label: "Messages", href: (s) => `/o/${s}/messages`, icon: "message", anyOf: ["message.manage"], badgeKey: "messages" },
  ],
  maintenance: [
    TAB.home,
    { label: "My jobs", href: (s) => `/o/${s}/maintenance?view=mine`, icon: "wrench", anyOf: ["workorder.read", "workorder.read.assigned"] },
    { label: "Tasks", href: (s) => `/o/${s}/tasks?view=mine`, icon: "check", anyOf: ["task.read", "task.manage"] },
    { label: "Inspections", href: (s) => `/o/${s}/inspections`, icon: "clipboard", anyOf: ["inspection.read", "inspection.manage"] },
    { label: "Shifts", href: (s) => `/o/${s}/shifts`, icon: "clock", anyOf: ["shift.read", "shift.manage"] },
  ],
  facility: [
    TAB.home,
    { label: "Assets", href: (s) => `/o/${s}/assets`, icon: "gear", anyOf: ["asset.read", "asset.manage"] },
    { label: "Work", href: (s) => `/o/${s}/maintenance`, icon: "wrench", anyOf: ["workorder.read", "workorder.read.assigned"] },
    { label: "Inspections", href: (s) => `/o/${s}/inspections`, icon: "clipboard", anyOf: ["inspection.read", "inspection.manage"] },
    { label: "Calendar", href: (s) => `/o/${s}/calendar`, icon: "clock", anyOf: ["workorder.read", "inspection.read", "asset.read"] },
  ],
  vendor: [
    TAB.home,
    { label: "Jobs", href: (s) => `/o/${s}/maintenance`, icon: "wrench", anyOf: ["workorder.read.assigned", "workorder.read"] },
  ],
  manager: [
    TAB.home,
    { label: "Maintenance", href: (s) => `/o/${s}/maintenance`, icon: "wrench", anyOf: ["workorder.read"] },
    { label: "Tasks", href: (s) => `/o/${s}/tasks`, icon: "check", anyOf: ["task.read", "task.manage"] },
    { label: "Approvals", href: (s) => `/o/${s}/automations?tab=approvals`, icon: "bolt", anyOf: ["automation.manage"], badgeKey: "approvals" },
    TAB.assistant,
  ],
};

export function bottomTabsFor(role: { key: string; category: string; scopeLevel: string }, permissions: ReadonlySet<string>): BottomTab[] {
  const set = role.scopeLevel === "occupant" ? "resident"
    : ["concierge", "security"].includes(role.key) ? "frontdesk"
    : ["maintenance_staff", "staff"].includes(role.key) ? "maintenance"
    : role.key === "facility_manager" ? "facility"
    : role.category === "external" ? "vendor"
    : "manager";
  const tabs = BOTTOM_TABS[set].filter((t) => !t.anyOf || t.anyOf.some((p) => permissions.has(p)));
  return tabs.length >= 2 ? tabs : [];
}
