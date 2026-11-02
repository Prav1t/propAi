import { notFound } from "next/navigation";
import { getOrgContext, sp } from "@/server/org-context";
import { can } from "@/server/authz/authorize";
import { listRoles } from "@/server/modules/members/service";
import { roleMemberCounts } from "@/server/modules/members/roles";
import { PERMISSIONS } from "@/server/authz/permissions";
import { Badge, PageHeader, Panel } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { deleteRoleAction } from "./actions";

export const metadata = { title: "Roles" };

const SCOPE: Record<string, string> = {
  org: "Organization-wide", scoped: "Assigned portfolios, properties or buildings", occupant: "Own unit(s) only", assigned: "Work assigned to them only",
};

export default async function RolesPage({ params, searchParams }: PageProps<"/o/[orgSlug]/settings/roles">) {
  const { orgSlug } = await params;
  const q = await searchParams;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!can(principal, "role.read")) notFound();
  const [all, members] = await Promise.all([listRoles(ctx), roleMemberCounts(ctx)]);
  const manage = principal.permissions.has("role.manage");
  const custom = all.filter((r) => !r.isSystem);
  const system = all.filter((r) => r.isSystem);
  const modules = [...new Set(Object.values(PERMISSIONS).map((p) => p.module))];
  const base = `/o/${orgSlug}/settings/roles`;
  const RoleRow = ({ r }: { r: (typeof all)[number] }) => (
    <Panel key={r.id} data-testid={r.isSystem ? undefined : "custom-role"}>
      <details>
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3">
          <span>
            <span className="text-sm font-medium">{r.name}</span>
            {r.description ? <span className="ml-2 text-[13px] text-muted">{r.description}</span> : null}
          </span>
          <span className="flex flex-wrap gap-2">
            {!r.isSystem ? <Badge tone="accent">Custom</Badge> : null}
            <Badge>{SCOPE[r.scopeLevel]}</Badge>
            <Badge>{r.permissions.length} permissions</Badge>
            {members[r.id] ? <Badge>{members[r.id]} {members[r.id] === 1 ? "member" : "members"}</Badge> : null}
          </span>
        </summary>
        <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2 lg:grid-cols-3">
          {modules.map((m) => {
            const perms = Object.entries(PERMISSIONS).filter(([k, v]) => v.module === m && r.permissions.includes(k));
            if (!perms.length) return null;
            return (
              <div key={m}>
                <p className="text-xs font-medium uppercase tracking-wide text-faint">{m}</p>
                <ul className="mt-1 space-y-0.5 text-[13px]">{perms.map(([k, v]) => <li key={k} title={k}>{v.description}</li>)}</ul>
              </div>
            );
          })}
        </div>
        {manage && !r.isSystem ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            <LinkButton href={`${base}/${r.id}`} size="sm" variant="secondary">Edit</LinkButton>
            {members[r.id] ? <span className="text-[12px] text-faint">Move its members to another role before deleting it.</span>
              : <ConfirmAction action={deleteRoleAction.bind(null, orgSlug, r.id)} label="Delete" confirmLabel="Delete role" description={`Delete “${r.name}”? Nobody has it, so no one loses access.`} />}
          </div>
        ) : null}
      </details>
    </Panel>
  );
  return (
    <>
      <PageHeader title="Roles & permissions" description="Permissions are enforced on the server for every request."
        actions={manage ? <LinkButton href={`${base}/new`}>New role</LinkButton> : null} />
      {sp(q.saved) ? <div className="mb-4"><FormAlert kind="success">Role saved. Changes apply to everyone with it right away.</FormAlert></div> : null}
      {sp(q.deleted) ? <div className="mb-4"><FormAlert kind="success">Role deleted.</FormAlert></div> : null}
      <h2 className="mb-2 text-[13px] font-medium text-muted">Custom roles</h2>
      {custom.length ? <div className="mb-6 space-y-3">{custom.map((r) => <RoleRow key={r.id} r={r} />)}</div>
        : <Panel className="mb-6 px-4 py-6 text-center text-[13px] text-muted">{manage ? "No custom roles yet. Create one when a system role gives too much or too little access." : "No custom roles yet."}</Panel>}
      <h2 className="mb-2 text-[13px] font-medium text-muted">System roles</h2>
      <div className="space-y-3">{system.map((r) => <RoleRow key={r.id} r={r} />)}</div>
    </>
  );
}
