import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { can } from "@/server/authz/authorize";
import { listRoles } from "@/server/modules/members/service";
import { PERMISSIONS } from "@/server/authz/permissions";
import { Badge, PageHeader, Panel } from "@/components/ui/primitives";

export const metadata = { title: "Roles" };

const SCOPE: Record<string, string> = {
  org: "Organization-wide", scoped: "Assigned portfolios, properties or buildings", occupant: "Own unit(s) only", assigned: "Work assigned to them only",
};

export default async function RolesPage({ params }: PageProps<"/o/[orgSlug]/settings/roles">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!can(principal, "role.read")) notFound();
  const roles = await listRoles(ctx);
  const modules = [...new Set(Object.values(PERMISSIONS).map((p) => p.module))];
  return (
    <>
      <PageHeader title="Roles & permissions" description="System roles. Permissions are enforced on the server for every request." />
      <div className="space-y-3">
        {roles.map((r) => (
          <Panel key={r.id}>
            <details>
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span>
                  <span className="text-sm font-medium">{r.name}</span>
                  <span className="ml-2 text-[13px] text-muted">{r.description}</span>
                </span>
                <span className="flex gap-2"><Badge>{SCOPE[r.scopeLevel]}</Badge><Badge tone="accent">{r.permissions.length} permissions</Badge></span>
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
            </details>
          </Panel>
        ))}
      </div>
    </>
  );
}
