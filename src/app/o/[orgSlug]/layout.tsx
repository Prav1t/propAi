import { getOrgContext } from "@/server/org-context";
import { visibleNav } from "@/config/navigation";
import { DesktopSidebar, MobileNav } from "@/components/shell/sidebar";
import { UserMenu } from "@/components/shell/user-menu";

export default async function OrgLayout({ children, params }: LayoutProps<"/o/[orgSlug]">) {
  const { orgSlug } = await params;
  const { session, principal } = await getOrgContext(orgSlug);
  const sections = visibleNav(principal.permissions).map((s) => ({
    title: s.title,
    items: s.items.map((i) => ({ label: i.label, icon: i.icon, href: i.href(orgSlug) })),
  }));
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <DesktopSidebar sections={sections} orgName={principal.orgName} roleName={principal.role.name} />
      <div className="lg:pl-60">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:justify-end">
          <div className="flex items-center gap-2">
            <MobileNav sections={sections} orgName={principal.orgName} roleName={principal.role.name} />
            <span className="text-sm font-medium lg:hidden">{principal.orgName}</span>
          </div>
          <UserMenu name={session.user.name} email={session.user.email} isPlatformAdmin={session.user.isPlatformAdmin} />
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
