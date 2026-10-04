import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canManageAssets, canReadAssets, facilityStats, listAssets } from "@/server/modules/assets/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { ASSET_CATEGORY, ASSET_STATUS, CRITICALITY, hours } from "@/lib/facility-labels";
import { opts } from "@/lib/labels";
import { relative } from "@/lib/time";

export const metadata = { title: "Assets" };

export default async function AssetsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/assets">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canReadAssets(principal)) notFound();
  const base = `/o/${orgSlug}/assets`;
  const [data, stats, props] = await Promise.all([
    orNotFound(listAssets(ctx, { q: sp(q.q), propertyId: sp(q.property), category: sp(q.category), status: sp(q.status) ?? "active", page: Number(sp(q.page)) || 1 })),
    facilityStats(ctx), listPropertyOptions(ctx),
  ]);
  return (
    <>
      <PageHeader title="Assets" description="Equipment, preventive maintenance and downtime."
        actions={canManageAssets(principal) ? <LinkButton href={`${base}/new`}>Add asset</LinkButton> : null} />
      {stats ? (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Out of service" value={<span className={stats.down ? "text-danger" : undefined}>{stats.down}</span>} sub={stats.criticalDown ? `${stats.criticalDown} high/critical` : `${stats.total} assets in service`} />
            <Stat label="Needs attention" value={<span className={stats.attention ? "text-warning" : undefined}>{stats.attention}</span>} />
            <Stat label="PM due in 14 days" value={stats.pmDueSoon} sub={`${stats.pmOpen} PM work orders open${stats.pmOverdue ? `, ${stats.pmOverdue} overdue` : ""}`} />
            <Stat label="Downtime (30 days)" value={hours(stats.downtimeHours30d)} />
          </div>
          {stats.repeat.length || stats.outOfService.length ? (
            <div className="mb-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
              <Panel>
                <PanelHeader title="Repeat failures (90 days)" description="Assets with 3+ reactive work orders. Recorded data only." />
                {stats.repeat.length === 0 ? <EmptyState title="No repeat failures" /> : (
                  <ul className="divide-y divide-border text-[13px]">{stats.repeat.map((r) => (
                    <li key={r.id} className="flex justify-between gap-3 px-4 py-2.5"><Link href={`${base}/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                      <span className="text-muted">{r.count} requests · ${r.cost.toLocaleString("en-CA", { maximumFractionDigits: 0 })} · {r.propertyName}</span></li>
                  ))}</ul>
                )}
              </Panel>
              <Panel>
                <PanelHeader title="Out of service now" />
                {stats.outOfService.length === 0 ? <EmptyState title="Everything is running" /> : (
                  <ul className="divide-y divide-border text-[13px]">{stats.outOfService.map((d) => (
                    <li key={d.id} className="flex justify-between gap-3 px-4 py-2.5"><span><Link href={`${base}/${d.id}`} className="font-medium hover:underline">{d.name}</Link> <span className="text-muted">· {d.reason ?? "down"}</span></span>
                      <span className="whitespace-nowrap text-muted">{d.since ? relative(d.since).replace(" ago", "") : ""} · {d.propertyName}</span></li>
                  ))}</ul>
                )}
              </Panel>
            </div>
          ) : null}
        </>
      ) : null}
      <Panel>
        <FilterBar searchPlaceholder="Name, tag, make, model or serial…" filters={[
          ...(props.length > 1 ? [{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }] : []),
          { name: "category", label: "Category", options: opts(ASSET_CATEGORY) },
          { name: "status", label: "Status", allLabel: "In use", options: [...Object.entries(ASSET_STATUS).map(([value, v]) => ({ value, label: v.label }))] },
        ]} />
        {data.rows.length === 0 ? <EmptyState title="No assets match" /> : (
          <Table>
            <thead><tr><Th>Asset</Th><Th className="hidden md:table-cell">Where</Th><Th>Status</Th><Th className="hidden md:table-cell">Next PM</Th><Th className="text-right">Open WOs</Th></tr></thead>
            <tbody>{data.rows.map((a) => (
              <tr key={a.id} className="hover:bg-subtle/60">
                <Td><Link href={`${base}/${a.id}`} className="font-medium hover:underline">{a.name}</Link>
                  <div className="text-xs text-faint">{[ASSET_CATEGORY[a.category], a.tag, a.criticality !== "medium" ? `${CRITICALITY[a.criticality]?.label} criticality` : null].filter(Boolean).join(" · ")}</div></Td>
                <Td className="hidden text-[13px] md:table-cell">{a.propertyName}{a.buildingName ? ` · ${a.buildingName}` : ""}<div className="text-xs text-faint">{a.location}</div></Td>
                <Td><Badge tone={ASSET_STATUS[a.status]?.tone}>{ASSET_STATUS[a.status]?.label}</Badge>{a.reactive90d >= 3 ? <div className="mt-1 text-xs text-warning">{a.reactive90d} requests in 90 days</div> : null}</Td>
                <Td className="hidden text-[13px] md:table-cell">{a.nextPmOn ?? "—"}</Td>
                <Td className="text-right tabular-nums">{a.openWorkOrders || <span className="text-faint">0</span>}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={base} params={q} />
      </Panel>
    </>
  );
}
