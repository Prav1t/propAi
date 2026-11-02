import Link from "next/link";
import { listSavedViews } from "@/server/modules/views/service";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { listResidents } from "@/server/modules/people/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, PageHeader, Panel, Table, Td, Th, ListEmpty, hasFilters } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { opts, RELATIONSHIP_LABEL } from "@/lib/labels";

export const metadata = { title: "Residents" };

export default async function ResidentsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/residents">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const savedViews = await listSavedViews(ctx, "residents");
  const status = (["current", "past", "all"] as const).find((s) => s === sp(q.status)) ?? "current";
  const data = await orNotFound(listResidents(ctx, { q: sp(q.q), propertyId: sp(q.property), relationship: sp(q.relationship), status, page: Number(sp(q.page)) || 1 }));
  const props = await listPropertyOptions(ctx);
  const base = `/o/${orgSlug}`;
  const canAdd = principal.permissions.has("resident.manage");
  return (
    <>
      <PageHeader title="Residents" description="Owners, tenants and occupants across your properties." actions={canAdd ? <LinkButton href={`${base}/residents/new`}>Add resident</LinkButton> : null} />
      <Panel>
        <FilterBar saved={{ orgSlug, page: "residents", views: savedViews }} searchPlaceholder="Name, email or phone…" filters={[
          { name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) },
          { name: "relationship", label: "Relationship", options: opts(RELATIONSHIP_LABEL) },
          { name: "status", label: "Status", allLabel: "current", options: [{ value: "past", label: "Moved out" }, { value: "all", label: "Current + past" }] },
        ]} />
        {data.rows.length === 0 ? <ListEmpty title="No residents yet" filtered={hasFilters(q)} clearHref={`${base}/residents`} create={canAdd ? { href: `${base}/residents/new`, label: "Add resident" } : null} /> : (
          <Table cards>
            <thead><tr><Th>Name</Th><Th>Unit</Th><Th className="hidden md:table-cell">Contact</Th><Th className="hidden sm:table-cell">Relationship</Th><Th className="hidden lg:table-cell">App</Th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} className="hover:bg-subtle/60">
                  <Td><Link className="font-medium hover:underline" href={`${base}/residents/${r.id}`}>{r.lastName}, {r.firstName}</Link></Td>
                  <Td label="Unit" className="text-muted">{r.units ?? <span className="text-faint">Moved out</span>}</Td>
                  <Td label="Contact" className="hidden md:table-cell"><div className="text-[13px]">{r.email ?? "—"}</div><div className="text-xs text-faint">{r.phone ?? ""}</div></Td>
                  <Td label="Relationship" className="hidden sm:table-cell">{r.relationship ? RELATIONSHIP_LABEL[r.relationship] : "—"}</Td>
                  <Td label="App" className="hidden lg:table-cell">{r.hasLogin ? <Badge tone="success">Active</Badge> : <span className="text-xs text-faint">Not invited</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={`${base}/residents`} params={q} />
      </Panel>
    </>
  );
}
