import { notFound } from "next/navigation";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getProperty, listPortfolios } from "@/server/modules/portfolio/service";
import { PageHeader, Panel, PanelHeader } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { deletePropertyAction, updatePropertyAction } from "../../../portfolio-actions";
import { propertyFields } from "../../property-fields";

export const metadata = { title: "Edit property" };

export default async function EditPropertyPage({ params }: PageProps<"/o/[orgSlug]/properties/[id]/edit">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const d = await orNotFound(getProperty(ctx, id));
  if (!d.canManage) notFound();
  const orgWide = principal.role.scopeLevel === "org";
  const portfolios = principal.permissions.has("portfolio.read") ? (await listPortfolios(ctx)).filter((p) => orgWide || principal.portfolioIds.has(p.id)) : [];
  const p = d.property;
  return (
    <>
      <Breadcrumbs items={[{ label: "Properties", href: `/o/${orgSlug}/properties` }, { label: p.name, href: `/o/${orgSlug}/properties/${id}` }, { label: "Edit" }]} />
      <PageHeader title={`Edit ${p.name}`} />
      <div className="max-w-2xl space-y-6">
        <Panel className="p-5">
          <SchemaForm action={updatePropertyAction.bind(null, orgSlug, id)} fields={propertyFields(portfolios, p, orgWide)} columns={2} submitLabel="Save changes" />
        </Panel>
        {d.canDelete ? (
          <Panel>
            <PanelHeader title="Delete property" description="Permanently removes its buildings, floors, units and resident occupancy records. This can't be undone." />
            <div className="p-4">
              <ConfirmAction action={deletePropertyAction.bind(null, orgSlug, id)} label="Delete property…" confirmLabel="Delete permanently" requireText={p.code} />
            </div>
          </Panel>
        ) : null}
      </div>
    </>
  );
}
