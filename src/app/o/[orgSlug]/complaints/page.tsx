import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canUseComplaints, listComplaints } from "@/server/modules/complaints/service";
import { COMPLAINT_CATEGORIES } from "@/server/db/schema";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { COMPLAINT_CATEGORY, COMPLAINT_STATUS, PRIORITY } from "@/lib/ops-labels";
import { fmtDateTime } from "@/lib/time";

export const metadata = { title: "Complaints" };
const VIEWS = [{ key: "open", label: "Open" }, { key: "resolved", label: "Resolved" }, { key: "all", label: "All" }] as const;

export default async function ComplaintsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/complaints">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseComplaints(principal)) notFound();
  const view = VIEWS.find((v) => v.key === sp(q.view))?.key ?? "open";
  const data = await orNotFound(listComplaints(ctx, { view, category: sp(q.category), propertyId: sp(q.property), page: Number(sp(q.page)) || 1 }));
  const staff = principal.permissions.has("complaint.read");
  const props = staff ? await listPropertyOptions(ctx) : [];
  const base = `/o/${orgSlug}/complaints`;
  return (
    <>
      <PageHeader title={staff ? "Complaints" : "My complaints"} description={staff ? "Resident concerns, routed and tracked to resolution." : "Raise a concern with building management and follow up here."}
        actions={principal.permissions.has("complaint.create") || principal.permissions.has("complaint.manage") ? <LinkButton href={`${base}/new`}>New complaint</LinkButton> : null} />
      <Panel>
        <LinkTabs active={view} tabs={VIEWS.map((v) => ({ key: v.key, label: v.label, href: `${base}?view=${v.key}`, count: v.key === view ? data.total : null }))} />
        {staff ? <FilterBar search={false} filters={[
          ...(props.length > 1 ? [{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }] : []),
          { name: "category", label: "Category", options: COMPLAINT_CATEGORIES.map((c) => ({ value: c, label: COMPLAINT_CATEGORY[c] ?? c })) },
        ]} /> : null}
        {data.rows.length === 0 ? <EmptyState title="No complaints here" /> : (
          <Table>
            <thead><tr><Th className="w-16">#</Th><Th>Complaint</Th><Th>Status</Th><Th className="hidden md:table-cell">Handled by</Th><Th className="hidden sm:table-cell">Received</Th></tr></thead>
            <tbody>
              {data.rows.map((c) => (
                <tr key={c.id} className="hover:bg-subtle/60">
                  <Td className="tabular-nums text-muted">{c.number}</Td>
                  <Td><Link className="font-medium hover:underline" href={`${base}/${c.id}`}>{c.subject}</Link>
                    {staff && (c.priority === "high" || c.priority === "urgent") ? <Badge tone={PRIORITY[c.priority].tone} className="ml-2">{PRIORITY[c.priority].label}</Badge> : null}
                    <div className="text-xs text-faint">{[COMPLAINT_CATEGORY[c.category] ?? c.category, c.propertyName, c.unitNumber ? `Unit ${c.unitNumber}` : null].filter(Boolean).join(" · ")}</div></Td>
                  <Td><Badge tone={COMPLAINT_STATUS[c.status]?.tone}>{COMPLAINT_STATUS[c.status]?.label}</Badge></Td>
                  <Td className="hidden text-[13px] text-muted md:table-cell">{c.assigneeName ?? <span className="text-faint">—</span>}</Td>
                  <Td className="hidden text-[13px] text-muted sm:table-cell">{fmtDateTime(c.createdAt, principal.orgTimezone)}</Td>
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
