import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { can } from "@/server/authz/authorize";
import { listBuildingOptions, listPropertyOptions } from "@/server/modules/portfolio/service";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { createAmenityAction } from "../../community-actions";
import { amenityFields } from "../amenity-fields";

export const metadata = { title: "New amenity" };

export default async function NewAmenityPage({ params }: PageProps<"/o/[orgSlug]/amenities/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("amenity.manage")) notFound();
  const props = (await listPropertyOptions(ctx)).filter((x) => can(principal, "amenity.manage", { orgId: principal.orgId, propertyId: x.id }));
  const blds = (await listBuildingOptions(ctx)).filter((b) => props.some((p) => p.id === b.propertyId));
  return (
    <>
      <Breadcrumbs items={[{ label: "Amenities", href: `/o/${orgSlug}/amenities` }, { label: "New" }]} />
      <PageHeader title="New amenity" description="Rules here are enforced on every booking, by residents, staff and (later) the assistant." />
      <Panel className="max-w-3xl p-4 sm:p-6">
        {props.length === 0 ? <EmptyState title="No properties you can configure" /> : (
          <SchemaForm action={createAmenityAction.bind(null, orgSlug)} columns={2} submitLabel="Create amenity" fields={amenityFields(props, blds)} />
        )}
      </Panel>
    </>
  );
}
