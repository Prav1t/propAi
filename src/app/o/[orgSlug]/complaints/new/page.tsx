import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { COMPLAINT_CATEGORIES } from "@/server/db/schema";
import { listBuildingOptions } from "@/server/modules/portfolio/service";
import { residentUnitsForRequests } from "@/server/modules/maintenance/service";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm, type FieldDef } from "@/components/ui/schema-form";
import { COMPLAINT_CATEGORY } from "@/lib/ops-labels";
import { createComplaintAction } from "../../ops-actions";

export const metadata = { title: "New complaint" };

export default async function NewComplaintPage({ params }: PageProps<"/o/[orgSlug]/complaints/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("complaint.create") && !principal.permissions.has("complaint.manage")) notFound();
  const resident = principal.role.category === "resident";
  const units = resident ? await residentUnitsForRequests(ctx) : [];
  const buildings = resident ? [] : await listBuildingOptions(ctx);
  const location: FieldDef[] = resident
    ? (units.length > 1 ? [{ name: "unitId", label: "Your unit", type: "select", options: units.map((u) => ({ value: u.id, label: `Unit ${u.number} · ${u.building}` })) }] : [])
    : [
        { name: "buildingId", label: "Building", type: "select", options: [{ value: "", label: "Choose…" }, ...buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` }))] },
        { name: "unitNumber", label: "Complainant's unit (optional)" },
      ];
  return (
    <>
      <Breadcrumbs items={[{ label: "Complaints", href: `/o/${orgSlug}/complaints` }, { label: "New" }]} />
      <PageHeader title="New complaint" description={resident ? "Your complaint is shared with building management only." : "Log a complaint received in person, by phone or email."} />
      <Panel className="max-w-2xl p-4 sm:p-6">
        {resident && units.length === 0 ? <EmptyState title="No unit linked to your account">Ask your building manager to link your account to your unit.</EmptyState> : (
          <SchemaForm action={createComplaintAction.bind(null, orgSlug)} columns={2} submitLabel="Submit" hidden={resident && units.length === 1 ? { unitId: units[0].id } : undefined} fields={[
            ...location,
            { name: "category", label: "Category", type: "select", options: COMPLAINT_CATEGORIES.map((c) => ({ value: c, label: COMPLAINT_CATEGORY[c] ?? c })) },
            { name: "subject", label: "Subject", span: 2 },
            { name: "description", label: "What happened?", type: "textarea", span: 2, hint: "Dates, times and locations help us follow up. Describe what you observed." },
          ]} />
        )}
      </Panel>
    </>
  );
}
