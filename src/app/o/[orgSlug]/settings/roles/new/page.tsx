import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { listRoles } from "@/server/modules/members/service";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { RoleForm } from "@/components/settings/role-form";
import { createRoleAction } from "../actions";
import { permissionChoices } from "../editor-data";

export const metadata = { title: "New role" };

export default async function NewRolePage({ params }: PageProps<"/o/[orgSlug]/settings/roles/new">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("role.manage")) notFound();
  const templates = (await listRoles(ctx)).filter((r) => r.category === "staff").map((r) => ({ id: r.id, name: r.name, scopeLevel: r.scopeLevel, permissions: r.permissions }));
  return (
    <>
      <Breadcrumbs items={[{ label: "Roles", href: `/o/${orgSlug}/settings/roles` }, { label: "New role" }]} />
      <PageHeader title="New role" description="A staff role with exactly the access you choose. You can give it to people when you invite them or change their role." />
      <Panel className="p-4 sm:p-6">
        <RoleForm action={createRoleAction.bind(null, orgSlug)} perms={permissionChoices(principal)} templates={templates} orgWide={principal.role.scopeLevel === "org"} submitLabel="Create role" />
      </Panel>
    </>
  );
}
