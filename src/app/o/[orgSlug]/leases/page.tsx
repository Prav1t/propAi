import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canSeeLeases, listLeases } from "@/server/modules/leases/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, ListEmpty, PageHeader, Panel, Stat, Table, Td, Th, hasFilters } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { LEASE_STATUS, money } from "@/lib/leasing";
import { fmtDay } from "@/lib/time";

export const metadata = { title: "Leases" };
const VIEWS = [{ key: "current", label: "In force" }, { key: "overdue", label: "Rent overdue" }, { key: "ending", label: "Ending in 60 days" }, { key: "ended", label: "Ended" }, { key: "all", label: "All" }] as const;

export default async function LeasesPage({ params, searchParams }: PageProps<"/o/[orgSlug]/leases">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canSeeLeases(principal)) notFound();
  const view = VIEWS.find((v) => v.key === sp(q.view))?.key ?? "current";
  const [data, props] = await Promise.all([orNotFound(listLeases(ctx, { view, propertyId: sp(q.property), page: Number(sp(q.page)) || 1 })), listPropertyOptions(ctx)]);
  const base = `/o/${orgSlug}/leases`;
  const canCreate = principal.permissions.has("lease.manage");
  const s = data.summary;
  const keep = sp(q.property) ? `&property=${sp(q.property)}` : "";
  return (
    <>
      <PageHeader title="Leases" description="Who rents which unit, on what terms, and whether the rent has come in. Payments are recorded here, not collected." actions={canCreate ? <LinkButton href={`${base}/new`}>New lease</LinkButton> : null} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="lease-summary">
        <Stat label="Leases in force" value={s.inForce} />
        <Stat label="Monthly rent roll" value={money(s.rentRollCents)} sub="Leases that have started" />
        <Stat label="Rent overdue" value={<Link href={`${base}?view=overdue${keep}`} className="hover:underline">{money(s.overdueCents)}</Link>} sub={s.overdueLeases ? `Across ${s.overdueLeases} lease${s.overdueLeases === 1 ? "" : "s"}` : "Nothing past its due date"} />
        <Stat label="Ending in 60 days" value={<Link href={`${base}?view=ending${keep}`} className="hover:underline">{s.endingSoon}</Link>} sub="Fixed terms ending, or notice given" />
      </div>
      <Panel>
        <LinkTabs active={view} tabs={VIEWS.map((v) => ({ key: v.key, label: v.label, href: `${base}?view=${v.key}${keep}`, count: v.key === view ? data.total : null }))} />
        {props.length > 1 ? <FilterBar search={false} filters={[{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }]} /> : null}
        {data.rows.length === 0 ? (
          <ListEmpty title={view === "overdue" ? "No rent is overdue" : view === "ending" ? "No leases end in the next 60 days" : "No leases here"} filtered={hasFilters(q)} clearHref={`${base}?view=${view}`} create={canCreate && view === "current" ? { href: `${base}/new`, label: "New lease" } : null}>
            {view === "current" ? "Create a lease for a unit to track its term and monthly rent." : null}
          </ListEmpty>
        ) : (
          <Table cards>
            <thead><tr><Th>Unit and tenant</Th><Th>Term</Th><Th>Rent</Th><Th>Status</Th></tr></thead>
            <tbody>
              {data.rows.map((l) => (
                <tr key={l.id} className="hover:bg-subtle/60">
                  <Td>
                    <Link className="font-medium hover:underline" href={`${base}/${l.id}`}>Unit {l.unitNumber}, {l.tenantName}</Link>
                    <div className="text-xs text-faint">{l.buildingName === l.propertyName ? l.propertyName : `${l.propertyName}, ${l.buildingName}`}</div>
                  </Td>
                  <Td label="Term" className="text-[13px] text-muted">
                    {fmtDay(l.startsOn)} to {l.endsOn ? fmtDay(l.endsOn) : "month to month"}
                    {l.moveOutOn && l.status === "notice" ? <div className="text-xs text-warning">Moving out {fmtDay(l.moveOutOn)}</div> : l.endsSoon && l.status === "active" ? <div className="text-xs text-warning">Term ends soon</div> : null}
                  </Td>
                  <Td label="Rent" className="text-[13px] tabular-nums">{money(l.rentCents)}{l.overdueCents ? <div className="text-xs font-medium text-danger">{money(l.overdueCents)} overdue</div> : null}</Td>
                  <Td label="Status"><Badge tone={LEASE_STATUS[l.upcoming ? "upcoming" : l.status]?.tone}>{LEASE_STATUS[l.upcoming ? "upcoming" : l.status]?.label}</Badge></Td>
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
