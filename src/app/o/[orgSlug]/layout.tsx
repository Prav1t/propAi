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

export default async function OrgLayout({ children, params }: LayoutProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const { session, principal, ctx } = await getOrgContext(orgSlug);
  const unread = await unreadCount(ctx);
  const sections = visibleNav(principal.permissions).map((s) => ({
    title: s.title,
    items: s.items.map((i) => ({ label: i.label, icon: i.icon, href: i.href(orgSlug) })),
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
            <CommandPalette commands={commands} search={searchAction.bind(null, orgSlug)} searchPage={`${base}/search`} />
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
        <main id="main" className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
