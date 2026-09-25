import { notFound } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { adminListOrganizations } from "@/server/modules/organizations/service";
import { SimpleShell } from "@/components/shell/simple-shell";
import { Badge, PageHeader, Panel, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { setOrgStatusAction } from "./actions";

export const metadata = { title: "Platform admin" };

// platform super-admin console; invisible (404) to everyone else, including org admins
export default async function AdminPage() {
  const s = await requireSession();
  if (!s.user.isPlatformAdmin) notFound();
  const orgs = await adminListOrganizations();
  return (
    <SimpleShell user={s.user} wide>
      <PageHeader title="Platform admin" description="Organizations on this deployment." />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Organizations" value={orgs.length} />
        <Stat label="Suspended" value={orgs.filter((o) => o.status === "suspended").length} />
        <Stat label="Memberships" value={orgs.reduce((a, o) => a + o.memberCount, 0)} />
        <Stat label="Units managed" value={orgs.reduce((a, o) => a + o.unitCount, 0).toLocaleString()} />
      </div>
      <Panel>
        <Table>
          <thead><tr><Th>Organization</Th><Th>Type</Th><Th>Plan</Th><Th className="text-right">Members</Th><Th className="text-right">Units</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id}>
                <Td><div className="font-medium">{o.name}</div><div className="font-mono text-xs text-faint">{o.slug}</div></Td>
                <Td className="text-muted">{o.kind.replace("_", " ")}</Td>
                <Td><Badge tone="accent">{o.planKey}</Badge></Td>
                <Td className="text-right tabular-nums">{o.memberCount}</Td>
                <Td className="text-right tabular-nums">{o.unitCount}</Td>
                <Td>{o.status === "active" ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Suspended</Badge>}</Td>
                <Td className="text-right">
                  <form action={setOrgStatusAction}>
                    <input type="hidden" name="orgId" value={o.id} />
                    <input type="hidden" name="status" value={o.status === "active" ? "suspended" : "active"} />
                    <Button type="submit" size="sm" variant={o.status === "active" ? "danger" : "secondary"}>{o.status === "active" ? "Suspend" : "Reactivate"}</Button>
                  </form>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </SimpleShell>
  );
}
