import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { listPortfolios } from "@/server/modules/portfolio/service";
import { can } from "@/server/authz/authorize";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { createPropertyAction } from "../../portfolio-actions";
import { propertyFields } from "../property-fields";

export const metadata = { title: "New property" };

export default async function NewPropertyPage({ params }: PageProps<"/o/[orgSlug]/properties/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  const orgWide = principal.role.scopeLevel === "org";
  if (!(orgWide ? can(principal, "property.manage") : principal.portfolioIds.size > 0 && principal.permissions.has("property.manage"))) notFound();
  const portfolios = principal.permissions.has("portfolio.read") ? (await listPortfolios(ctx)).filter((p) => orgWide || principal.portfolioIds.has(p.id)) : [];
  return (
    <>
      <Breadcrumbs items={[{ label: "Properties", href: `/o/${orgSlug}/properties` }, { label: "New" }]} />
      <PageHeader title="New property" description="You can add buildings, floors and units next." />
      <Panel className="max-w-2xl p-5">
        <SchemaForm action={createPropertyAction.bind(null, orgSlug)} fields={propertyFields(portfolios, {}, orgWide)} columns={2} submitLabel="Create property" pendingLabel="Creating…" />
      </Panel>
    </>
  );
}
