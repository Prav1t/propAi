import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { listInspections } from "@/server/modules/inspections/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { INSPECTION_KIND, INSPECTION_STATUS } from "@/lib/ops-labels";

export const metadata = { title: "Inspections" };
const VIEWS = [{ key: "upcoming", label: "Upcoming" }, { key: "overdue", label: "Overdue" }, { key: "completed", label: "Completed" }, { key: "all", label: "All" }] as const;

export default async function InspectionsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/inspections">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("inspection.read") && !principal.permissions.has("inspection.manage")) notFound();
  const view = VIEWS.find((v) => v.key === sp(q.view))?.key ?? "upcoming";
  const data = await orNotFound(listInspections(ctx, { view, propertyId: sp(q.property), page: Number(sp(q.page)) || 1 }));
  const props = await listPropertyOptions(ctx);
  const base = `/o/${orgSlug}/inspections`;
  const manage = principal.permissions.has("inspection.manage");
  return (
    <>
      <PageHeader title="Inspections" description="Scheduled checklists for units, buildings, equipment and safety."
        actions={manage ? <div className="flex gap-2"><LinkButton variant="secondary" href={`${base}/templates`}>Templates</LinkButton><LinkButton href={`${base}/new`}>Schedule inspection</LinkButton></div> : null} />
      <Panel>
        <LinkTabs active={view} tabs={VIEWS.map((v) => ({ key: v.key, label: v.label, href: `${base}?view=${v.key}`, count: v.key === view ? data.total : null }))} />
        {props.length > 1 ? <FilterBar search={false} filters={[{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }]} /> : null}
        {data.rows.length === 0 ? <EmptyState title={view === "overdue" ? "Nothing overdue" : "No inspections here"} /> : (
          <Table>
            <thead><tr><Th>Inspection</Th><Th className="hidden sm:table-cell">Date</Th><Th>Status</Th><Th className="hidden md:table-cell">Inspector</Th><Th className="hidden md:table-cell text-right">Failed items</Th></tr></thead>
            <tbody>
              {data.rows.map((i) => (
                <tr key={i.id} className="hover:bg-subtle/60">
                  <Td><Link className="font-medium hover:underline" href={`${base}/${i.id}`}>{i.title}</Link>
                    <div className="text-xs text-faint">{[INSPECTION_KIND[i.kind] ?? i.kind, i.propertyName, i.buildingName, i.unitNumber ? `Unit ${i.unitNumber}` : null].filter(Boolean).join(" · ")}</div></Td>
                  <Td className="hidden tabular-nums text-[13px] text-muted sm:table-cell">{i.scheduledFor}</Td>
                  <Td>{i.status === "completed" && i.result ? <Badge tone={i.result === "pass" ? "success" : "danger"}>{i.result === "pass" ? "Passed" : "Failed"}</Badge> : <Badge tone={INSPECTION_STATUS[i.status]?.tone}>{INSPECTION_STATUS[i.status]?.label}</Badge>}</Td>
                  <Td className="hidden text-[13px] text-muted md:table-cell">{i.inspectorName ?? "—"}</Td>
                  <Td className="hidden text-right tabular-nums md:table-cell">{i.failed ? <span className="text-danger">{i.failed}</span> : <span className="text-faint">0</span>}<span className="text-faint"> / {i.total}</span></Td>
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
