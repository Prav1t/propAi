import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { assetFormOptions, canManageAssets } from "@/server/modules/assets/service";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { createAssetAction } from "../../frontdesk-actions";
import { assetFields } from "../asset-fields";

export const metadata = { title: "Add asset" };

export default async function NewAssetPage({ params }: PageProps<"/o/[orgSlug]/assets/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!canManageAssets(principal)) notFound();
  const o = await assetFormOptions(ctx);
  if (!o.properties.length) notFound();
  return (
    <>
      <Breadcrumbs items={[{ label: "Assets", href: `/o/${orgSlug}/assets` }, { label: "Add" }]} />
      <PageHeader title="Add asset" />
      <Panel className="max-w-3xl">
        <SchemaForm action={createAssetAction.bind(null, orgSlug)} submitLabel="Add asset" columns={2} className="p-4"
          fields={assetFields({ properties: o.properties.map((p) => ({ value: p.id, label: p.name })), buildings: o.buildings.map((b) => ({ value: b.id, label: `${b.propertyName} · ${b.name}` })), vendors: o.vendors.map((v) => ({ value: v.id, label: v.name })) })} />
      </Panel>
    </>
  );
}
