import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/server/org-context";
import { analyticsFilters } from "@/server/analytics/page-filters";
import { canReadMetric, metricBreakdown, metricSeries, metricValues, type MetricKey } from "@/server/analytics/metrics";
import { bucketLabel } from "@/server/analytics/period";
import { propertyHealth } from "@/server/analytics/health";
import { computeInsights } from "@/server/analytics/insights";
import { getEntitlements } from "@/server/billing/entitlements";
import { vendorPerformance } from "@/server/modules/analytics/vendors";
import { automationStats, canManageAutomations } from "@/server/automation/service";
import { availableReports } from "@/server/analytics/reports";
import { EmptyState, PageHeader, Panel, PanelHeader, Table, Td, Th } from "@/components/ui/primitives";
import { LinkButton } from "@/components/ui/button";
import { FilterBar } from "@/components/ui/filter-bar";
import { BarList } from "@/components/ops/bar-list";
import { TrendChart } from "@/components/analytics/trend-chart";
import { HealthBadge, MetricTile, SectionTitle } from "@/components/analytics/bits";
import { REPORT_LABEL } from "@/lib/automation";
import { hours } from "@/lib/facility-labels";

export const metadata = { title: "Analytics" };

const TONE_CLASS = { danger: "border-l-danger", warning: "border-l-warning", accent: "border-l-accent", neutral: "border-l-border-strong" };

export default async function AnalyticsPage({ params, searchParams }: PageProps<"/o/[orgSlug]/analytics">) {
  const { orgSlug } = await params;
  const { ctx, principal } = await getOrgContext(orgSlug);
  if (!principal.permissions.has("analytics.read")) notFound();
  const f = await analyticsFilters(ctx, await searchParams);
  const base = `/o/${orgSlug}`;
  const scope = { propertyId: f.propertyId, buildingId: f.buildingId };
  const can = (k: MetricKey) => canReadMetric(principal, k);
  const bucket = f.period.bucket;
  // health scores and insights are a plan feature (Iteration 10)
  const advanced = (await getEntitlements(principal.orgId)).features.advanced_analytics;
  const scopeQs = `${f.propertyId ? `&property=${f.propertyId}` : ""}${f.buildingId ? `&building=${f.buildingId}` : ""}`;

  const [maint, community, facility, created, completed, byCategory, openByProperty, complaintsBy, incidentsBy, health, insights, vendors, auto] = await Promise.all([
    metricValues(ctx, ["requests_created", "requests_completed", "resolution_hours", "sla_compliance", "first_response_hours", "maintenance_spend", "open_backlog", "overdue_now"], f.period, f.previous, scope),
    metricValues(ctx, ["complaints_created", "incidents_reported", "serious_incidents", "packages_received", "package_pickup_hours", "amenity_bookings"], f.period, f.previous, scope),
    metricValues(ctx, ["downtime_hours", "inspections_completed", "inspection_failure_rate", "tasks_completed", "open_tasks", "backlog_age_days"], f.period, f.previous, scope),
    metricSeries(ctx, "requests_created", f.period, scope), metricSeries(ctx, "requests_completed", f.period, scope),
    metricBreakdown(ctx, "requests_created", "category", f.period, scope, 8),
    f.propertyId ? metricBreakdown(ctx, "open_backlog", "building", null, scope, 8) : metricBreakdown(ctx, "open_backlog", "property", null, scope, 8),
    metricBreakdown(ctx, "complaints_created", "category", f.period, scope, 6),
    metricBreakdown(ctx, "incidents_reported", "type", f.period, scope, 6),
    advanced && can("open_backlog") ? propertyHealth(ctx, { propertyId: f.propertyId }) : Promise.resolve([]),
    advanced ? computeInsights(ctx) : Promise.resolve([]),
    principal.permissions.has("vendor.read") && can("requests_completed") ? vendorPerformance(ctx, { from: f.period.from, to: f.period.to, propertyId: f.propertyId ?? undefined, buildingId: f.buildingId ?? undefined }) : Promise.resolve([]),
    canManageAutomations(principal) ? automationStats(ctx, f.period.from, f.period.to) : Promise.resolve(null),
  ]);
  const reports = availableReports(ctx);
  const labels = (created ?? completed ?? []).map((pnt) => bucketLabel(pnt.bucket, bucket));
  const drill: Partial<Record<MetricKey, string>> = {
    requests_created: `${base}/maintenance?view=all${scopeQs}`, requests_completed: `${base}/maintenance?view=completed${scopeQs}`, open_backlog: `${base}/maintenance?view=open${scopeQs}`,
    overdue_now: `${base}/maintenance?view=overdue${scopeQs}`, complaints_created: `${base}/complaints?view=all${f.propertyId ? `&property=${f.propertyId}` : ""}`, incidents_reported: `${base}/incidents`,
    serious_incidents: `${base}/incidents`, packages_received: `${base}/packages`, amenity_bookings: `${base}/amenities/bookings`, inspections_completed: `${base}/inspections?view=completed`,
    downtime_hours: `${base}/assets`, open_tasks: `${base}/tasks`, tasks_completed: `${base}/tasks?view=done`,
  };

  return (
    <>
      <PageHeader
        title="Analytics"
        description={`${f.period.label} (${f.period.fromDate} to ${f.period.toDate}), compared with the ${f.period.days} days before. Every number is computed from recorded data you can see.`}
        actions={<div className="flex gap-2">
          {reports.length ? <LinkButton href={`${base}/analytics/reports${f.query()}`} variant="secondary" size="sm">Reports</LinkButton> : null}
          <LinkButton href={`${base}/brief`} variant="secondary" size="sm">Daily brief</LinkButton>
        </div>}
      />
      <Panel className="mb-6">
        <FilterBar search={false} filters={[
          { name: "period", label: "Period", allLabel: "Last 30 days", options: f.periodOptions.filter((o) => o.value !== "30d") },
          ...(f.properties.length > 1 ? [{ name: "property", label: "Property", allLabel: "all", options: f.properties.map((p) => ({ value: p.id, label: p.name })) }] : []),
          ...(f.buildings.length > 1 ? [{ name: "building", label: "Building", allLabel: "all", options: f.buildings.map((b) => ({ value: b.id, label: b.name })) }] : []),
        ]} />
      </Panel>

      <div className="space-y-8">
      {insights.length ? (
        <section aria-labelledby="insights-h">
          <SectionTitle id="insights-h">Worth a look</SectionTitle>
          <ul className="grid gap-2 md:grid-cols-2">
            {insights.slice(0, 6).map((i) => (
              <li key={i.key}>
                <Link href={`${base}${i.href}`} className={`block rounded-[var(--radius-lg)] border border-border border-l-[3px] ${TONE_CLASS[i.tone]} bg-surface px-4 py-2.5 hover:border-border-strong`}>
                  <p className="text-[13px] font-medium">{i.title}</p>
                  <p className="text-[12px] text-muted">{i.detail}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {maint.length ? (
        <section aria-labelledby="maint-h">
          <SectionTitle id="maint-h">Maintenance</SectionTitle>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {maint.map((m) => <MetricTile key={m.key} m={m} periodDays={f.period.days} href={drill[m.key]} />)}
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
            {created && completed ? (
              <Panel className="lg:col-span-2">
                <PanelHeader title="Requests created and completed" description={`Per ${bucket}`} />
                <TrendChart title={`Maintenance requests created and completed per ${bucket}, ${f.period.label}`} labels={labels} unitLabel={bucket === "month" ? "Month" : bucket === "week" ? "Week of" : "Day"}
                  series={[{ key: "created", label: "Created", values: created.map((x) => x.value) }, { key: "completed", label: "Completed", values: completed.map((x) => x.value) }]} />
              </Panel>
            ) : null}
            <Panel>
              <PanelHeader title="Created by category" description={f.period.label} />
              <BarList rows={(byCategory ?? []).map((r) => ({ key: r.key, label: r.label, value: r.value ?? 0 }))} href={(k) => `${base}/maintenance?view=all&category=${k}${scopeQs}`} emptyLabel="No requests in this period" />
            </Panel>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
            <Panel>
              <PanelHeader title={f.propertyId ? "Open now by building" : "Open now by property"} />
              <BarList rows={(openByProperty ?? []).map((r) => ({ key: r.key, label: r.label, value: r.value ?? 0 }))} href={f.propertyId ? (k) => `${base}/maintenance?property=${f.propertyId}&building=${k === "none" ? "" : k}` : (k) => `${base}/maintenance?property=${k}`} emptyLabel="Nothing open" />
            </Panel>
            {vendors.length ? (
              <Panel className="lg:col-span-2">
                <PanelHeader title="Vendors" description="Jobs completed in the period; open and overdue as of now" actions={reports.includes("vendors") ? <Link href={`${base}/analytics/reports/vendors${f.query()}`} className="text-[13px] text-accent hover:underline">Full report</Link> : null} />
                <div className="overflow-x-auto">
                  <Table>
                    <thead><tr><Th>Vendor</Th><Th className="text-right">Completed</Th><Th className="text-right">Avg. time to complete</Th><Th className="text-right">On time</Th><Th className="text-right">Overdue now</Th></tr></thead>
                    <tbody>
                      {vendors.slice(0, 6).map((v) => (
                        <tr key={v.vendorId}>
                          <Td><Link href={`${base}/vendors/${v.vendorId}`} className="font-medium hover:underline">{v.name}</Link></Td>
                          <Td className="text-right tabular-nums">{v.completed}</Td>
                          <Td className="text-right tabular-nums">{v.avgResolveHours === null ? "—" : hours(v.avgResolveHours)}</Td>
                          <Td className="text-right tabular-nums">{v.onTimePct === null ? "—" : `${v.onTimePct}%`}</Td>
                          <Td className={`text-right tabular-nums ${v.overdueNow ? "text-danger" : ""}`}>{v.overdueNow}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Panel>
            ) : null}
          </div>
        </section>
      ) : null}

      {!advanced && can("open_backlog") ? (
        <p className="text-[13px] text-muted">Property health scores and insights are included in the Professional and Enterprise plans.</p>
      ) : null}
      {health.length ? (
        <section aria-labelledby="health-h">
          <SectionTitle id="health-h" action={principal.permissions.has("org.settings.manage") ? <Link href={`${base}/settings/analytics`} className="text-[13px] text-accent hover:underline">Weights</Link> : null}>Property health</SectionTitle>
          <Panel>
            <div className="overflow-x-auto">
              <Table>
                <thead><tr><Th>Property</Th><Th>Score</Th><Th className="hidden md:table-cell">Weakest factor</Th><Th className="sr-only">Details</Th></tr></thead>
                <tbody>
                  {health.map((h) => (
                    <tr key={h.propertyId}>
                      <Td className="font-medium">{h.name}</Td>
                      <Td><HealthBadge score={h.score} grade={h.grade} /></Td>
                      <Td className="hidden text-[13px] text-muted md:table-cell">{h.weakest ? `${h.weakest.label}: ${h.weakest.valueText} (scores ${h.weakest.score})` : "—"}</Td>
                      <Td className="text-right"><Link href={`${base}/analytics/health/${h.propertyId}`} className="text-[13px] text-accent hover:underline">How it&apos;s calculated</Link></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Panel>
        </section>
      ) : null}

      {community.length ? (
        <section aria-labelledby="community-h">
          <SectionTitle id="community-h">Residents, safety and the front desk</SectionTitle>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {community.map((m) => <MetricTile key={m.key} m={m} periodDays={f.period.days} href={drill[m.key]} />)}
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
            {complaintsBy ? <Panel><PanelHeader title="Complaints by category" description={f.period.label} /><BarList rows={complaintsBy.map((r) => ({ key: r.key, label: r.label, value: r.value ?? 0 }))} href={(k) => `${base}/complaints?view=all&category=${k}`} emptyLabel="No complaints in this period" /></Panel> : null}
            {incidentsBy ? <Panel><PanelHeader title="Incidents by type" description={f.period.label} /><BarList rows={incidentsBy.map((r) => ({ key: r.key, label: r.label, value: r.value ?? 0 }))} emptyLabel="No incidents in this period" /></Panel> : null}
          </div>
        </section>
      ) : null}

      {facility.length ? (
        <section aria-labelledby="facility-h">
          <SectionTitle id="facility-h">Equipment, inspections and tasks</SectionTitle>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {facility.map((m) => <MetricTile key={m.key} m={m} periodDays={f.period.days} href={drill[m.key]} />)}
          </div>
        </section>
      ) : null}

      {auto ? (
        <section aria-labelledby="auto-h">
          <SectionTitle id="auto-h" action={<Link href={`${base}/automations`} className="text-[13px] text-accent hover:underline">Automations</Link>}>Automation</SectionTitle>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {[["Active rules", auto.activeRules, null], ["Runs", auto.runs, `${base}/automations?tab=runs`], ["Completed", auto.completed, `${base}/automations?tab=runs&status=completed`],
              ["Waiting for approval", auto.waiting, `${base}/automations?tab=runs&status=waiting_approval`], ["Failed", auto.failed, `${base}/automations?tab=runs&status=failed`]].map(([label, value, href]) => {
              const tile = <div className="h-full rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3"><p className="text-[12px] text-muted">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{value}</p><p className="mt-0.5 text-[11px] text-faint">{label === "Active rules" ? "right now" : f.period.label.toLowerCase()}</p></div>;
              return href ? <Link key={String(label)} href={String(href)} className="block [&>div]:hover:border-border-strong">{tile}</Link> : <div key={String(label)}>{tile}</div>;
            })}
          </div>
        </section>
      ) : null}

      {reports.length ? (
        <section aria-labelledby="reports-h">
          <SectionTitle id="reports-h">Reports</SectionTitle>
          <Panel>
            <ul className="grid gap-x-6 divide-y divide-border sm:grid-cols-2 sm:divide-y-0">
              {reports.map((r) => (
                <li key={r} className="px-4 py-2.5"><Link href={`${base}/analytics/reports/${r}${f.query()}`} className="text-[13px] font-medium text-accent hover:underline">{REPORT_LABEL[r]}</Link></li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}

      {!maint.length && !community.length && !facility.length ? <EmptyState title="Nothing to show">Your role doesn&apos;t include any of the data analytics are built from.</EmptyState> : null}
      </div>
    </>
  );
}
