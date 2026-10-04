import { getOrgContext } from "@/server/org-context";
import { visibleNav } from "@/config/navigation";
import { DesktopSidebar, MobileNav } from "@/components/shell/sidebar";
import { UserMenu } from "@/components/shell/user-menu";
import { CommandPalette, type Command } from "@/components/shell/command-palette";
import { can } from "@/server/authz/authorize";
import { searchAction } from "./search-action";
import { unreadCount } from "@/server/modules/notifications/service";
import { Icon } from "@/components/shell/icons";
import Link from "next/link";
import { ResidentTabs } from "@/components/shell/resident-tabs";
import { messageBadgeCount } from "@/server/modules/messaging/service";
import { unreadAnnouncementCount } from "@/server/modules/announcements/service";
import { listPackages, canUsePackages } from "@/server/modules/packages/service";
import { bookingStats } from "@/server/modules/amenities/service";
import { visitorStats } from "@/server/modules/visitors/service";
import { parkingStats } from "@/server/modules/parking/service";
import { BRAND } from "@/config/brand";

export default async function OrgLayout({ children, params }: LayoutProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const { session, principal, ctx } = await getOrgContext(orgSlug);
  const resident = principal.role.category === "resident";
  // live counts for nav badges (each query is permission-scoped and cheap)
  const [unread, messages, announcements, packages, bookings, visitorsOnSite, parkingReview] = await Promise.all([
    unreadCount(ctx),
    messageBadgeCount(ctx),
    resident ? unreadAnnouncementCount(ctx) : Promise.resolve(0),
    resident && canUsePackages(principal) ? listPackages(ctx, { view: "waiting", pageSize: 1 }).then((r) => r.total) : Promise.resolve(0),
    !resident ? bookingStats(ctx).then((r) => r?.pending ?? 0) : Promise.resolve(0),
    !resident ? visitorStats(ctx).then((r) => r?.expectedToday ?? 0) : Promise.resolve(0),
    !resident ? parkingStats(ctx).then((r) => r?.review ?? 0) : Promise.resolve(0),
  ]);
  const badges: Record<string, number> = { messages, announcements, packages, bookings, visitors: visitorsOnSite, parking: parkingReview };
  const sections = visibleNav(principal.permissions, principal.role.category).map((s) => ({
    title: s.title,
    items: s.items.map((i) => ({ label: i.label, icon: i.icon, href: i.href(orgSlug), badge: i.badgeKey ? badges[i.badgeKey] : undefined })),
  }));
  const base = `/o/${orgSlug}`;
  // quick actions shown in the palette, filtered by permission (server still enforces)
  const actions: Command[] = [
    ...(principal.permissions.has("workorder.create") ? [{ label: principal.role.category === "resident" ? "Submit maintenance request" : "Create work order", href: `${base}/maintenance/new`, group: "Action", keywords: "new maintenance request repair fix broken leak" }] : []),
    ...(principal.permissions.has("workorder.read") ? [{ label: "Show overdue work orders", href: `${base}/maintenance?view=overdue`, group: "Action", keywords: "late sla breach" }] : []),
    ...(principal.permissions.has("task.manage") ? [{ label: "Create task", href: `${base}/tasks/new`, group: "Action", keywords: "new todo" }] : []),
    ...(principal.permissions.has("inspection.manage") ? [{ label: "Schedule inspection", href: `${base}/inspections/new`, group: "Action", keywords: "new checklist" }] : []),
    ...(principal.permissions.has("incident.create") ? [{ label: "Report incident", href: `${base}/incidents/new`, group: "Action", keywords: "new security damage injury" }] : []),
    ...(principal.permissions.has("complaint.create") || principal.permissions.has("complaint.manage") ? [{ label: "New complaint", href: `${base}/complaints/new`, group: "Action", keywords: "noise neighbour issue" }] : []),
    ...(principal.permissions.has("booking.create") || principal.permissions.has("booking.manage") ? [{ label: "Book an amenity", href: `${base}/amenities`, group: "Action", keywords: "party room gym reserve booking" }] : []),
    ...(principal.permissions.has("booking.manage") ? [{ label: "Bookings awaiting approval", href: `${base}/amenities/bookings?view=pending`, group: "Action", keywords: "approve requests" }] : []),
    ...(principal.permissions.has("package.manage") ? [{ label: "Log a package", href: `${base}/packages`, group: "Action", keywords: "delivery parcel courier scan" }] : []),
    ...(principal.permissions.has("announcement.manage") ? [{ label: "New announcement", href: `${base}/announcements/new`, group: "Action", keywords: "notice post notify residents" }] : []),
    ...(principal.permissions.has("message.manage") ? [{ label: "Message a resident", href: `${base}/messages/new`, group: "Action", keywords: "contact write" }] : []),
    ...(resident && principal.permissions.has("message.use") ? [{ label: "Message management", href: `${base}/messages/new`, group: "Action", keywords: "contact write question" }] : []),
    ...(principal.permissions.has("document.manage") ? [{ label: "Upload document", href: `${base}/documents/new`, group: "Action", keywords: "bylaws rules file" }] : []),
    ...(principal.permissions.has("visitor.manage") ? [{ label: "Register a visitor", href: `${base}/visitors/new`, group: "Action", keywords: "guest contractor walk in check in" }, { label: "Open the front desk", href: `${base}/desk`, group: "Action", keywords: "concierge scan pass console" }] : []),
    ...(resident && principal.permissions.has("visitor.invite") ? [{ label: "Invite a guest", href: `${base}/visitors/new`, group: "Action", keywords: "visitor pass qr friend family" }] : []),
    ...(principal.permissions.has("parking.manage") ? [{ label: "Report a parking violation", href: `${base}/parking/violations/new`, group: "Action", keywords: "plate tow car vehicle" }, { label: "Look up a licence plate", href: `${base}/parking`, group: "Action", keywords: "plate car vehicle permit" }] : []),
    ...(resident && principal.permissions.has("parking.use") ? [{ label: "Register my vehicle", href: `${base}/parking`, group: "Action", keywords: "car plate parking" }] : []),
    ...(principal.permissions.has("shift.read") ? [{ label: "Write a shift handoff", href: `${base}/shifts/handoff`, group: "Action", keywords: "shift notes next" }] : []),
    ...(principal.permissions.has("shift.manage") ? [{ label: "Schedule a shift", href: `${base}/shifts`, group: "Action", keywords: "staff roster on call" }] : []),
    ...(principal.permissions.has("asset.manage") ? [{ label: "Add asset", href: `${base}/assets/new`, group: "Action", keywords: "equipment hvac elevator" }] : []),
    ...(principal.permissions.has("asset.read") ? [{ label: "Equipment out of service", href: `${base}/assets?status=down`, group: "Action", keywords: "down broken downtime" }] : []),
    { label: "Notifications", href: `${base}/notifications`, group: "Navigate", keywords: "inbox alerts email" },
    ...(principal.role.scopeLevel === "org" && can(principal, "property.manage") ? [{ label: "Create property", href: `${base}/properties/new`, group: "Action", keywords: "new add building" }] : []),
    ...(principal.permissions.has("resident.manage") ? [{ label: "Add resident", href: `${base}/residents/new`, group: "Action", keywords: "new tenant owner move in" }] : []),
    ...(principal.permissions.has("vendor.manage") ? [{ label: "Add vendor", href: `${base}/vendors/new`, group: "Action", keywords: "new contractor" }] : []),
    ...(principal.permissions.has("member.manage") ? [{ label: "Invite teammate", href: `${base}/settings/members`, group: "Action", keywords: "invite user staff" }] : []),
    { label: "Account security", href: "/account/security", group: "Account", keywords: "password 2fa mfa sessions" },
  ];
  const commands: Command[] = [...sections.flatMap((s) => s.items.map((i) => ({ label: `Go to ${i.label}`, href: i.href, group: s.title ?? "Navigate" }))), ...actions];
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <DesktopSidebar sections={sections} orgName={principal.orgName} roleName={principal.role.name} />
      <div className="lg:pl-60">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur ">
          <div className="flex items-center gap-2">
            <MobileNav sections={sections} orgName={principal.orgName} roleName={principal.role.name} />
            <span className="hidden text-sm font-medium sm:inline lg:hidden">{principal.orgName}</span>
            <CommandPalette commands={commands} search={searchAction.bind(null, orgSlug)} searchPage={`${base}/search`}
              ask={principal.permissions.has("ai.use") ? { href: `${base}/assistant`, name: BRAND.assistantName } : null} />
          </div>
          <div className="flex items-center gap-1">
          <Link href={`${base}/notifications`} className="relative inline-flex size-9 items-center justify-center rounded-[var(--radius-md)] text-muted hover:bg-subtle hover:text-fg"
            aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
            <Icon name="bell" className="size-[18px]" />
            {unread ? <span aria-hidden className="absolute right-1 top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-accent-fg">{unread > 99 ? "99+" : unread}</span> : null}
          </Link>
          <UserMenu name={session.user.name} email={session.user.email} isPlatformAdmin={session.user.isPlatformAdmin} />
          </div>
        </header>
        {!session.user.mfaEnabled && principal.role.category === "staff" && principal.permissions.has("member.manage") ? (
          <div className="border-b border-border bg-warning-soft px-4 py-2 text-[13px] text-warning">
            Admins should turn on two-factor authentication. <a className="font-medium underline" href="/account/security">Set it up</a>
          </div>
        ) : null}
        <main id="main" className={`mx-auto max-w-6xl px-4 py-6 sm:px-6${resident ? " pb-24 lg:pb-6" : ""}`}>{children}</main>
      </div>
      {resident ? <ResidentTabs tabs={[
        { label: "Home", href: `${base}/dashboard`, icon: "home" },
        ...(principal.permissions.has("workorder.create") ? [{ label: "Requests", href: `${base}/maintenance`, icon: "wrench" }] : []),
        ...(principal.permissions.has("amenity.read") ? [{ label: "Book", href: `${base}/amenities`, icon: "calendar" }] : []),
        ...(canUsePackages(principal) ? [{ label: "Packages", href: `${base}/packages`, icon: "box", badge: packages }] : []),
        ...(principal.permissions.has("message.use") ? [{ label: "Messages", href: `${base}/messages`, icon: "message", badge: messages }] : []),
      ]} /> : null}
    </div>
  );
}
