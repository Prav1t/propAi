import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { canManageParking, parkingFormOptions } from "@/server/modules/parking/service";
import { PARKING_VIOLATION_KINDS } from "@/server/db/schema";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { VIOLATION_KIND } from "@/lib/facility-labels";
import { utcToZonedInput } from "@/lib/time";
import { reportViolationAction } from "../../../frontdesk-actions";

export const metadata = { title: "Report a parking violation" };

export default async function NewViolationPage({ params, searchParams }: PageProps<"/o/[orgSlug]/parking/violations/new">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canManageParking(principal)) notFound();
  const o = await parkingFormOptions(ctx);
  const tz = principal.orgTimezone ?? "America/Vancouver";
  return (
    <>
      <Breadcrumbs items={[{ label: "Parking", href: `/o/${orgSlug}/parking` }, { label: "Report" }]} />
      <PageHeader title="Report a parking violation" description="Record what you saw. Nothing is sent to anyone until the report is reviewed and a notice is issued." />
      <Panel className="max-w-3xl">
        <SchemaForm action={reportViolationAction.bind(null, orgSlug)} submitLabel="Save report" pendingLabel="Saving…" columns={2} className="p-4" fields={[
          { name: "propertyId", label: "Property", type: "select", options: o.properties.map((p) => ({ value: p.id, label: p.name })), defaultValue: o.properties[0]?.id, span: 2 },
          { name: "plate", label: "Licence plate", required: true, defaultValue: sp(q.plate) ?? "" },
          { name: "kind", label: "What's wrong", type: "select", options: PARKING_VIOLATION_KINDS.map((k) => ({ value: k, label: VIOLATION_KIND[k] })) },
          { name: "spaceCode", label: "Space (optional)", placeholder: "P1-024" },
          { name: "location", label: "Location (optional)", placeholder: "e.g. loading bay by Tower B" },
          { name: "observedAt", label: "Seen at", type: "datetime-local", defaultValue: utcToZonedInput(new Date(), tz) },
          { name: "buildingId", label: "Building (optional)", type: "select", options: [{ value: "", label: "—" }, ...o.buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))] },
          { name: "description", label: "Details", type: "textarea", span: 2, placeholder: "Facts only: what you observed and when." },
          { name: "files", label: "Photos (optional)", type: "file", accept: "image/*", multiple: true, span: 2, hint: "Evidence stays with parking staff." },
        ]} />
      </Panel>
    </>
  );
}
