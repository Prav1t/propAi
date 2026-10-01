import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { inspectionFormOptions, listTemplates } from "@/server/modules/inspections/service";
import { listBuildingOptions } from "@/server/modules/portfolio/service";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { INSPECTION_KIND } from "@/lib/ops-labels";
import { scheduleInspectionAction } from "../../ops-actions";

export const metadata = { title: "Schedule inspection" };

export default async function NewInspectionPage({ params }: PageProps<"/o/[orgSlug]/inspections/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("inspection.manage")) notFound();
  const [templates, buildings] = await Promise.all([listTemplates(ctx), listBuildingOptions(ctx)]);
  // org-wide roles see every staff member; the server re-validates the inspector against the building's property
  const inspectors = await inspectionFormOptions(ctx, buildings.length && new Set(buildings.map((b) => b.propertyId)).size === 1 ? buildings[0].propertyId : null);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <Breadcrumbs items={[{ label: "Inspections", href: `/o/${orgSlug}/inspections` }, { label: "Schedule" }]} />
      <PageHeader title="Schedule inspection" />
      <Panel className="max-w-2xl p-4 sm:p-6">
        {templates.length === 0 ? (
          <EmptyState title="No templates yet" action={<LinkButton href={`/o/${orgSlug}/inspections/templates`}>Create a template</LinkButton>}>Inspections are created from a checklist template.</EmptyState>
        ) : (
          <SchemaForm action={scheduleInspectionAction.bind(null, orgSlug)} columns={2} submitLabel="Schedule" fields={[
            { name: "templateId", label: "Template", type: "select", span: 2, options: [{ value: "", label: "Choose…" }, ...templates.map((t) => ({ value: t.id, label: `${t.name} (${INSPECTION_KIND[t.kind] ?? t.kind}, ${t.items.length} items)` }))] },
            { name: "buildingId", label: "Building", type: "select", options: [{ value: "", label: "Choose…" }, ...buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))] },
            { name: "unitNumber", label: "Unit (optional)", placeholder: "For unit or move-in/out inspections" },
            { name: "scheduledFor", label: "Date", type: "date", defaultValue: today },
            { name: "inspectorMembershipId", label: "Inspector", type: "select", options: [{ value: "", label: "Unassigned" }, ...inspectors.map((i) => ({ value: i.membershipId, label: `${i.name} · ${i.role}` }))] },
            { name: "title", label: "Title (optional)", span: 2, placeholder: "Defaults to the template name" },
          ]} />
        )}
      </Panel>
    </>
  );
}
