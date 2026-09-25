import Link from "next/link";
import { getOrgContext } from "@/server/org-context";
import { getOrgStats, listAuditLogs, listMyUnits } from "@/server/modules/organizations/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { describeAudit } from "@/lib/audit-labels";

export const metadata = { title: "Dashboard" };

const TYPE_LABEL: Record<string, string> = {
  residential: "Residential", commercial: "Commercial", mixed_use: "Mixed use", strata: "Strata", rental: "Rental", industrial: "Industrial",
};

export default async function DashboardPage({ params }: PageProps<"/o/[orgSlug]/dashboard">) {
  const { orgSlug } = await params;
  const { ctx, principal, session } = await getOrgContext(orgSlug);
  const first = session.user.name.split(" ")[0];

  if (principal.role.scopeLevel === "occupant") {
    const myUnits = await listMyUnits(ctx);
    return (
      <>
        <PageHeader title={`Hi ${first}`} description={principal.orgName} />
        <Panel>
          <PanelHeader title="Your home" />
          {myUnits.length === 0 ? (
            <EmptyState title="No unit linked yet">Your building manager hasn&apos;t linked your account to a unit. Contact them to get set up.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {myUnits.map((u) => (
                <li key={u.unitId} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">Unit {u.number}</p>
                    <p className="text-[13px] text-muted">{u.building} · {u.property}</p>
                  </div>
                  <Badge>{u.relationship[0].toUpperCase() + u.relationship.slice(1)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </>
    );
  }

  if (!principal.permissions.has("property.read")) {
    return (
      <>
        <PageHeader title={`Hi ${first}`} description={principal.orgName} />
        <Panel><EmptyState title="Nothing assigned to you yet">Work assigned to you by {principal.orgName} will appear here.</EmptyState></Panel>
      </>
    );
  }

  const stats = await getOrgStats(ctx);
  const activity = principal.permissions.has("audit.read") ? (await listAuditLogs(ctx, { page: 1, pageSize: 8 })).rows : null;
  const occupancy = stats.units ? Math.round((stats.occupied / stats.units) * 100) : null;
  const scoped = principal.role.scopeLevel === "scoped";

  return (
    <>
      <PageHeader
        title={`Good to see you, ${first}`}
        description={scoped ? `Showing the ${stats.properties === 1 ? "property" : "properties"} assigned to you as ${principal.role.name}.` : `Portfolio overview for ${principal.orgName}.`}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="Properties" value={stats.properties} />
        <Stat label="Buildings" value={stats.buildings} />
        <Stat label="Units" value={stats.units.toLocaleString()} sub={occupancy !== null ? `${occupancy}% occupied` : undefined} />
        {stats.residents !== null ? <Stat label="Residents" value={stats.residents.toLocaleString()} /> : null}
        {stats.members !== null ? <Stat label="Team members" value={stats.members} /> : null}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader title="Properties" description="Live counts from your portfolio." />
          {stats.propertyList.length === 0 ? (
            <EmptyState title="No properties yet">Properties you add or are assigned to will appear here.</EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Property</Th><Th>Type</Th><Th className="text-right">Buildings</Th><Th className="text-right">Units</Th><Th className="text-right">Occupancy</Th></tr></thead>
              <tbody>
                {stats.propertyList.map((p) => (
                  <tr key={p.id}>
                    <Td><div className="font-medium">{p.name}</div><div className="text-xs text-faint">{p.code}{p.city ? ` · ${p.city}` : ""}</div></Td>
                    <Td><Badge>{TYPE_LABEL[p.type] ?? p.type}</Badge></Td>
                    <Td className="text-right tabular-nums">{p.buildingCount}</Td>
                    <Td className="text-right tabular-nums">{p.unitCount}</Td>
                    <Td className="text-right tabular-nums">{p.unitCount ? `${Math.round((p.occupiedCount / p.unitCount) * 100)}%` : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        {activity ? (
          <Panel>
            <PanelHeader title="Recent activity" actions={<Link href={`/o/${orgSlug}/settings/audit`} className="text-[13px] text-accent hover:underline">View all</Link>} />
            {activity.length === 0 ? <EmptyState title="No activity yet" /> : (
              <ul className="divide-y divide-border">
                {activity.map(({ log, actorName }) => (
                  <li key={log.id} className="px-4 py-2.5">
                    <p className="text-[13px]"><span className="font-medium">{actorName ?? "System"}</span> {describeAudit(log.action)}</p>
                    <time className="text-xs text-faint" dateTime={log.createdAt.toISOString()}>{log.createdAt.toLocaleString("en-CA", { timeZone: principal.orgTimezone, dateStyle: "medium", timeStyle: "short" })}</time>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : null}
      </div>
    </>
  );
}
