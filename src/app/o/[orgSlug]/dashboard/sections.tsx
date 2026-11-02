import Link from "next/link";
import type { TenantCtx } from "@/server/modules/context";
import { getOrgStats, listAuditLogs } from "@/server/modules/organizations/service";
import { Badge, EmptyState, Panel, PanelHeader, Stat, Table, Td, Th } from "@/components/ui/primitives";
import { describeAudit } from "@/lib/audit-labels";
import { BarList } from "@/components/ops/bar-list";
import { WoMiniList } from "@/components/ops/wo-mini-list";
import { listWorkOrders } from "@/server/modules/maintenance/service";
import { listTasks, canUseTasks } from "@/server/modules/tasks/service";
import { getOpsKpis } from "@/server/modules/ops/kpis";
import { TASK_STATUS, WO_CATEGORY } from "@/lib/ops-labels";
import { fmtDay, relative } from "@/lib/time";
import { packageStats } from "@/server/modules/packages/service";
import { bookingStats } from "@/server/modules/amenities/service";
import { messageBadgeCount } from "@/server/modules/messaging/service";
import { visitorStats } from "@/server/modules/visitors/service";
import { parkingStats } from "@/server/modules/parking/service";
import { facilityStats } from "@/server/modules/assets/service";
import { hours } from "@/lib/facility-labels";
import { pendingApprovalsFor } from "@/server/automation/service";
import { computeInsights } from "@/server/analytics/insights";
import { canGetBrief } from "@/server/analytics/brief";
import { faultPoint } from "@/server/dev-faults";

// each section loads (and can fail) on its own: the page shell and the fast sections appear first

export function StatLink({ href, ...p }: { href: string; label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return <Link href={href} className="block rounded-[var(--radius-lg)] focus-visible:outline-2 [&>div]:hover:border-border-strong"><Stat {...p} /></Link>;
}

const TYPE_LABEL: Record<string, string> = {
  residential: "Residential", commercial: "Commercial", mixed_use: "Mixed use", strata: "Strata", rental: "Rental", industrial: "Industrial",
};

type S = { ctx: TenantCtx; base: string };

export async function AttentionSection({ ctx, base }: S) {
  await faultPoint("dashboard.attention");
  const p = ctx.principal;
  const [approvals, insights] = await Promise.all([pendingApprovalsFor(ctx), p.permissions.has("analytics.read") ? computeInsights(ctx) : Promise.resolve([])]);
  const brief = canGetBrief(ctx);
  if (!approvals.length && !insights.length && !brief) return null;
  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-2">
      {approvals.length ? (
        <Panel className="border-warning/40">
          <PanelHeader title="Waiting for your approval" description="Automation rules paused for your decision" actions={<Link href={`${base}/automations?tab=approvals`} className="text-[13px] text-accent hover:underline">All</Link>} />
          <ul className="divide-y divide-border">{approvals.slice(0, 4).map((a) => (
            <li key={a.id} className="px-4 py-2.5"><Link href={`${base}/automations/runs/${a.id}`} className="text-[13px] font-medium hover:underline">{a.workflowName}</Link><p className="text-[12px] text-muted">{a.entityLabel ?? ""}{a.propertyName ? ` · ${a.propertyName}` : ""}</p></li>
          ))}</ul>
        </Panel>
      ) : null}
      {insights.length ? (
        <Panel className={approvals.length ? undefined : "lg:col-span-2"}>
          <PanelHeader title="Worth a look" description="Patterns in recorded data" actions={brief ? <Link href={`${base}/brief`} className="text-[13px] text-accent hover:underline">Today&apos;s brief</Link> : null} />
          <ul className="divide-y divide-border">{insights.slice(0, 4).map((i) => (
            <li key={i.key} className="px-4 py-2.5"><Link href={`${base}${i.href}`} className="text-[13px] font-medium hover:underline">{i.title}</Link><p className="text-[12px] text-muted">{i.detail}</p></li>
          ))}</ul>
        </Panel>
      ) : brief ? (
        <Panel className={approvals.length ? undefined : "lg:col-span-2"}><div className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]"><span>Your daily brief has what changed overnight and what needs attention today.</span><Link href={`${base}/brief`} className="shrink-0 text-accent hover:underline">Open it</Link></div></Panel>
      ) : null}
    </div>
  );
}

export async function OpsSection({ ctx, base }: S) {
  const kpis = await getOpsKpis(ctx);
  const wo = kpis.workOrders;
  if (!wo) return null;
  return (
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
  );
}

export async function CommunitySection({ ctx, base }: S) {
  const p = ctx.principal;
  const [pkg, bk, msgs, vis, park] = await Promise.all([packageStats(ctx), bookingStats(ctx), p.permissions.has("message.manage") ? messageBadgeCount(ctx) : Promise.resolve(null), visitorStats(ctx), parkingStats(ctx)]);
  if (!pkg && !bk && msgs === null && !vis && !park) return null;
  return (
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
  );
}

export async function FacilitySection({ ctx, base, first = false }: S & { first?: boolean }) {
  const fac = await facilityStats(ctx);
  if (!fac) return null;
  return (
    <section aria-labelledby="facility-h" className="mb-6">
      <h2 id="facility-h" className={first ? "sr-only" : "mb-2 text-[13px] font-medium text-muted"}>Facility</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatLink href={`${base}/assets?status=down`} label="Equipment out of service" value={<span className={fac.down ? "text-danger" : undefined}>{fac.down}</span>} sub={fac.criticalDown ? `${fac.criticalDown} high/critical` : `${fac.total} assets in service`} />
        <StatLink href={`${base}/calendar?view=agenda&src=pm`} label="PM due in 14 days" value={fac.pmDueSoon} sub={`${fac.pmActive} active schedules`} />
        <StatLink href={`${base}/maintenance?view=overdue`} label="PM work orders open" value={fac.pmOpen} sub={fac.pmOverdue ? <span className="text-warning">{fac.pmOverdue} overdue</span> : `${fac.pmDone30} done in 30 days`} />
        <StatLink href={`${base}/assets`} label="Downtime (30 days)" value={hours(fac.downtimeHours30d)} sub={fac.repeat.length ? `${fac.repeat.length} asset${fac.repeat.length === 1 ? "" : "s"} with repeat failures` : undefined} />
      </div>
      {first ? (
        // facility managers see the equipment itself, not only counts
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Panel>
            <PanelHeader title="Out of service" actions={<Link href={`${base}/assets?status=down`} className="text-[13px] text-accent hover:underline">All</Link>} />
            {fac.outOfService.length === 0 ? <EmptyState title="Everything is running" /> : (
              <ul className="divide-y divide-border">{fac.outOfService.slice(0, 5).map((a) => (
                <li key={a.id} className="px-4 py-2.5">
                  <Link href={`${base}/assets/${a.id}`} className="text-sm font-medium hover:underline">{a.name}</Link>
                  <p className="text-[12px] text-muted">{a.propertyName}{a.since ? ` · down ${relative(a.since).replace(" ago", "")}` : ""}{a.reason ? ` · ${a.reason}` : ""}</p>
                </li>
              ))}</ul>
            )}
          </Panel>
          <Panel>
            <PanelHeader title="Preventive maintenance due" actions={<Link href={`${base}/calendar?view=agenda&src=pm`} className="text-[13px] text-accent hover:underline">Calendar</Link>} />
            {fac.upcoming.length === 0 ? <EmptyState title="No schedules due" /> : (
              <ul className="divide-y divide-border">{fac.upcoming.slice(0, 5).map((s) => (
                <li key={s.id} className="px-4 py-2.5">
                  <Link href={`${base}/assets/${s.assetId}`} className="text-sm font-medium hover:underline">{s.title}</Link>
                  <p className="text-[12px] text-muted">{s.assetName} · {s.propertyName} · due {fmtDay(s.nextDueOn)}</p>
                </li>
              ))}</ul>
            )}
          </Panel>
          <Panel>
            <PanelHeader title="Repeat failures" description="3 or more work orders in 90 days" />
            {fac.repeat.length === 0 ? <EmptyState title="No repeat failures" /> : (
              <ul className="divide-y divide-border">{fac.repeat.map((a) => (
                <li key={a.id} className="px-4 py-2.5">
                  <Link href={`${base}/assets/${a.id}`} className="text-sm font-medium hover:underline">{a.name}</Link>
                  <p className="text-[12px] text-muted">{a.propertyName} · {a.count} work orders · ${Math.round(a.cost).toLocaleString("en-CA")}</p>
                </li>
              ))}</ul>
            )}
          </Panel>
        </div>
      ) : null}
    </section>
  );
}

export async function MyWorkSection({ ctx, base }: S) {
  const p = ctx.principal;
  const [assignedToMe, myTasks] = await Promise.all([
    p.permissions.has("workorder.read.assigned") || p.permissions.has("workorder.manage") ? listWorkOrders(ctx, { view: "mine", pageSize: 6 }) : Promise.resolve(null),
    canUseTasks(p) ? listTasks(ctx, { view: "mine" }) : Promise.resolve(null),
  ]);
  if (!(assignedToMe && assignedToMe.total) && !(myTasks && myTasks.total)) return null;
  return (
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
  );
}

export async function PortfolioSection({ ctx, base }: S) {
  const p = ctx.principal;
  const [stats, activity] = await Promise.all([getOrgStats(ctx), p.permissions.has("audit.read") ? listAuditLogs(ctx, { page: 1, pageSize: 8 }).then((r) => r.rows) : Promise.resolve(null)]);
  const occupancy = stats.units ? Math.round((stats.occupied / stats.units) * 100) : null;
  return (
    <>
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
            <EmptyState title="No properties yet" action={p.role.scopeLevel === "org" && p.permissions.has("property.manage") ? <Link href={`${base}/properties/new`} className="text-[13px] font-medium text-accent hover:underline">Add your first property</Link> : null}>
              Properties you add or are assigned to will appear here.
            </EmptyState>
          ) : (
            <Table cards>
              <thead><tr><Th>Property</Th><Th>Type</Th><Th className="text-right">Buildings</Th><Th className="text-right">Units</Th><Th className="text-right">Occupancy</Th></tr></thead>
              <tbody>
                {stats.propertyList.map((row) => (
                  <tr key={row.id}>
                    <Td><Link href={`${base}/properties/${row.id}`} className="font-medium hover:underline">{row.name}</Link><div className="text-xs text-faint">{row.code}{row.city ? ` · ${row.city}` : ""}</div></Td>
                    <Td label="Type"><Badge>{TYPE_LABEL[row.type] ?? row.type}</Badge></Td>
                    <Td label="Buildings" className="text-right tabular-nums">{row.buildingCount}</Td>
                    <Td label="Units" className="text-right tabular-nums">{row.unitCount}</Td>
                    <Td label="Occupancy" className="text-right tabular-nums">{row.unitCount ? `${Math.round((row.occupiedCount / row.unitCount) * 100)}%` : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
        {activity ? (
          <Panel>
            <PanelHeader title="Recent activity" actions={<Link href={`${base}/settings/audit`} className="text-[13px] text-accent hover:underline">View all</Link>} />
            {activity.length === 0 ? <EmptyState title="No activity yet" /> : (
              <ul className="divide-y divide-border">
                {activity.map(({ log, actorName }) => (
                  <li key={log.id} className="px-4 py-2.5">
                    <p className="text-[13px]"><span className="font-medium">{actorName ?? "System"}</span> {describeAudit(log.action)}</p>
                    <time className="text-xs text-faint" dateTime={log.createdAt.toISOString()}>{log.createdAt.toLocaleString("en-CA", { timeZone: p.orgTimezone, dateStyle: "medium", timeStyle: "short" })}</time>
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
