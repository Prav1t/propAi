import { getOrgContext, sp } from "@/server/org-context";
import { getPreferences, listNotifications } from "@/server/modules/notifications/service";
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { LinkTabs } from "@/components/ui/tabs";
import { ActionButton } from "@/components/ops/action-button";
import { PreferencesForm } from "@/components/ops/preferences-form";
import { cn } from "@/lib/cn";
import { fmtDateTime, relative } from "@/lib/time";
import { markReadAction, openNotificationAction, savePreferencesAction } from "../ops-actions";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/notifications">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const tab = sp(q.tab) === "settings" ? "settings" : sp(q.tab) === "unread" ? "unread" : "all";
  const base = `/o/${orgSlug}/notifications`;
  const items = tab === "settings" ? [] : await listNotifications(ctx, { unreadOnly: tab === "unread", limit: 100 });
  const prefs = tab === "settings" ? await getPreferences(ctx) : [];
  return (
    <>
      <PageHeader title="Notifications" actions={tab !== "settings" && items.some((n) => !n.readAt) ? <ActionButton action={markReadAction.bind(null, orgSlug, "all")} label="Mark all read" /> : null} />
      <Panel>
        <LinkTabs active={tab} tabs={[{ key: "all", label: "All", href: base }, { key: "unread", label: "Unread", href: `${base}?tab=unread` }, { key: "settings", label: "Email settings", href: `${base}?tab=settings` }]} />
        {tab === "settings" ? (
          <>
            <PanelHeader title="What should we email you?" description="In-app notifications always appear here. Choose which ones also send an email." />
            <PreferencesForm action={savePreferencesAction.bind(null, orgSlug)} prefs={prefs} />
          </>
        ) : items.length === 0 ? <EmptyState title={tab === "unread" ? "You're all caught up" : "No notifications yet"} /> : (
          <ul className="divide-y divide-border">
            {items.map((n) => (
              <li key={n.id} className={cn("flex items-start gap-3 px-4 py-3", !n.readAt && "bg-accent-soft/30")}>
                <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-accent")} />
                <form action={openNotificationAction.bind(null, orgSlug, n.id, n.href)} className="min-w-0 flex-1">
                  <button className="block w-full text-left">
                    <span className={cn("block text-sm", !n.readAt && "font-medium")}>{n.title}{!n.readAt ? <span className="sr-only"> (unread)</span> : null}</span>
                    {n.body ? <span className="block truncate text-[13px] text-muted">{n.body}</span> : null}
                    <time className="text-xs text-faint" dateTime={n.createdAt.toISOString()} title={fmtDateTime(n.createdAt, principal.orgTimezone)}>{relative(n.createdAt)}</time>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
