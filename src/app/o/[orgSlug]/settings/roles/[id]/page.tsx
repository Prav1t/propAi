import { notFound } from "next/navigation";
import { getOrgContext, orNotFound } from "@/server/org-context";
import { getCustomRole } from "@/server/modules/members/roles";
import { Breadcrumbs } from "@/components/ui/nav-bits";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { RoleForm } from "@/components/settings/role-form";
import { updateRoleAction } from "../actions";
import { permissionChoices } from "../editor-data";

export const metadata = { title: "Edit role" };

export default async function EditRolePage({ params }: PageProps<"/o/[orgSlug]/settings/roles/[id]">) {
  const { orgSlug, id } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("role.manage") || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await orNotFound(getCustomRole(ctx, id));
  return (
    <>
      <Breadcrumbs items={[{ label: "Roles", href: `/o/${orgSlug}/settings/roles` }, { label: r.name }]} />
      <PageHeader title={`Edit role: ${r.name}`} description={r.members ? `${r.members} ${r.members === 1 ? "person has" : "people have"} this role; permission changes apply to them right away and are recorded in the audit log.` : "Nobody has this role yet."} />
      <Panel className="p-4 sm:p-6">
        <RoleForm action={updateRoleAction.bind(null, orgSlug, id)} perms={permissionChoices(principal)} templates={[]} members={r.members}
          initial={{ name: r.name, description: r.description, scopeLevel: r.scopeLevel, permissions: r.permissions }} orgWide={principal.role.scopeLevel === "org"} submitLabel="Save role" />
      </Panel>
    </>
  );
}
