import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { SEVERITIES } from "@/server/modules/incidents/service";
import { INCIDENT_TYPES } from "@/server/db/schema";
import { listBuildingOptions } from "@/server/modules/portfolio/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm, type FieldDef } from "@/components/ui/schema-form";
import { INCIDENT_TYPE, SEVERITY } from "@/lib/ops-labels";
import { utcToZonedInput } from "@/lib/time";
import { createIncidentAction } from "../../ops-actions";

export const metadata = { title: "Report incident" };

export default async function NewIncidentPage({ params }: PageProps<"/o/[orgSlug]/incidents/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("incident.create")) notFound();
  const resident = principal.role.category === "resident";
  // residents' building options are limited to where they live (occupant scope)
  const buildings = await listBuildingOptions(ctx);
  const fields: FieldDef[] = [
    { name: "title", label: "What happened?", span: 2, autoFocus: true },
    { name: "type", label: "Type", type: "select", options: INCIDENT_TYPES.map((t) => ({ value: t, label: INCIDENT_TYPE[t] ?? t })) },
    { name: "severity", label: "Severity", type: "select", defaultValue: "medium", options: SEVERITIES.map((s) => ({ value: s, label: SEVERITY[s].label })) },
    { name: "buildingId", label: "Building", type: "select", options: [{ value: "", label: "Choose…" }, ...buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))] },
    { name: "unitNumber", label: "Unit (optional)" },
    { name: "location", label: "Where exactly", placeholder: "e.g. P1 parkade near the elevator" },
    { name: "occurredAt", label: `When (${principal.orgTimezone})`, type: "datetime-local", defaultValue: utcToZonedInput(new Date(), principal.orgTimezone) },
    { name: "description", label: "Description", type: "textarea", span: 2, hint: "Stick to what was observed. Avoid naming or blaming people unless necessary." },
    ...(!resident ? [
      { name: "peopleInvolved", label: "People involved (staff only)", type: "textarea" as const, span: 2 as const },
      { name: "externalReference", label: "Police / fire / insurance reference" },
    ] : []),
  ];
  return (
    <>
      <Breadcrumbs items={[{ label: "Incidents", href: `/o/${orgSlug}/incidents` }, { label: "Report" }]} />
      <PageHeader title="Report an incident" description="If anyone is in danger, call 911 first." />
      <Panel className="max-w-2xl p-4 sm:p-6">
        <SchemaForm action={createIncidentAction.bind(null, orgSlug)} columns={2} submitLabel="Submit report" fields={fields} />
      </Panel>
    </>
  );
}
