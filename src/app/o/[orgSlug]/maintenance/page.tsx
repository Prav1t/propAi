import Link from "next/link";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { listWorkOrders, type WoView } from "@/server/modules/maintenance/service";
import { PRIORITY_ORDER, WO_CATEGORIES, WO_STATUSES } from "@/server/modules/maintenance/rules";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { PRIORITY, WO_CATEGORY, WO_STATUS } from "@/lib/ops-labels";
import { fmtDateTime, relative } from "@/lib/time";

export const metadata = { title: "Maintenance" };

const STAFF_VIEWS: { key: WoView; label: string }[] = [
  { key: "open", label: "Open" }, { key: "overdue", label: "Overdue" }, { key: "emergency", label: "Emergency" }, { key: "unassigned", label: "Unassigned" },
  { key: "mine", label: "Assigned to me" }, { key: "completed", label: "Completed" }, { key: "all", label: "All" },
];
const OTHER_VIEWS: { key: WoView; label: string }[] = [{ key: "open", label: "Open" }, { key: "completed", label: "Completed" }, { key: "all", label: "All" }];

export default async function MaintenancePage({ params, searchParams }: PageProps<"/o/[orgSlug]/maintenance">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const staff = principal.permissions.has("workorder.read");
  const views = staff ? STAFF_VIEWS : OTHER_VIEWS;
  const view = (views.find((v) => v.key === sp(q.view))?.key ?? "open") as WoView;
  const data = await orNotFound(listWorkOrders(ctx, {
    view, status: sp(q.status), propertyId: sp(q.property), category: sp(q.category), priority: sp(q.priority), q: sp(q.q), page: Number(sp(q.page)) || 1,
  }));
  const props = staff ? await listPropertyOptions(ctx) : [];
  const base = `/o/${orgSlug}/maintenance`;
  const tz = principal.orgTimezone;
  const keep = (k: string) => { const s = new URLSearchParams(); for (const [a, b] of Object.entries(q)) if (typeof b === "string" && a !== "page" && a !== "view") s.set(a, b); s.set("view", k); return `${base}?${s}`; };
  const isResident = principal.role.category === "resident";
  return (
    <>
      <PageHeader
        title={isResident ? "My requests" : "Maintenance"}
        description={isResident ? "Report a problem in your home and follow its progress." : principal.vendorId ? "Jobs assigned to your company." : "Work orders across the properties you manage."}
        actions={principal.permissions.has("workorder.create") ? <LinkButton href={`${base}/new`}>{isResident ? "New request" : "Create work order"}</LinkButton> : null}
      />
      <Panel>
        <LinkTabs active={view} tabs={views.map((v) => ({ key: v.key, label: v.label, href: keep(v.key), count: v.key === view ? data.total : null }))} />
        <FilterBar searchPlaceholder="Title or #number…" filters={[
          ...(staff ? [{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }] : []),
          { name: "category", label: "Category", options: WO_CATEGORIES.map((c) => ({ value: c, label: WO_CATEGORY[c] })) },
          ...(staff ? [{ name: "priority", label: "Priority", options: PRIORITY_ORDER.map((c) => ({ value: c, label: PRIORITY[c].label })) }] : []),
          { name: "status", label: "Status", options: WO_STATUSES.map((s) => ({ value: s, label: WO_STATUS[s].label })) },
        ]} />
        {data.rows.length === 0 ? (
          <EmptyState title={view === "overdue" ? "Nothing overdue" : view === "emergency" ? "No open emergencies" : "No requests here"}>
            {isResident && view === "open" ? "When something needs fixing, submit a request and we'll keep you posted here." : null}
          </EmptyState>
        ) : (
          <Table>
            <thead><tr><Th className="w-16">#</Th><Th>Request</Th><Th>Status</Th><Th className="hidden md:table-cell">Priority</Th><Th className="hidden lg:table-cell">Assigned</Th><Th className="hidden sm:table-cell">{view === "completed" ? "Submitted" : "Due"}</Th></tr></thead>
            <tbody>
              {data.rows.map((w) => (
                <tr key={w.id} className="hover:bg-subtle/60">
                  <Td className="tabular-nums text-muted">{w.number}</Td>
                  <Td>
                    <Link className="font-medium hover:underline" href={`${base}/${w.id}`}>{w.title}</Link>
                    {w.isEmergency ? <Badge tone="danger" className="ml-2">Emergency</Badge> : null}
                    <div className="text-xs text-faint">{[w.propertyName, w.buildingName, w.unitNumber ? `Unit ${w.unitNumber}` : w.area].filter(Boolean).join(" · ")} · {WO_CATEGORY[w.category] ?? w.category}</div>
                  </Td>
                  <Td><Badge tone={WO_STATUS[w.status]?.tone}>{WO_STATUS[w.status]?.label ?? w.status}</Badge></Td>
                  <Td className="hidden md:table-cell"><Badge tone={PRIORITY[w.priority]?.tone}>{PRIORITY[w.priority]?.label}</Badge></Td>
                  <Td className="hidden text-[13px] text-muted lg:table-cell">{[w.assigneeName, w.vendorName].filter(Boolean).join(" · ") || <span className="text-faint">Unassigned</span>}</Td>
                  <Td className="hidden text-[13px] sm:table-cell">
                    {view === "completed" ? <span className="text-muted">{fmtDateTime(w.createdAt, tz)}</span>
                      : w.resolveDueAt ? <span className={w.overdue ? "font-medium text-danger" : "text-muted"} title={fmtDateTime(w.resolveDueAt, tz)}>{w.overdue ? `Overdue ${relative(w.resolveDueAt).replace(" ago", "")}` : relative(w.resolveDueAt)}</span> : "—"}
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
