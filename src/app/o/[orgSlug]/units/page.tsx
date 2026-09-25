import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { listPropertyOptions, listUnits, listBuildingOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { UNIT_STATUS, UNIT_TYPE_LABEL, opts } from "@/lib/labels";

export const metadata = { title: "Units" };

export default async function UnitsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/units">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const data = await orNotFound(listUnits(ctx, {
    q: sp(q.q), propertyId: sp(q.property), buildingId: sp(q.building), status: sp(q.status), type: sp(q.type), page: Number(sp(q.page)) || 1,
  }));
  const staffView = principal.permissions.has("unit.read");
  const [props, blds] = staffView ? await Promise.all([listPropertyOptions(ctx), listBuildingOptions(ctx)]) : [[], []];
  const base = `/o/${orgSlug}`;
  return (
    <>
      <PageHeader title={staffView ? "Units" : "My home"} description={staffView ? "Search across every unit you manage." : undefined} />
      <Panel>
        {staffView ? (
          <FilterBar searchPlaceholder="Unit number…" filters={[
            { name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) },
            { name: "building", label: "Building", options: blds.filter((b) => !sp(q.property) || b.propertyId === sp(q.property)).map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` })) },
            { name: "status", label: "Status", options: Object.entries(UNIT_STATUS).map(([value, v]) => ({ value, label: v.label })) },
            { name: "type", label: "Type", options: opts(UNIT_TYPE_LABEL) },
          ]} />
        ) : null}
        {data.rows.length === 0 ? <EmptyState title="No units found">{staffView ? "Try clearing filters." : "Your account isn't linked to a unit yet."}</EmptyState> : (
          <Table>
            <thead><tr><Th>Unit</Th><Th>Building</Th><Th className="hidden md:table-cell">Type</Th><Th className="hidden sm:table-cell text-right">Beds</Th><Th>Status</Th><Th className="hidden lg:table-cell">Primary resident</Th></tr></thead>
            <tbody>
              {data.rows.map((u) => (
                <tr key={u.id} className="hover:bg-subtle/60">
                  <Td><Link href={`${base}/units/${u.id}`} className="font-medium tabular-nums hover:underline">{u.number}</Link>{u.floorName ? <div className="text-xs text-faint">{u.floorName}</div> : null}</Td>
                  <Td><div>{u.buildingName}</div><div className="text-xs text-faint">{u.propertyName}</div></Td>
                  <Td className="hidden text-muted md:table-cell">{UNIT_TYPE_LABEL[u.type]}</Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">{u.bedrooms ?? "—"}</Td>
                  <Td><Badge tone={UNIT_STATUS[u.status]?.tone}>{UNIT_STATUS[u.status]?.label ?? u.status}</Badge></Td>
                  <Td className="hidden text-muted lg:table-cell">{u.primaryResident ?? "—"}{u.occupants > 1 ? <span className="text-faint"> +{u.occupants - 1}</span> : null}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={`${base}/units`} params={q} />
      </Panel>
    </>
  );
}
