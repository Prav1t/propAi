import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { canUseMessages, listThreads, type ThreadView } from "@/server/modules/messaging/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { THREAD_CATEGORY } from "@/lib/community-labels";
import { relative } from "@/lib/time";
import { cn } from "@/lib/cn";

export const metadata = { title: "Messages" };

export default async function MessagesPage({ params, searchParams }: PageProps<"/o/[orgSlug]/messages">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseMessages(principal)) notFound();
  const staff = principal.permissions.has("message.manage");
  const views: { key: ThreadView; label: string }[] = staff
    ? [{ key: "awaiting", label: "Needs reply" }, { key: "open", label: "Open" }, { key: "mine", label: "Assigned to me" }, { key: "unassigned", label: "Unassigned" }, { key: "closed", label: "Closed" }]
    : [{ key: "all", label: "All" }, { key: "open", label: "Open" }, { key: "closed", label: "Closed" }];
  const view = views.find((v) => v.key === sp(q.view))?.key ?? views[0].key;
  const data = await listThreads(ctx, { view, propertyId: sp(q.property), page: Number(sp(q.page)) || 1 });
  const props = staff ? await listPropertyOptions(ctx) : [];
  const base = `/o/${orgSlug}/messages`;
  return (
    <>
      <PageHeader title={staff ? "Resident messages" : "Messages"} description={staff ? "Conversations with residents at your properties." : "Write to building management."}
        actions={<div className="flex gap-2">{staff ? <LinkButton variant="secondary" href={`${base}/templates`}>Templates</LinkButton> : null}<LinkButton href={`${base}/new`}>{staff ? "Message a resident" : "New message"}</LinkButton></div>} />
      <Panel>
        <LinkTabs active={view} tabs={views.map((v) => ({ key: v.key, label: v.label, href: `${base}?view=${v.key}`, count: v.key === view ? data.total : null }))} />
        {staff && props.length > 1 ? <FilterBar search={false} filters={[{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }]} /> : null}
        {data.rows.length === 0 ? <EmptyState title={view === "awaiting" ? "Everything has a reply" : "No conversations here"} /> : (
          <ul className="divide-y divide-border">
            {data.rows.map((t) => (
              <li key={t.id}>
                <Link href={`${base}/${t.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-subtle/60">
                  <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", t.unread ? "bg-accent" : "bg-transparent")} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className={cn("truncate text-sm", t.unread && "font-semibold")}>{t.subject}</span>
                      {t.unread ? <span className="sr-only">(unread)</span> : null}
                      {t.status === "closed" ? <Badge>Closed</Badge> : staff && !t.lastFromStaff ? <Badge tone="warning">Needs reply</Badge> : null}
                      <Badge>{THREAD_CATEGORY[t.category] ?? t.category}</Badge>
                    </span>
                    <span className="block truncate text-[13px] text-muted">{t.lastFromStaff ? (staff ? "You: " : "Management: ") : staff ? "" : "You: "}{t.lastMessagePreview}</span>
                    <span className="block text-xs text-faint">{[staff ? [t.residentName, t.unitNumber ? `Unit ${t.unitNumber}` : null, t.propertyName].filter(Boolean).join(" · ") : t.propertyName, staff && t.assigneeName ? `→ ${t.assigneeName}` : null, relative(t.lastMessageAt)].filter(Boolean).join(" · ")}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={base} params={q} />
      </Panel>
    </>
  );
}
