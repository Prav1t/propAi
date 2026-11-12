import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canSeeMeetings, listMeetings, listOpenMotions } from "@/server/modules/meetings/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, ListEmpty, PageHeader, Panel, PanelHeader, Table, Td, Th, hasFilters } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { MEETING_KIND, MEETING_STATUS } from "@/lib/governance";
import { fmtDateTime } from "@/lib/time";

export const metadata = { title: "Meetings" };
const VIEWS = [{ key: "upcoming", label: "Upcoming" }, { key: "past", label: "Past" }, { key: "all", label: "All" }] as const;

export default async function MeetingsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/meetings">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canSeeMeetings(principal)) notFound();
  const view = VIEWS.find((v) => v.key === sp(q.view))?.key ?? "upcoming";
  const [data, open, props] = await Promise.all([orNotFound(listMeetings(ctx, { view, propertyId: sp(q.property), page: Number(sp(q.page)) || 1 })), listOpenMotions(ctx), listPropertyOptions(ctx)]);
  const base = `/o/${orgSlug}/meetings`;
  const tz = principal.orgTimezone ?? "UTC";
  const canCreate = principal.permissions.has("meeting.manage");
  return (
    <>
      <PageHeader title="Meetings" description="Council and general meetings: agendas, motions, votes and minutes." actions={canCreate ? <LinkButton href={`${base}/new`}>Schedule a meeting</LinkButton> : null} />
      {open.length ? (
        <Panel className="mb-6" data-testid="open-motions">
          <PanelHeader title="Motions open for voting" description="Decided when someone running the meeting records the result." />
          <ul className="divide-y divide-border">
            {open.map((m) => (
              <li key={m.id} className="px-4 py-3 text-sm">
                <Link href={`${base}/${m.meetingId}#motion-${m.number}`} className="font-medium hover:underline">Motion {m.number}: {m.text.length > 140 ? `${m.text.slice(0, 140)}…` : m.text}</Link>
                <div className="text-xs text-faint">{m.meetingTitle}, {m.propertyName}</div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <Panel>
        <LinkTabs active={view} tabs={VIEWS.map((v) => ({ key: v.key, label: v.label, href: `${base}?view=${v.key}${sp(q.property) ? `&property=${sp(q.property)}` : ""}`, count: v.key === view ? data.total : null }))} />
        {props.length > 1 ? <FilterBar search={false} filters={[{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }]} /> : null}
        {data.rows.length === 0 ? (
          <ListEmpty title={view === "upcoming" ? "No meetings scheduled" : "No meetings here"} filtered={hasFilters(q)} clearHref={`${base}?view=${view}`} create={canCreate ? { href: `${base}/new`, label: "Schedule a meeting" } : null}>
            Schedule a meeting to build its agenda, put motions to a vote and keep the minutes with it.
          </ListEmpty>
        ) : (
          <Table cards>
            <thead><tr><Th>Meeting</Th><Th>When</Th><Th className="hidden md:table-cell">Motions</Th><Th>Status</Th></tr></thead>
            <tbody>
              {data.rows.map((m) => (
                <tr key={m.id} className="hover:bg-subtle/60">
                  <Td>
                    <Link className="font-medium hover:underline" href={`${base}/${m.id}`}>{m.title}</Link>
                    <div className="text-xs text-faint">{MEETING_KIND[m.kind]}, {m.propertyName}{m.location ? `, ${m.location}` : ""}</div>
                  </Td>
                  <Td label="When" className="text-[13px] text-muted">{fmtDateTime(m.scheduledAt, tz)}</Td>
                  <Td label="Motions" className="hidden text-[13px] text-muted md:table-cell">{m.motions ? `${m.motions}${m.openMotions ? ` (${m.openMotions} open)` : ""}` : "None"}</Td>
                  <Td label="Status"><Badge tone={MEETING_STATUS[m.status]?.tone}>{MEETING_STATUS[m.status]?.label}</Badge>{m.minutesApproved ? <Badge tone="neutral" className="ml-1.5">Minutes approved</Badge> : null}</Td>
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
