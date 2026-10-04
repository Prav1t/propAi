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
