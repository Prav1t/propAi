import { getOrgContext, orNotFound } from "@/server/org-context";
import { getIncident, INCIDENT_STATUSES, SEVERITIES } from "@/server/modules/incidents/service";
import { Badge, PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs, DetailList } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { Timeline } from "@/components/ops/timeline";
import { INCIDENT_STATUS, INCIDENT_TYPE, SEVERITY } from "@/lib/ops-labels";
import { fmtDateTime } from "@/lib/time";
import { updateIncidentAction } from "../../ops-actions";

export const metadata = { title: "Incident" };

export default async function IncidentPage({ params }: PageProps<"/o/[orgSlug]/incidents/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getIncident(ctx, id));
  const i = d.incident;
  const tz = principal.orgTimezone;
  return (
    <>
      <Breadcrumbs items={[{ label: "Incidents", href: `/o/${orgSlug}/incidents` }, { label: `#${i.number}` }]} />
      <PageHeader title={i.title} description={`#${i.number} · ${INCIDENT_TYPE[i.type] ?? i.type}`}
        actions={<div className="flex gap-1.5"><Badge tone={SEVERITY[i.severity]?.tone}>{SEVERITY[i.severity]?.label}</Badge><Badge tone={INCIDENT_STATUS[i.status]?.tone}>{INCIDENT_STATUS[i.status]?.label}</Badge></div>} />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Panel>
            <PanelHeader title="Report" />
            <p className="whitespace-pre-line break-words px-4 py-3 text-sm">{i.description || <span className="text-faint">No description.</span>}</p>
            <DetailList items={[
              ["Where", [d.labels?.propertyName, d.labels?.buildingName, d.labels?.unitNumber ? `Unit ${d.labels.unitNumber}` : null, i.location].filter(Boolean).join(" · ")],
              ["Occurred", fmtDateTime(i.occurredAt, tz)], ["Reported by", d.reporterName], ["People involved", i.peopleInvolved],
              ["External reference", i.externalReference], ["Resolution", i.resolution], ["Resolved", i.resolvedAt ? fmtDateTime(i.resolvedAt, tz) : null],
            ]} />
          </Panel>
          <Panel>
            <PanelHeader title="Timeline" />
            <Timeline events={d.timeline} statusLabels={INCIDENT_STATUS} tz={tz} showVisibility={d.access.staff} />
          </Panel>
        </div>
        <div className="space-y-6">
          <Panel>
            <PanelHeader title={d.access.manage ? "Update" : "Add information"} />
            <div className="p-4">
              <SchemaForm action={updateIncidentAction.bind(null, orgSlug, id)} submitLabel="Save" resetOnSuccess fields={[
                ...(d.access.manage ? [
                  { name: "status", label: "Status", type: "select" as const, defaultValue: i.status, options: INCIDENT_STATUSES.map((s) => ({ value: s, label: INCIDENT_STATUS[s].label })) },
                  { name: "severity", label: "Severity", type: "select" as const, defaultValue: i.severity, options: SEVERITIES.map((s) => ({ value: s, label: SEVERITY[s].label })), hint: "Raising to high or critical alerts managers." },
                  { name: "resolution", label: "Resolution (required to resolve)", type: "textarea" as const, defaultValue: i.resolution ?? "" },
                ] : []),
                { name: "note", label: "Note", type: "textarea" },
                ...(d.access.staff ? [{ name: "visibility", label: "Visible to", type: "select" as const, defaultValue: "internal", options: [{ value: "internal", label: "Staff only" }, { value: "public", label: "Staff and the reporter" }] }] : []),
              ]} hidden={d.access.staff ? undefined : { visibility: "public" }} />
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
