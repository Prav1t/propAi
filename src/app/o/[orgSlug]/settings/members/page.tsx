import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { can } from "@/server/authz/authorize";
import { listAssignableRoles, listMembers, listPendingInvitations, listPropertiesForPicker } from "@/server/modules/members/service";
import { revokeInvitationAction } from "../actions";
import { Avatar, Badge, EmptyState, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { InviteForm, ManageMember } from "./member-forms";

export const metadata = { title: "Members" };

export default async function MembersPage({ params }: PageProps<"/o/[orgSlug]/settings/members">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!can(principal, "member.read")) notFound();
  const canManage = can(principal, "member.manage");
  const [members, invites, roles, properties] = await Promise.all([
    listMembers(ctx),
    canManage ? listPendingInvitations(ctx) : Promise.resolve([]),
    canManage ? listAssignableRoles(ctx) : Promise.resolve([]),
    canManage ? listPropertiesForPicker(ctx) : Promise.resolve([]),
  ]);
  const tz = principal.orgTimezone;
  const fmt = (d: Date | null) => (d ? d.toLocaleDateString("en-CA", { timeZone: tz, dateStyle: "medium" }) : "Never");

  return (
    <>
      <PageHeader title="Members" description={`${members.filter((m) => m.status === "active").length} active members. Access is scoped by role and property.`} />
      <div className="space-y-6">
        <Panel>
          <Table>
            <thead><tr><Th>Member</Th><Th>Role</Th><Th className="hidden md:table-cell">Scope</Th><Th className="hidden md:table-cell">Last sign-in</Th><Th>Status</Th>{canManage ? <Th><span className="sr-only">Actions</span></Th> : null}</tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membershipId} className={m.status !== "active" ? "opacity-60" : undefined}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={m.name} />
                      <div className="min-w-0"><div className="truncate font-medium">{m.name}{m.userId === principal.userId ? <span className="font-normal text-faint"> (you)</span> : null}</div><div className="truncate text-xs text-faint">{m.email}</div></div>
                    </div>
                  </Td>
                  <Td>{m.roleName}</Td>
                  <Td className="hidden text-muted md:table-cell">{m.scopeLevel === "org" ? "Organization-wide" : m.scopeLevel === "occupant" ? "Own unit" : m.scopeLevel === "assigned" ? "Assigned work" : m.scopes.length ? m.scopes.join(", ") : "Portfolio / building"}</Td>
                  <Td className="hidden text-muted md:table-cell">{fmt(m.lastLoginAt)}</Td>
                  <Td>{m.status === "active" ? <Badge tone="success">Active</Badge> : <Badge>Deactivated</Badge>} {m.mfaEnabled ? <Badge tone="accent">2FA</Badge> : null}</Td>
                  {canManage ? (
                    <Td className="text-right">
                      {m.membershipId !== principal.membershipId ? (
                        <ManageMember orgSlug={orgSlug} membershipId={m.membershipId} status={m.status} roles={roles} properties={properties} />
                      ) : null}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>

        {canManage ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <Panel>
              <PanelHeader title="Invite a teammate" description="They'll get an email link valid for 7 days." />
              <InviteForm orgSlug={orgSlug} roles={roles} properties={properties} />
            </Panel>
            <Panel>
              <PanelHeader title="Pending invitations" />
              {invites.length === 0 ? <EmptyState title="No pending invitations" /> : (
                <ul className="divide-y divide-border">
                  {invites.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{i.email}</p>
                        <p className="text-xs text-faint">{i.roleName}{i.propertyName ? ` · ${i.propertyName}` : ""} · expires {fmt(i.expiresAt)}</p>
                      </div>
                      <form action={revokeInvitationAction}>
                        <input type="hidden" name="orgSlug" value={orgSlug} />
                        <input type="hidden" name="invitationId" value={i.id} />
                        <Button type="submit" variant="ghost" size="sm">Revoke</Button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        ) : null}
      </div>
    </>
  );
}
