import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { listPortfolios, listProperties } from "@/server/modules/portfolio/service";
import { can } from "@/server/authz/authorize";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { opts, PROPERTY_TYPE_LABEL } from "@/lib/labels";

export const metadata = { title: "Properties" };

export default async function PropertiesPage({ params, searchParams }: PageProps<"/o/[orgSlug]/properties">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const data = await orNotFound(listProperties(ctx, { q: sp(q.q), type: sp(q.type), portfolioId: sp(q.portfolio), page: Number(sp(q.page)) || 1 }));
  const portfolios = principal.permissions.has("portfolio.read") ? await listPortfolios(ctx) : [];
  const canCreate = principal.role.scopeLevel === "org" ? can(principal, "property.manage") : principal.portfolioIds.size > 0 && principal.permissions.has("property.manage");
  const base = `/o/${orgSlug}`;
  return (
    <>
      <PageHeader title="Properties" description="Every property you manage, with live occupancy." actions={canCreate ? <LinkButton href={`${base}/properties/new`}>New property</LinkButton> : null} />
      <Panel>
        <FilterBar searchPlaceholder="Search name, code, address…" filters={[
          { name: "type", label: "Type", options: opts(PROPERTY_TYPE_LABEL) },
          ...(portfolios.length ? [{ name: "portfolio", label: "Portfolio", options: portfolios.map((p) => ({ value: p.id, label: p.name })) }] : []),
        ]} />
        {data.rows.length === 0 ? (
          <EmptyState title={q.q || q.type || q.portfolio ? "No properties match" : "No properties yet"}
            action={canCreate && !q.q ? <LinkButton href={`${base}/properties/new`}>Add your first property</LinkButton> : null}>
            {q.q || q.type ? "Try a different search or clear the filters." : "Add a property to start managing buildings, units and residents."}
          </EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Property</Th><Th className="hidden md:table-cell">Portfolio</Th><Th>Type</Th><Th className="text-right">Buildings</Th><Th className="text-right">Units</Th><Th className="hidden sm:table-cell text-right">Residents</Th><Th className="text-right">Occupancy</Th></tr></thead>
            <tbody>
              {data.rows.map((p) => (
                <tr key={p.id} className="hover:bg-subtle/60">
                  <Td><Link href={`${base}/properties/${p.id}`} className="font-medium hover:underline">{p.name}</Link><div className="text-xs text-faint">{p.code}{p.city ? ` · ${p.city}` : ""}</div></Td>
                  <Td className="hidden text-muted md:table-cell">{p.portfolioName ?? "—"}</Td>
                  <Td><Badge>{PROPERTY_TYPE_LABEL[p.type] ?? p.type}</Badge></Td>
                  <Td className="text-right tabular-nums">{p.buildingCount}</Td>
                  <Td className="text-right tabular-nums">{p.unitCount}</Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">{p.residentCount}</Td>
                  <Td className="text-right tabular-nums">{p.unitCount ? `${Math.round((p.occupiedCount / p.unitCount) * 100)}%` : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={`${base}/properties`} params={q} />
      </Panel>
    </>
  );
}
