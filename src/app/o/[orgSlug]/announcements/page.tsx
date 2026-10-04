import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { announcementFeed, listManagedAnnouncements, type AnnouncementView } from "@/server/modules/announcements/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { ANNOUNCEMENT_CATEGORY, AUDIENCE } from "@/lib/community-labels";
import { fmtDateTime, relative } from "@/lib/time";
import { cn } from "@/lib/cn";

export const metadata = { title: "Announcements" };

export default async function AnnouncementsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/announcements">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const manage = principal.permissions.has("announcement.manage");
  if (!manage && !principal.permissions.has("announcement.read")) notFound();
  const base = `/o/${orgSlug}/announcements`;
  const tz = principal.orgTimezone;
  const tab = sp(q.view) ?? (manage ? "published" : "feed");

  if (!manage || tab === "feed") {
    const feed = await announcementFeed(ctx, { limit: 100 });
    return (
      <>
        <PageHeader title="Announcements" description="News and notices from building management." actions={manage ? <LinkButton href={`${base}?view=published`} variant="secondary">Manage</LinkButton> : null} />
        {feed.length === 0 ? <Panel><EmptyState title="No announcements right now" /></Panel> : (
          <ul className="space-y-3">
            {feed.map((a) => (
              <li key={a.id}>
                <Link href={`${base}/${a.id}`} className={cn("block rounded-[var(--radius-lg)] border bg-surface p-4 hover:border-border-strong focus-visible:outline-2", a.category === "emergency" ? "border-danger/40" : "border-border")}>
                  <div className="flex flex-wrap items-center gap-2">
                    {!a.read ? <span className="size-2 rounded-full bg-accent" aria-label="Unread" /> : null}
                    <h2 className={cn("text-[15px]", !a.read && "font-semibold")}>{a.title}</h2>
                    {a.pinned ? <Badge tone="accent">Pinned</Badge> : null}
                    {a.category !== "general" ? <Badge tone={ANNOUNCEMENT_CATEGORY[a.category]?.tone}>{ANNOUNCEMENT_CATEGORY[a.category]?.label}</Badge> : null}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[13px] text-muted">{a.body}</p>
                  <p className="mt-2 text-xs text-faint">{[a.propertyName ?? "All properties", a.publishedAt ? relative(a.publishedAt) : null].filter(Boolean).join(" · ")}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  const views: { key: AnnouncementView; label: string }[] = [{ key: "published", label: "Published" }, { key: "scheduled", label: "Scheduled" }, { key: "drafts", label: "Drafts" }, { key: "archived", label: "Archived" }];
  const view = views.find((v) => v.key === tab)?.key ?? "published";
  const data = await listManagedAnnouncements(ctx, { view, page: Number(sp(q.page)) || 1 });
  return (
    <>
      <PageHeader title="Announcements" description="Post notices to residents and staff, now or on a schedule."
        actions={<div className="flex gap-2"><LinkButton variant="secondary" href={`${base}?view=feed`}>View as reader</LinkButton><LinkButton href={`${base}/new`}>New announcement</LinkButton></div>} />
      <Panel>
        <LinkTabs active={view} tabs={views.map((v) => ({ key: v.key, label: v.label, href: `${base}?view=${v.key}`, count: v.key === view ? data.total : null }))} />
        {data.rows.length === 0 ? <EmptyState title="Nothing here" /> : (
          <Table>
            <thead><tr><Th>Announcement</Th><Th className="hidden md:table-cell">Audience</Th><Th>{view === "scheduled" ? "Publishes" : "Published"}</Th><Th className="hidden sm:table-cell text-right">Read by</Th></tr></thead>
            <tbody>
              {data.rows.map((a) => (
                <tr key={a.id} className="hover:bg-subtle/60">
                  <Td><Link className="font-medium hover:underline" href={`${base}/${a.id}`}>{a.title}</Link>
                    {a.pinned ? <Badge tone="accent" className="ml-2">Pinned</Badge> : null}{a.category === "emergency" ? <Badge tone="danger" className="ml-2">Urgent</Badge> : null}
                    <div className="text-xs text-faint">{a.authorName ?? "—"}</div></Td>
                  <Td className="hidden text-[13px] text-muted md:table-cell">{a.propertyName ?? "All properties"}{a.buildingIds.length ? ` · ${a.buildingIds.length} building${a.buildingIds.length === 1 ? "" : "s"}` : ""}<span className="block text-xs text-faint">{AUDIENCE[a.audience]}</span></Td>
                  <Td className="text-[13px] text-muted">{view === "scheduled" ? fmtDateTime(a.publishAt, tz) : a.publishedAt ? fmtDateTime(a.publishedAt, tz) : "—"}</Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">{a.reads}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={base} params={q} />
      </Panel>
    </>
  );
}
