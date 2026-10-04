import { getOrgContext, orNotFound } from "@/server/org-context";
import { announcementFormOptions, getAnnouncement } from "@/server/modules/announcements/service";
import { Badge, PageHeader, Panel, PanelHeader, Stat } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { ANNOUNCEMENT_CATEGORY, ANNOUNCEMENT_STATUS, AUDIENCE } from "@/lib/community-labels";
import { fmtDateTime, utcToZonedInput } from "@/lib/time";
import { archiveAnnouncementAction, updateAnnouncementAction } from "../../community-actions";
import { announcementFields } from "../announcement-fields";

export const metadata = { title: "Announcement" };

export default async function AnnouncementPage({ params }: PageProps<"/o/[orgSlug]/announcements/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getAnnouncement(ctx, id));
  const a = d.announcement;
  const tz = principal.orgTimezone;
  const base = `/o/${orgSlug}/announcements`;
  const opts = d.canManage ? await announcementFormOptions(ctx) : null;
  const locked = a.status === "published" || a.status === "archived";
  return (
    <>
      <Breadcrumbs items={[{ label: "Announcements", href: d.canManage ? `${base}?view=published` : base }, { label: a.title }]} />
      <PageHeader title={a.title} description={[d.labels.propertyName ?? "All properties", d.labels.buildings.join(", ") || null, a.publishedAt ? fmtDateTime(a.publishedAt, tz) : null].filter(Boolean).join(" · ")}
        actions={<div className="flex gap-1.5">
          {a.category !== "general" ? <Badge tone={ANNOUNCEMENT_CATEGORY[a.category]?.tone}>{ANNOUNCEMENT_CATEGORY[a.category]?.label}</Badge> : null}
          {d.canManage ? <Badge tone={ANNOUNCEMENT_STATUS[a.status]?.tone}>{ANNOUNCEMENT_STATUS[a.status]?.label}</Badge> : null}
        </div>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <article className="whitespace-pre-line break-words px-4 py-4 text-[15px] leading-relaxed sm:px-6">{a.body}</article>
            {d.labels.authorName ? <p className="border-t border-border px-4 py-2 text-xs text-faint sm:px-6">Posted by {d.labels.authorName}</p> : null}
          </Panel>
          {d.canManage && opts ? (
            <Panel>
              <details>
                <summary className="cursor-pointer px-4 py-3 text-[13px] font-medium">Edit{locked ? " (audience is fixed once published; readers aren't notified again)" : ""}</summary>
                <div className="border-t border-border p-4">
                  <SchemaForm action={updateAnnouncementAction.bind(null, orgSlug, id)} columns={2} submitLabel="Save" fields={announcementFields(opts, {
                    ...a, publishAt: a.publishAt ? utcToZonedInput(a.publishAt, tz) : "", expiresOn: a.expiresAt ? utcToZonedInput(a.expiresAt, tz).slice(0, 10) : "",
                  }, locked)} />
                </div>
              </details>
            </Panel>
          ) : null}
        </div>
        {d.stats || d.canManage ? (
          <div className="space-y-6">
            {d.stats ? <div className="grid grid-cols-2 gap-3"><Stat label="Read by" value={d.stats.reads} /><Stat label="Audience with accounts" value={d.stats.audience} /></div> : null}
            <Panel>
              <PanelHeader title="Delivery" />
              <DetailList items={[
                ["Audience", AUDIENCE[a.audience]], ["Notifications", a.notify ? "Sent on publish" : "Off"],
                ["Scheduled for", a.status === "scheduled" ? fmtDateTime(a.publishAt, tz) : null], ["Hidden after", a.expiresAt ? fmtDateTime(a.expiresAt, tz) : null],
              ]} />
              {d.canManage && a.status !== "archived" ? (
                <div className="border-t border-border p-4">
                  <ConfirmAction action={archiveAnnouncementAction.bind(null, orgSlug, id)} label={a.status === "draft" ? "Delete draft…" : "Archive…"} confirmLabel={a.status === "draft" ? "Delete" : "Archive"}
                    description={a.status === "draft" ? "The draft will be deleted." : "Readers will no longer see it."} />
                </div>
              ) : null}
            </Panel>
          </div>
        ) : null}
      </div>
    </>
  );
}
