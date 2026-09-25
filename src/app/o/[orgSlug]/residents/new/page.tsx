import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { listBuildingOptions } from "@/server/modules/portfolio/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { opts, RELATIONSHIP_LABEL } from "@/lib/labels";
import { createResidentAction } from "../../portfolio-actions";

export const metadata = { title: "Add resident" };

export default async function NewResidentPage({ params, searchParams }: PageProps<"/o/[orgSlug]/residents/new">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("resident.manage")) notFound();
  const buildings = await listBuildingOptions(ctx);
  const orgWide = principal.role.scopeLevel === "org";
  return (
    <>
      <Breadcrumbs items={[{ label: "Residents", href: `/o/${orgSlug}/residents` }, { label: "Add" }]} />
      <PageHeader title="Add resident" description="Record who lives in a unit. You can invite them to the resident app afterwards." />
      <Panel className="max-w-2xl p-5">
        <SchemaForm action={createResidentAction.bind(null, orgSlug)} columns={2} submitLabel="Add resident" fields={[
          { name: "firstName", label: "First name", required: true, autoFocus: true },
          { name: "lastName", label: "Last name", required: true },
          { name: "email", label: "Email", type: "email", hint: "Needed to invite them to the app." },
          { name: "phone", label: "Phone", type: "tel" },
          { name: "buildingId", label: "Building", type: "select", defaultValue: sp(q.building) ?? "", options: [
            ...(orgWide ? [{ value: "", label: "No unit yet" }] : [{ value: "", label: "Choose a building…" }]),
            ...buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` })),
          ] },
          { name: "unitNumber", label: "Unit number", defaultValue: sp(q.unit) ?? "", placeholder: "1204" },
          { name: "relationship", label: "Relationship", type: "select", options: opts(RELATIONSHIP_LABEL), defaultValue: "tenant" },
          { name: "startsOn", label: "Move-in date", type: "date", defaultValue: new Date().toISOString().slice(0, 10) },
          { name: "isPrimary", label: "Primary contact for this unit", type: "checkbox", defaultValue: true, span: 2 },
          { name: "notes", label: "Notes", type: "textarea", span: 2 },
        ]} />
      </Panel>
    </>
  );
}
