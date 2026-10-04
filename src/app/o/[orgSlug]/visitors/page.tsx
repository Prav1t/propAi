import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canManageVisitors, canUseVisitors, listVisitors, visitorFormOptions, visitorStats, type VisitorView } from "@/server/modules/visitors/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { ActionButton } from "@/components/ops/action-button";
import { VISITOR_KIND, VISITOR_STATUS, fmtPlate } from "@/lib/facility-labels";
import { fmtRange } from "@/lib/time";
import { checkOutVisitorAction } from "../frontdesk-actions";

export const metadata = { title: "Visitors" };

export default async function VisitorsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/visitors">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseVisitors(principal)) notFound();
  const staff = canManageVisitors(principal);
  const base = `/o/${orgSlug}/visitors`;

  if (!staff) {
    const upcoming = await listVisitors(ctx, { view: "all", pageSize: 100 });
    const now = new Date();
    const current = upcoming.rows.filter((v) => v.status === "checked_in" || (v.status === "expected" && v.expectedUntil > now));
    const past = upcoming.rows.filter((v) => !current.includes(v)).slice(0, 20);
    return (
      <>
        <PageHeader title="My guests" description="Invite guests ahead of time and they'll get a pass to show at the front desk." actions={<LinkButton href={`${base}/new`}>Invite a guest</LinkButton>} />
        <Panel className="mb-6">
          <PanelHeader title="Upcoming and on site" />
          {current.length === 0 ? <EmptyState title="No guests expected" action={<LinkButton href={`${base}/new`} variant="secondary">Invite a guest</LinkButton>}>Guests you invite get a QR pass for the front desk.</EmptyState> : (
            <ul className="divide-y divide-border">
              {current.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <Link href={`${base}/${v.id}`} className="font-medium hover:underline">{v.name}</Link>
                    <p className="text-[13px] text-muted">{fmtRange(v.expectedFrom, v.expectedUntil, v.tz)}{v.kind !== "guest" ? ` · ${VISITOR_KIND[v.kind]}` : ""}</p>
                  </div>
                  <Badge tone={VISITOR_STATUS[v.status]?.tone}>{VISITOR_STATUS[v.status]?.label}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Past visits" />
          {past.length === 0 ? <EmptyState title="No past visits" /> : (
            <ul className="divide-y divide-border text-[13px]">
              {past.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <Link className="font-medium hover:underline" href={`${base}/${v.id}`}>{v.name}</Link>
                  <span className="text-muted">{fmtRange(v.expectedFrom, v.expectedUntil, v.tz)} · {v.status === "expected" ? "Didn't arrive" : VISITOR_STATUS[v.status]?.label}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </>
    );
  }

  const views: { key: VisitorView; label: string }[] = [{ key: "today", label: "Expected today" }, { key: "on_site", label: "On site" }, { key: "upcoming", label: "Upcoming" }, { key: "past", label: "Past" }, { key: "all", label: "All" }];
  const view = views.find((v) => v.key === sp(q.view))?.key ?? "today";
  const [data, stats, opts] = await Promise.all([
    orNotFound(listVisitors(ctx, { view, q: sp(q.q), buildingId: sp(q.building), page: Number(sp(q.page)) || 1 })),
    visitorStats(ctx), visitorFormOptions(ctx),
  ]);
  const keep = (k: string) => { const s = new URLSearchParams(); for (const [a, b] of Object.entries(q)) if (typeof b === "string" && a !== "page" && a !== "view") s.set(a, b); s.set("view", k); return `${base}?${s}`; };
  return (
    <>
      <PageHeader title="Visitors" description="Expected guests, people on site and the visitor log."
        actions={<><LinkButton variant="secondary" href={`/o/${orgSlug}/desk`}>Front desk</LinkButton><LinkButton href={`${base}/new`}>Register visitor</LinkButton></>} />
      {stats ? (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Expected today" value={stats.expectedToday} />
          <Stat label="Arriving in 4 h" value={stats.nextHours} />
          <Stat label="On site" value={stats.onSite} />
          <Stat label="Past their window" value={<span className={stats.overstay ? "text-warning" : undefined}>{stats.overstay}</span>} />
        </div>
      ) : null}
      <Panel>
        <LinkTabs active={view} tabs={views.map((v) => ({ key: v.key, label: v.label, href: keep(v.key), count: v.key === view ? data.total : null }))} />
        <FilterBar searchPlaceholder="Name, company, unit or plate…" filters={opts.buildings.length > 1 ? [{ name: "building", label: "Building", options: opts.buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` })) }] : []} />
        {data.rows.length === 0 ? <EmptyState title={view === "today" ? "Nobody else expected today" : "No visitors here"} /> : (
          <Table>
            <thead><tr><Th>Visitor</Th><Th>Visiting</Th><Th className="hidden md:table-cell">When</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {data.rows.map((v) => (
                <tr key={v.id} className="hover:bg-subtle/60">
                  <Td>
                    <Link href={`${base}/${v.id}`} className="font-medium hover:underline">{v.name}</Link>
                    <div className="text-xs text-faint">{[VISITOR_KIND[v.kind], v.company, v.plate ? fmtPlate(v.plate) : null, v.needsParking ? "needs parking" : null].filter(Boolean).join(" · ")}</div>
                  </Td>
                  <Td className="text-[13px]">{v.unitNumber ? `Unit ${v.unitNumber}` : "Common areas"}<div className="text-xs text-faint">{v.buildingName}</div></Td>
                  <Td className="hidden text-[13px] md:table-cell">{fmtRange(v.expectedFrom, v.expectedUntil, v.tz)}</Td>
                  <Td><Badge tone={v.overstay ? "warning" : VISITOR_STATUS[v.status]?.tone}>{v.overstay ? "Past window" : v.status === "expected" && v.expectedUntil < new Date() ? "No-show" : VISITOR_STATUS[v.status]?.label}</Badge></Td>
                  <Td className="text-right">
                    {v.status === "checked_in" ? <ActionButton action={checkOutVisitorAction.bind(null, orgSlug, v.id)} label="Check out" />
                      : v.status === "expected" ? <Link href={`${base}/${v.id}`} className="text-[13px] font-medium text-accent hover:underline">Check in</Link> : null}
                  </Td>
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
