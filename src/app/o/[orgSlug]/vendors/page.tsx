import Link from "next/link";
import { listSavedViews } from "@/server/modules/views/service";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { listVendors, VENDOR_CATEGORIES } from "@/server/modules/vendors/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, PageHeader, Panel, Table, Td, Th, ListEmpty, hasFilters } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { cat, daysUntil, VENDOR_STATUS } from "@/lib/labels";

export const metadata = { title: "Vendors" };

export default async function VendorsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/vendors">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const savedViews = await listSavedViews(ctx, "vendors");
  const data = await orNotFound(listVendors(ctx, { q: sp(q.q), category: sp(q.category), status: sp(q.status), propertyId: sp(q.property), page: Number(sp(q.page)) || 1 }));
  const props = await listPropertyOptions(ctx);
  const base = `/o/${orgSlug}`;
  return (
    <>
      <PageHeader title="Vendors" description="Contractors and service companies, with the properties they're approved for."
        actions={principal.permissions.has("vendor.manage") ? <LinkButton href={`${base}/vendors/new`}>Add vendor</LinkButton> : null} />
      <Panel>
        <FilterBar saved={{ orgSlug, page: "vendors", views: savedViews }} searchPlaceholder="Company, email or trade…" filters={[
          { name: "category", label: "Trade", options: VENDOR_CATEGORIES.map((c) => ({ value: c, label: cat(c) })) },
          { name: "status", label: "Status", options: Object.entries(VENDOR_STATUS).map(([value, s]) => ({ value, label: s.label })) },
          { name: "property", label: "Approved for", options: props.map((p) => ({ value: p.id, label: p.name })) },
        ]} />
        {data.rows.length === 0 ? <ListEmpty title="No vendors yet" filtered={hasFilters(q)} clearHref={`${base}/vendors`} create={principal.permissions.has("vendor.manage") ? { href: `${base}/vendors/new`, label: "Add vendor" } : null}>Add the contractors and service companies you work with, then approve them for properties.</ListEmpty> : (
          <Table cards>
            <thead><tr><Th>Vendor</Th><Th className="hidden md:table-cell">Trades</Th><Th className="hidden sm:table-cell">Contact</Th><Th className="text-right">Properties</Th><Th className="hidden lg:table-cell">Insurance</Th><Th>Status</Th></tr></thead>
            <tbody>
              {data.rows.map((v) => {
                const days = daysUntil(v.insuranceExpiresOn);
                return (
                  <tr key={v.id} className="hover:bg-subtle/60">
                    <Td><Link className="font-medium hover:underline" href={`${base}/vendors/${v.id}`}>{v.name}</Link><div className="text-xs text-faint">{v.phone ?? ""}</div></Td>
                    <Td label="Trades" className="hidden md:table-cell"><div className="flex flex-wrap gap-1">{v.categories.map((c) => <Badge key={c}>{cat(c)}</Badge>)}</div></Td>
                    <Td label="Contact" className="hidden text-muted sm:table-cell">{v.primaryContact ?? "—"}</Td>
                    <Td label="Properties" className="text-right tabular-nums">{v.propertyCount}</Td>
                    <Td label="Insurance" className="hidden lg:table-cell">{days === null ? <span className="text-faint">—</span> : days < 0 ? <Badge tone="danger">Expired</Badge> : days <= 30 ? <Badge tone="warning">{days}d left</Badge> : <span className="text-[13px] text-muted">{v.insuranceExpiresOn}</span>}</Td>
                    <Td label="Status"><Badge tone={VENDOR_STATUS[v.status].tone}>{VENDOR_STATUS[v.status].label}</Badge></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
        <Pagination page={data.page} pageCount={data.pageCount} total={data.total} basePath={`${base}/vendors`} params={q} />
      </Panel>
    </>
  );
}
