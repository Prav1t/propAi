import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext, orNotFound, sp } from "@/server/org-context";
import { canUseIncidents, listIncidents, SEVERITIES } from "@/server/modules/incidents/service";
import { INCIDENT_TYPES } from "@/server/db/schema";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { LinkTabs } from "@/components/ui/tabs";
import { INCIDENT_STATUS, INCIDENT_TYPE, SEVERITY } from "@/lib/ops-labels";
import { fmtDateTime } from "@/lib/time";

export const metadata = { title: "Incidents" };
const VIEWS = [{ key: "open", label: "Open" }, { key: "recent", label: "Last 7 days" }, { key: "all", label: "All" }] as const;

export default async function IncidentsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/incidents">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canUseIncidents(principal)) notFound();
  const view = VIEWS.find((v) => v.key === sp(q.view))?.key ?? "open";
  const data = await orNotFound(listIncidents(ctx, { view, type: sp(q.type), severity: sp(q.severity), propertyId: sp(q.property), page: Number(sp(q.page)) || 1 }));
  const staff = principal.permissions.has("incident.read");
  const props = staff ? await listPropertyOptions(ctx) : [];
  const base = `/o/${orgSlug}/incidents`;
  return (
    <>
      <PageHeader title="Incidents" description={staff ? "Security, safety and damage reports with a full timeline." : "Incidents you've reported."}
        actions={principal.permissions.has("incident.create") ? <LinkButton href={`${base}/new`}>Report incident</LinkButton> : null} />
      <Panel>
        <LinkTabs active={view} tabs={VIEWS.map((v) => ({ key: v.key, label: v.label, href: `${base}?view=${v.key}`, count: v.key === view ? data.total : null }))} />
        {staff ? <FilterBar search={false} filters={[
          ...(props.length > 1 ? [{ name: "property", label: "Property", options: props.map((p) => ({ value: p.id, label: p.name })) }] : []),
          { name: "type", label: "Type", options: INCIDENT_TYPES.map((t) => ({ value: t, label: INCIDENT_TYPE[t] ?? t })) },
          { name: "severity", label: "Severity", options: SEVERITIES.map((s) => ({ value: s, label: SEVERITY[s].label })) },
        ]} /> : null}
        {data.rows.length === 0 ? <EmptyState title="No incidents here" /> : (
          <Table>
            <thead><tr><Th className="w-16">#</Th><Th>Incident</Th><Th>Severity</Th><Th>Status</Th><Th className="hidden md:table-cell">Occurred</Th></tr></thead>
            <tbody>
              {data.rows.map((i) => (
                <tr key={i.id} className="hover:bg-subtle/60">
                  <Td className="tabular-nums text-muted">{i.number}</Td>
                  <Td><Link className="font-medium hover:underline" href={`${base}/${i.id}`}>{i.title}</Link>
                    <div className="text-xs text-faint">{[INCIDENT_TYPE[i.type] ?? i.type, i.propertyName, i.location].filter(Boolean).join(" · ")}</div></Td>
                  <Td><Badge tone={SEVERITY[i.severity]?.tone}>{SEVERITY[i.severity]?.label}</Badge></Td>
                  <Td><Badge tone={INCIDENT_STATUS[i.status]?.tone}>{INCIDENT_STATUS[i.status]?.label}</Badge></Td>
                  <Td className="hidden text-[13px] text-muted md:table-cell">{fmtDateTime(i.occurredAt, principal.orgTimezone)}</Td>
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
