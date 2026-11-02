import { getOrgContext, sp } from "@/server/org-context";
import { getPreferences, listNotifications } from "@/server/modules/notifications/service";
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { LinkTabs } from "@/components/ui/tabs";
import { NotificationList } from "@/components/ops/notification-list";
import { PreferencesForm } from "@/components/ops/preferences-form";
import { fmtDateTime, relative } from "@/lib/time";
import { markAllReadAction, openNotificationAction, savePreferencesAction, subscribePushAction, unsubscribePushAction } from "../ops-actions";
import { PushSettings } from "@/components/ops/push-settings";
import { myPushDevices, pushAvailable, vapidPublicKey } from "@/server/push/service";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/notifications">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const tab = sp(q.tab) === "settings" ? "settings" : sp(q.tab) === "unread" ? "unread" : "all";
  const base = `/o/${orgSlug}/notifications`;
  const items = tab === "settings" ? [] : await listNotifications(ctx, { unreadOnly: tab === "unread", limit: 100 });
  const prefs = tab === "settings" ? await getPreferences(ctx) : [];
  const devices = tab === "settings" ? await myPushDevices(ctx) : [];
  const pushKey = tab === "settings" && (await pushAvailable(principal.orgId)) ? vapidPublicKey() : null;
  return (
    <>
      <PageHeader title="Notifications" />
      <Panel>
        <LinkTabs active={tab} tabs={[{ key: "all", label: "All", href: base }, { key: "unread", label: "Unread", href: `${base}?tab=unread` }, { key: "settings", label: "Settings", href: `${base}?tab=settings` }]} />
        {tab === "settings" ? (
          <>
            <PanelHeader title="Push notifications" description="Alerts on your phone or computer, even when the app is closed." />
            <PushSettings publicKey={pushKey} subscribe={subscribePushAction.bind(null, orgSlug)} unsubscribe={unsubscribePushAction.bind(null, orgSlug)}
              devices={devices.map((d) => ({ endpoint: d.endpoint, userAgent: d.userAgent, createdAt: d.createdAt.toISOString(), lastSuccessAt: d.lastSuccessAt?.toISOString() ?? null }))} />
            <div className="border-t border-border" />
            <PanelHeader title="What should we send you?" description={devices.length ? "Choose, for each kind of notification, where it goes." : "In-app notifications always appear here. Choose which ones also send an email."} />
            <PreferencesForm action={savePreferencesAction.bind(null, orgSlug)} prefs={prefs} push={devices.length > 0} />
          </>
        ) : items.length === 0 ? <EmptyState title={tab === "unread" ? "You're all caught up" : "No notifications yet"} /> : (
          <NotificationList markAll={markAllReadAction.bind(null, orgSlug)} items={items.map((n) => ({
            id: n.id, title: n.title, body: n.body, readAt: !!n.readAt, createdAt: n.createdAt.toISOString(),
            when: relative(n.createdAt), whenTitle: fmtDateTime(n.createdAt, principal.orgTimezone),
            open: openNotificationAction.bind(null, orgSlug, n.id, n.href),
          }))} />
        )}
      </Panel>
    </>
  );
}
