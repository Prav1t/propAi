import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { VENDOR_CATEGORIES } from "@/server/modules/vendors/service";
import { listPropertyOptions } from "@/server/modules/portfolio/service";
import { can } from "@/server/authz/authorize";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { SchemaForm } from "@/components/ui/schema-form";
import { createVendorAction } from "../../portfolio-actions";
import { vendorFields } from "../vendor-fields";

export const metadata = { title: "Add vendor" };

export default async function NewVendorPage({ params }: PageProps<"/o/[orgSlug]/vendors/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("vendor.manage")) notFound();
  const orgWide = principal.role.scopeLevel === "org";
  const props = (await listPropertyOptions(ctx)).filter((p) => can(principal, "vendor.manage", { orgId: principal.orgId, propertyId: p.id }));
  return (
    <>
      <Breadcrumbs items={[{ label: "Vendors", href: `/o/${orgSlug}/vendors` }, { label: "Add" }]} />
      <PageHeader title="Add vendor" />
      <Panel className="max-w-2xl p-5">
        <SchemaForm action={createVendorAction.bind(null, orgSlug)} columns={2} submitLabel="Add vendor" fields={[
          ...vendorFields(VENDOR_CATEGORIES),
          { name: "propertyId", label: "Approve for property", type: "select", span: 2, hint: orgWide ? "Optional. You can approve more properties later." : "Required: vendors you add must serve one of your properties.",
            options: [{ value: "", label: orgWide ? "None yet" : "Choose…" }, ...props.map((p) => ({ value: p.id, label: p.name }))] },
        ]} />
      </Panel>
    </>
  );
}
