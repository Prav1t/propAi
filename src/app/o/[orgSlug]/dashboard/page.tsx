import Link from "next/link";
import { getOrgContext } from "@/server/org-context";
import { getOrgStats, listAuditLogs } from "@/server/modules/organizations/service";
import { Badge, EmptyState, PageHeader, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { describeAudit } from "@/lib/audit-labels";
import { BarList } from "@/components/ops/bar-list";
import { WoMiniList } from "@/components/ops/wo-mini-list";
import { listWorkOrders, canListWorkOrders } from "@/server/modules/maintenance/service";
import { listTasks, canUseTasks } from "@/server/modules/tasks/service";
import { getOpsKpis } from "@/server/modules/ops/kpis";
import { TASK_STATUS, WO_CATEGORY } from "@/lib/ops-labels";
import { relative } from "@/lib/time";
import { ResidentHome } from "./resident-home";
import { packageStats } from "@/server/modules/packages/service";
import { bookingStats } from "@/server/modules/amenities/service";
import { messageBadgeCount } from "@/server/modules/messaging/service";
import { visitorStats } from "@/server/modules/visitors/service";
import { parkingStats } from "@/server/modules/parking/service";
import { facilityStats } from "@/server/modules/assets/service";
import { hours } from "@/lib/facility-labels";
import { DeskConsole } from "../desk/desk-console";

function StatLink({ href, ...p }: { href: string; label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return <Link href={href} className="block rounded-[var(--radius-lg)] focus-visible:outline-2 [&>div]:hover:border-border-strong"><Stat {...p} /></Link>;
}

export const metadata = { title: "Dashboard" };

const TYPE_LABEL: Record<string, string> = {
  residential: "Residential", commercial: "Commercial", mixed_use: "Mixed use", strata: "Strata", rental: "Rental", industrial: "Industrial",
};

export default async function DashboardPage({ params }: PageProps<"/o/[orgSlug]/dashboard">) {
  const { orgSlug } = await params;
  const { ctx, principal, session } = await getOrgContext(orgSlug);
  const first = session.user.name.split(" ")[0];

  const base = `/o/${orgSlug}`;
  if (principal.role.scopeLevel === "occupant") return <ResidentHome ctx={ctx} principal={principal} first={first} base={base} />;
  // the front desk's home is the desk console
  if (["concierge", "security"].includes(principal.role.key)) return <DeskConsole ctx={ctx} principal={principal} orgSlug={orgSlug} title={`Hi ${first}`} />;

  if (!principal.permissions.has("property.read")) {
    const jobs = canListWorkOrders(principal) ? await listWorkOrders(ctx, { view: "open", pageSize: 10 }) : null;
    return (
      <>
        <PageHeader title={`Hi ${first}`} description={principal.vendorId ? `Jobs from ${principal.orgName}` : principal.orgName} />
        <Panel>
          <PanelHeader title="Open jobs" description={jobs ? `${jobs.total} open` : undefined} actions={jobs ? <Link href={`${base}/maintenance`} className="text-[13px] text-accent hover:underline">All jobs</Link> : null} />
          {jobs ? <WoMiniList rows={jobs.rows} base={base} empty="Nothing assigned to you right now" /> : <EmptyState title="Nothing assigned to you yet">Work assigned to you by {principal.orgName} will appear here.</EmptyState>}
        </Panel>
      </>
    );
  }

  const stats = await getOrgStats(ctx);
  const activity = principal.permissions.has("audit.read") ? (await listAuditLogs(ctx, { page: 1, pageSize: 8 })).rows : null;
  const occupancy = stats.units ? Math.round((stats.occupied / stats.units) * 100) : null;
  const scoped = principal.role.scopeLevel === "scoped";
  const kpis = await getOpsKpis(ctx);
  const wo = kpis.workOrders;
  const assignedToMe = principal.permissions.has("workorder.read.assigned") || principal.permissions.has("workorder.manage") ? await listWorkOrders(ctx, { view: "mine", pageSize: 6 }) : null;
  const myTasks = canUseTasks(principal) ? await listTasks(ctx, { view: "mine" }) : null;
  const [pkg, bk, msgs, vis, park, fac] = await Promise.all([packageStats(ctx), bookingStats(ctx), principal.permissions.has("message.manage") ? messageBadgeCount(ctx) : Promise.resolve(null),
    visitorStats(ctx), parkingStats(ctx), facilityStats(ctx)]);

  return (
    <>
      <PageHeader
        title={`Good to see you, ${first}`}
        description={scoped ? `Showing the ${stats.properties === 1 ? "property" : "properties"} assigned to you as ${principal.role.name}.` : `Portfolio overview for ${principal.orgName}.`}
      />
      {wo ? (
        <section aria-labelledby="ops-h" className="mb-6">
          <h2 id="ops-h" className="sr-only">Operations</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatLink href={`${base}/maintenance`} label="Open work orders" value={wo.open} sub={`${wo.unassigned} unassigned`} />
            <StatLink href={`${base}/maintenance?view=overdue`} label="Overdue" value={<span className={wo.overdue ? "text-danger" : undefined}>{wo.overdue}</span>} sub="past resolution target" />
            <StatLink href={`${base}/maintenance?view=emergency`} label="Emergencies" value={<span className={wo.emergency ? "text-danger" : undefined}>{wo.emergency}</span>} sub="open" />
            <Stat label="SLA met" value={wo.slaCompliance === null ? "—" : `${wo.slaCompliance}%`} sub={`${wo.completed} completed · 30 days`} />
            <Stat label="Avg. first response" value={wo.avgResponseH === null ? "—" : `${wo.avgResponseH} h`} sub={wo.avgResolveH === null ? "30 days" : `resolve ${wo.avgResolveH} h · 30 days`} />
            <Stat label="Maintenance spend" value={`$${Math.round(wo.spend).toLocaleString("en-CA")}`} sub="completed · 30 days" />
          </div>
          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Panel><PanelHeader title="Open by property" description="Overdue in brackets" />
              <BarList rows={wo.byProperty.map((r) => ({ key: r.id, label: r.key, value: r.n, sub: r.overdue ? `${r.overdue} overdue` : undefined }))} href={(k) => `${base}/maintenance?property=${k}`} emptyLabel="No open work" /></Panel>
            <Panel><PanelHeader title="Open by category" />
              <BarList rows={wo.byCategory.map((r) => ({ key: r.key, label: WO_CATEGORY[r.key] ?? r.key, value: r.n }))} href={(k) => `${base}/maintenance?category=${k}`} emptyLabel="No open work" /></Panel>
            <Panel><PanelHeader title="Open by vendor" />
              <BarList rows={wo.byVendor.map((r) => ({ key: r.id, label: r.key, value: r.n, sub: r.overdue ? `${r.overdue} overdue` : undefined }))} emptyLabel="No vendor work open" /></Panel>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            {kpis.complaints ? <StatLink href={`${base}/complaints`} label="Open complaints" value={kpis.complaints.open} /> : null}
            {kpis.incidents ? <StatLink href={`${base}/incidents`} label="Open incidents" value={kpis.incidents.open} sub={`${kpis.incidents.openSerious} high/critical · ${kpis.incidents.last7} in 7 days`} /> : null}
            {kpis.inspections ? <StatLink href={`${base}/inspections`} label="Inspections next 14 days" value={kpis.inspections.upcoming} sub={kpis.inspections.overdue ? `${kpis.inspections.overdue} overdue` : "none overdue"} /> : null}
            <StatLink href={`${base}/tasks?view=mine`} label="My open tasks" value={kpis.myTasks.open} sub={kpis.myTasks.overdue ? `${kpis.myTasks.overdue} overdue` : undefined} />
          </div>
        </section>
      ) : null}

      {pkg || bk || msgs !== null || vis || park ? (
        <section aria-labelledby="community-h" className="mb-6">
          <h2 id="community-h" className="mb-2 text-[13px] font-medium text-muted">Front desk & community</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {pkg ? <StatLink href={`${base}/packages`} label="Packages waiting" value={pkg.waiting} sub={pkg.overdue ? `${pkg.overdue} over 7 days` : `${pkg.last24h} arrived in 24 h`} /> : null}
            {pkg && pkg.perishable ? <StatLink href={`${base}/packages`} label="Perishable waiting" value={<span className="text-danger">{pkg.perishable}</span>} /> : null}
            {bk ? <StatLink href={`${base}/amenities/bookings?view=pending`} label="Bookings to approve" value={<span className={bk.pending ? "text-warning" : undefined}>{bk.pending}</span>} sub={`${bk.today} booked today`} /> : null}
            {msgs !== null ? <StatLink href={`${base}/messages`} label="Messages needing a reply" value={<span className={msgs ? "text-warning" : undefined}>{msgs}</span>} /> : null}
            {vis ? <StatLink href={`${base}/visitors`} label="Visitors expected today" value={vis.expectedToday} sub={`${vis.onSite} on site now`} /> : null}
            {park ? <StatLink href={`${base}/parking`} label="Parking reports to review" value={<span className={park.review ? "text-warning" : undefined}>{park.review}</span>} sub={`${park.visitorFree}/${park.visitor} visitor spaces free`} /> : null}
          </div>
        </section>
      ) : null}

      {fac ? (
        <section aria-labelledby="facility-h" className="mb-6">
          <h2 id="facility-h" className="mb-2 text-[13px] font-medium text-muted">Facility</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatLink href={`${base}/assets?status=down`} label="Equipment out of service" value={<span className={fac.down ? "text-danger" : undefined}>{fac.down}</span>} sub={fac.criticalDown ? `${fac.criticalDown} high/critical` : `${fac.total} assets in service`} />
            <StatLink href={`${base}/calendar?view=agenda&src=pm`} label="PM due in 14 days" value={fac.pmDueSoon} sub={`${fac.pmActive} active schedules`} />
            <StatLink href={`${base}/maintenance?view=overdue`} label="PM work orders open" value={fac.pmOpen} sub={fac.pmOverdue ? <span className="text-warning">{fac.pmOverdue} overdue</span> : `${fac.pmDone30} done in 30 days`} />
            <StatLink href={`${base}/assets`} label="Downtime (30 days)" value={hours(fac.downtimeHours30d)} sub={fac.repeat.length ? `${fac.repeat.length} asset${fac.repeat.length === 1 ? "" : "s"} with repeat failures` : undefined} />
          </div>
        </section>
      ) : null}

      {(assignedToMe && assignedToMe.total) || (myTasks && myTasks.total) ? (
        <div className="mb-6 grid gap-6 lg:grid-cols-2">
          {assignedToMe ? <Panel><PanelHeader title="Assigned to me" actions={<Link href={`${base}/maintenance?view=mine`} className="text-[13px] text-accent hover:underline">View all</Link>} />
            <WoMiniList rows={assignedToMe.rows} base={base} empty="Nothing assigned to you" /></Panel> : null}
          {myTasks ? <Panel><PanelHeader title="My tasks" actions={<Link href={`${base}/tasks?view=mine`} className="text-[13px] text-accent hover:underline">View all</Link>} />
            {myTasks.rows.length === 0 ? <EmptyState title="No open tasks" /> : (
              <ul className="divide-y divide-border">{myTasks.rows.slice(0, 6).map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <Link href={`${base}/tasks/${t.id}`} className="truncate text-sm font-medium hover:underline">{t.title}</Link>
                  <span className="flex shrink-0 items-center gap-2">{t.dueAt ? <span className={`text-[11px] ${t.overdue ? "text-danger" : "text-faint"}`}>{relative(t.dueAt)}</span> : null}<Badge tone={TASK_STATUS[t.status]?.tone}>{TASK_STATUS[t.status]?.label}</Badge></span>
                </li>))}</ul>
            )}</Panel> : null}
        </div>
      ) : null}

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
