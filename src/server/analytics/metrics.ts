import "server-only";
import { and, inArray, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../db/client";
import type { Principal } from "../authz/authorize";
import type { Permission } from "../authz/permissions";
import { tenantTx, type TenantCtx } from "../modules/context";
import { scopeCondition } from "../modules/scope";
import { amenities, buildings, memberships, properties, users, vendors } from "../db/schema";
import { bucketStarts, pctChange, type Bucket, type Period } from "./period";
import { WO_CATEGORY, PRIORITY, COMPLAINT_CATEGORY, INCIDENT_TYPE, SEVERITY, INSPECTION_KIND } from "@/lib/ops-labels";
import { ASSET_CATEGORY } from "@/lib/facility-labels";

// The metric catalog (Iteration 9). One definition per metric; dashboards, reports, the health score and the assistant's
// analytics tools all compute numbers through it, so a number means the same thing everywhere it appears.
// Every query is limited to the reader's organization (RLS + explicit predicate) and their property scope.

export type Unit = "count" | "hours" | "percent" | "currency" | "days";
export type DimKey = "property" | "building" | "category" | "priority" | "vendor" | "type" | "severity" | "kind" | "amenity" | "carrier" | "assignee" | "source";

type SourceKey = "work_orders" | "complaints" | "incidents" | "inspections" | "downtime" | "bookings" | "packages" | "tasks";
type Source = {
  from: string; // FROM clause with alias (constant SQL)
  org: string; property: string; building?: string;
  perms: Permission[];
  dims: Partial<Record<DimKey, string>>;
  labels?: Partial<Record<DimKey, Record<string, string>>>;
};

const OPEN_WO = "wo.status in ('new','acknowledged','assigned','scheduled','in_progress','awaiting_vendor','awaiting_resident')";
const labelOf = (m: Record<string, { label: string }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.label]));

const SOURCES: Record<SourceKey, Source> = {
  work_orders: {
    from: "work_orders wo", org: "wo.org_id", property: "wo.property_id", building: "wo.building_id", perms: ["workorder.read"],
    dims: { property: "wo.property_id", building: "wo.building_id", category: "wo.category", priority: "wo.priority", vendor: "wo.vendor_id", source: "wo.source" },
    labels: { category: WO_CATEGORY, priority: labelOf(PRIORITY), source: { resident: "Residents", staff: "Staff", inspection: "Inspections", incident: "Incidents", complaint: "Complaints", system: "Automatic" } },
  },
  complaints: {
    from: "complaints c", org: "c.org_id", property: "c.property_id", building: "c.building_id", perms: ["complaint.read"],
    dims: { property: "c.property_id", building: "c.building_id", category: "c.category", priority: "c.priority" },
    labels: { category: COMPLAINT_CATEGORY, priority: labelOf(PRIORITY) },
  },
  incidents: {
    from: "incidents i", org: "i.org_id", property: "i.property_id", building: "i.building_id", perms: ["incident.read"],
    dims: { property: "i.property_id", building: "i.building_id", type: "i.type", severity: "i.severity" },
    labels: { type: INCIDENT_TYPE, severity: labelOf(SEVERITY) },
  },
  inspections: {
    from: "inspections n", org: "n.org_id", property: "n.property_id", building: "n.building_id", perms: ["inspection.read"],
    dims: { property: "n.property_id", building: "n.building_id", kind: "n.kind" },
    labels: { kind: INSPECTION_KIND },
  },
  downtime: {
    from: "asset_downtime d join assets a on a.id = d.asset_id", org: "d.org_id", property: "d.property_id", building: "a.building_id", perms: ["asset.read"],
    dims: { property: "d.property_id", building: "a.building_id", category: "a.category" },
    labels: { category: ASSET_CATEGORY },
  },
  bookings: {
    from: "bookings b", org: "b.org_id", property: "b.property_id", building: "b.building_id", perms: ["booking.manage"],
    dims: { property: "b.property_id", building: "b.building_id", amenity: "b.amenity_id" },
  },
  packages: {
    from: "packages pk", org: "pk.org_id", property: "pk.property_id", building: "pk.building_id", perms: ["package.manage"],
    dims: { property: "pk.property_id", building: "pk.building_id", carrier: "coalesce(nullif(pk.carrier, ''), 'Unknown')" },
  },
  tasks: {
    from: "tasks t", org: "t.org_id", property: "t.property_id", building: "t.building_id", perms: ["task.read"],
    dims: { property: "t.property_id", assignee: "t.assigned_membership_id", priority: "t.priority" },
    labels: { priority: labelOf(PRIORITY) },
  },
};

type Window = (from: Date, to: Date) => SQL;
export type MetricDef = {
  label: string;
  unit: Unit;
  source: SourceKey;
  description: string; // the definition shown next to the number and given to the assistant
  better: "up" | "down" | null; // which direction is good (colours the change); null = neither
  snapshot?: boolean; // a "right now" number; the period doesn't apply
  time?: string; // the timestamp a period filters and a time series buckets by
  where?: string; // fixed extra filter (constant SQL)
  value: string | Window; // aggregate expression
  window?: Window; // custom period filter (overlap metrics)
  extraPerms?: Permission[];
  drill?: string; // records page for the rows behind the number
};

export const METRICS = {
  requests_created: {
    label: "Requests created", unit: "count", source: "work_orders", better: null, time: "wo.created_at", value: "count(*)",
    description: "Maintenance requests created in the period.", drill: "/maintenance?view=all",
  },
  emergencies: {
    label: "Emergency requests", unit: "count", source: "work_orders", better: "down", time: "wo.created_at", where: "wo.is_emergency", value: "count(*)",
    description: "Requests flagged as emergencies when created in the period.", drill: "/maintenance?view=emergency",
  },
  requests_completed: {
    label: "Requests completed", unit: "count", source: "work_orders", better: "up", time: "wo.completed_at", value: "count(*)",
    description: "Requests completed in the period.", drill: "/maintenance?view=completed",
  },
  first_response_hours: {
    label: "Avg. first response", unit: "hours", source: "work_orders", better: "down", time: "wo.created_at", where: "wo.first_response_at is not null",
    value: "avg(extract(epoch from (wo.first_response_at - wo.created_at)) / 3600)",
    description: "Average hours from a request being created to its first staff response (acknowledged, assigned or scheduled), for requests created in the period.",
  },
  resolution_hours: {
    label: "Avg. resolution time", unit: "hours", source: "work_orders", better: "down", time: "wo.completed_at",
    value: "avg(extract(epoch from (wo.completed_at - wo.created_at)) / 3600)",
    description: "Average hours from creation to completion, for requests completed in the period.",
  },
  sla_compliance: {
    label: "Resolved within SLA", unit: "percent", source: "work_orders", better: "up", time: "wo.completed_at", where: "wo.resolve_due_at is not null",
    value: "100.0 * count(*) filter (where wo.completed_at <= wo.resolve_due_at) / nullif(count(*), 0)",
    description: "Share of requests completed in the period that were completed by their resolution target.",
  },
  response_compliance: {
    label: "Responded within SLA", unit: "percent", source: "work_orders", better: "up", time: "wo.created_at",
    where: "wo.respond_due_at is not null and (wo.first_response_at is not null or wo.respond_due_at < now())",
    value: "100.0 * count(*) filter (where wo.first_response_at <= wo.respond_due_at) / nullif(count(*), 0)",
    description: "Share of requests created in the period whose first response came by the response target (requests not yet due are left out).",
  },
  maintenance_spend: {
    label: "Maintenance spend", unit: "currency", source: "work_orders", better: null, time: "wo.completed_at", value: "coalesce(sum(wo.cost), 0)", extraPerms: ["finance.read"],
    description: "Recorded cost of requests completed in the period.",
  },
  open_backlog: {
    label: "Open requests", unit: "count", source: "work_orders", better: "down", snapshot: true, where: OPEN_WO, value: "count(*)",
    description: "Requests open right now (not completed, closed or cancelled).", drill: "/maintenance",
  },
  overdue_now: {
    label: "Overdue now", unit: "count", source: "work_orders", better: "down", snapshot: true, where: `${OPEN_WO} and wo.resolve_due_at < now()`, value: "count(*)",
    description: "Open requests past their resolution target right now.", drill: "/maintenance?view=overdue",
  },
  backlog_age_days: {
    label: "Median age of open requests", unit: "days", source: "work_orders", better: "down", snapshot: true, where: OPEN_WO,
    value: "percentile_cont(0.5) within group (order by extract(epoch from (now() - wo.created_at)) / 86400)",
    description: "Median number of days the currently open requests have been open.",
  },
  complaints_created: {
    label: "Complaints", unit: "count", source: "complaints", better: "down", time: "c.created_at", value: "count(*)",
    description: "Complaints submitted in the period.", drill: "/complaints?view=all",
  },
  complaint_resolution_hours: {
    label: "Avg. complaint resolution", unit: "hours", source: "complaints", better: "down", time: "c.resolved_at", value: "avg(extract(epoch from (c.resolved_at - c.created_at)) / 3600)",
    description: "Average hours from submission to resolution, for complaints resolved in the period.",
  },
  incidents_reported: {
    label: "Incidents", unit: "count", source: "incidents", better: "down", time: "i.occurred_at", value: "count(*)",
    description: "Incidents that occurred in the period.", drill: "/incidents",
  },
  serious_incidents: {
    label: "High/critical incidents", unit: "count", source: "incidents", better: "down", time: "i.occurred_at", where: "i.severity in ('high','critical')", value: "count(*)",
    description: "Incidents of high or critical severity that occurred in the period.", drill: "/incidents",
  },
  inspections_completed: {
    label: "Inspections completed", unit: "count", source: "inspections", better: "up", time: "n.completed_at", where: "n.status = 'completed'", value: "count(*)",
    description: "Inspections completed in the period.", drill: "/inspections?view=completed",
  },
  inspection_failure_rate: {
    label: "Inspection failure rate", unit: "percent", source: "inspections", better: "down", time: "n.completed_at", where: "n.status = 'completed' and n.result is not null",
    value: "100.0 * count(*) filter (where n.result = 'fail') / nullif(count(*), 0)",
    description: "Share of inspections completed in the period that failed.",
  },
  downtime_hours: {
    label: "Equipment downtime", unit: "hours", source: "downtime", better: "down",
    window: (from, to) => sql`d.started_at < ${to} and coalesce(d.ended_at, now()) > ${from}`,
    value: (from, to) => sql`coalesce(sum(extract(epoch from (least(coalesce(d.ended_at, now()), ${to}::timestamptz) - greatest(d.started_at, ${from}::timestamptz))) / 3600), 0)`,
    description: "Hours equipment was out of service during the period (overlapping outages counted per asset).", drill: "/assets",
  },
  amenity_bookings: {
    label: "Amenity bookings", unit: "count", source: "bookings", better: null, time: "b.starts_at", where: "b.status = 'approved'", value: "count(*)",
    description: "Confirmed amenity bookings starting in the period.", drill: "/amenities/bookings",
  },
  amenity_booked_hours: {
    label: "Hours booked", unit: "hours", source: "bookings", better: null, time: "b.starts_at", where: "b.status = 'approved'", value: "coalesce(sum(extract(epoch from (b.ends_at - b.starts_at)) / 3600), 0)",
    description: "Total hours of confirmed bookings starting in the period.",
  },
  packages_received: {
    label: "Packages received", unit: "count", source: "packages", better: null, time: "pk.received_at", value: "count(*)",
    description: "Packages logged at the desk in the period.", drill: "/packages",
  },
  package_pickup_hours: {
    label: "Avg. time to pickup", unit: "hours", source: "packages", better: "down", time: "pk.picked_up_at", value: "avg(extract(epoch from (pk.picked_up_at - pk.received_at)) / 3600)",
    description: "Average hours between a package arriving and being picked up, for pickups in the period.",
  },
  tasks_completed: {
    label: "Tasks completed", unit: "count", source: "tasks", better: "up", time: "t.completed_at", where: "t.status = 'done'", value: "count(*)",
    description: "Tasks marked done in the period.", drill: "/tasks?view=done",
  },
  open_tasks: {
    label: "Open tasks", unit: "count", source: "tasks", better: "down", snapshot: true, where: "t.status in ('open','in_progress','blocked')", value: "count(*)",
    description: "Tasks open right now.", drill: "/tasks",
  },
} as const satisfies Record<string, MetricDef>;

export type MetricKey = keyof typeof METRICS;
export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];
export const metricDef = (k: MetricKey): MetricDef => METRICS[k];

// analytics pages and tools need analytics.read; operational dashboards show a few metrics to anyone who can see the source rows
export function canReadMetric(p: Principal, key: MetricKey, opts: { operational?: boolean } = {}): boolean {
  const d = metricDef(key);
  if (!opts.operational && !p.permissions.has("analytics.read")) return false;
  return [...SOURCES[d.source].perms, ...(d.extraPerms ?? [])].every((x) => p.permissions.has(x));
}

export function dimsFor(key: MetricKey): DimKey[] {
  return Object.keys(SOURCES[metricDef(key).source].dims) as DimKey[];
}

export type Filters = { propertyId?: string | null; buildingId?: string | null };

function whereFor(p: Principal, key: MetricKey, f: Filters, period: Period | null): SQL {
  const d = metricDef(key);
  const s = SOURCES[d.source];
  const raw = (x: string) => sql.raw(x);
  return and(
    sql`${raw(s.org)} = ${p.orgId}`,
    scopeCondition(p, { property: raw(s.property), building: s.building ? raw(s.building) : undefined }),
    f.propertyId ? sql`${raw(s.property)} = ${f.propertyId}` : undefined,
    f.buildingId && s.building ? sql`${raw(s.building)} = ${f.buildingId}` : undefined,
    d.where ? raw(d.where) : undefined,
    !d.snapshot && period && d.time ? sql`${raw(d.time)} >= ${period.from} and ${raw(d.time)} < ${period.to}` : undefined,
    !d.snapshot && period && d.window ? d.window(period.from, period.to) : undefined,
  )!;
}

const valueSql = (d: MetricDef, period: Period | null): SQL =>
  typeof d.value === "string" ? sql.raw(d.value) : d.value(period?.from ?? new Date(0), period?.to ?? new Date());

export function roundFor(unit: Unit, v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (unit === "count") return Math.round(v);
  if (unit === "currency") return Math.round(v * 100) / 100;
  return Math.round(v * 10) / 10;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function valueIn(tx: Tx, p: Principal, key: MetricKey, f: Filters, period: Period | null): Promise<number | null> {
  const d = metricDef(key);
  const r = await tx.execute<{ v: string | number | null }>(sql`select ${valueSql(d, period)} as v from ${sql.raw(SOURCES[d.source].from)} where ${whereFor(p, key, f, period)}`);
  const v = num(r.rows[0]?.v);
  // a count is 0, not "no data"; averages and rates stay null when nothing qualifies
  return roundFor(d.unit, v === null && (d.unit === "count" || d.unit === "currency") ? 0 : v);
}

export type MetricValue = {
  key: MetricKey; label: string; unit: Unit; description: string; better: "up" | "down" | null; snapshot: boolean;
  value: number | null; previous: number | null; change: number | null; // change in % vs the previous period
};

// current and previous-period values for each requested metric the reader may see (others are dropped)
export async function metricValues(ctx: TenantCtx, keys: MetricKey[], period: Period, previous: Period | null, f: Filters = {}, opts: { operational?: boolean } = {}): Promise<MetricValue[]> {
  const p = ctx.principal;
  const allowed = keys.filter((k) => canReadMetric(p, k, opts));
  return tenantTx(ctx, async (tx) => {
    const out: MetricValue[] = [];
    for (const key of allowed) {
      const d = metricDef(key);
      const value = await valueIn(tx, p, key, f, period);
      const prev = previous && !d.snapshot ? await valueIn(tx, p, key, f, previous) : null;
      out.push({ key, label: d.label, unit: d.unit, description: d.description, better: d.better, snapshot: !!d.snapshot, value, previous: prev, change: d.snapshot ? null : pctChange(value, prev) });
    }
    return out;
  });
}

export type SeriesPoint = { bucket: string; value: number | null };

// one value per bucket (day/week/month in the org's zone); empty buckets are 0 for counts and sums, null for averages
export async function metricSeries(ctx: TenantCtx, key: MetricKey, period: Period, f: Filters = {}, bucket: Bucket = period.bucket): Promise<SeriesPoint[] | null> {
  const p = ctx.principal;
  const d = metricDef(key);
  if (!canReadMetric(p, key) || d.snapshot || !d.time) return null;
  const tz = p.orgTimezone ?? "UTC";
  const rows = await tenantTx(ctx, (tx) => tx.execute<{ b: string; v: string | number | null }>(sql`
    select to_char(date_trunc(${bucket}, ${sql.raw(d.time!)} at time zone ${tz}), 'YYYY-MM-DD') as b, ${valueSql(d, period)} as v
    from ${sql.raw(SOURCES[d.source].from)} where ${whereFor(p, key, f, period)} group by 1 order by 1`));
  const byBucket = new Map(rows.rows.map((r) => [r.b, num(r.v)]));
  const zero = d.unit === "count" || d.unit === "currency" ? 0 : null;
  return bucketStarts(period, bucket).map((b) => ({ bucket: b, value: roundFor(d.unit, byBucket.get(b) ?? zero) }));
}

export type BreakdownRow = { key: string; label: string; value: number | null };

async function dimLabels(tx: Tx, dim: DimKey, keys: string[], src: Source): Promise<Record<string, string>> {
  const ids = keys.filter((k) => /^[0-9a-f-]{36}$/.test(k));
  const fixed = src.labels?.[dim];
  if (fixed) return fixed;
  if (!ids.length) return {};
  const pairs = async (rows: { id: string; name: string }[]) => Object.fromEntries(rows.map((r) => [r.id, r.name]));
  switch (dim) {
    case "property": return pairs(await tx.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, ids)));
    case "building": return pairs(await tx.select({ id: buildings.id, name: buildings.name }).from(buildings).where(inArray(buildings.id, ids)));
    case "vendor": return pairs(await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, ids)));
    case "amenity": return pairs(await tx.select({ id: amenities.id, name: amenities.name }).from(amenities).where(inArray(amenities.id, ids)));
    case "assignee": return pairs(await tx.select({ id: memberships.id, name: users.name }).from(memberships).innerJoin(users, sql`${users.id} = ${memberships.userId}`).where(inArray(memberships.id, ids)));
    default: return {};
  }
}

const NONE_LABEL: Partial<Record<DimKey, string>> = { building: "No building", vendor: "No vendor", assignee: "Unassigned", property: "Organization-wide" };

// the metric split by one dimension, largest first
export async function metricBreakdown(ctx: TenantCtx, key: MetricKey, dim: DimKey, period: Period | null, f: Filters = {}, limit = 12): Promise<BreakdownRow[] | null> {
  const p = ctx.principal;
  const d = metricDef(key);
  const src = SOURCES[d.source];
  const col = src.dims[dim];
  if (!canReadMetric(p, key) || !col) return null;
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.execute<{ k: string | null; v: string | number | null }>(sql`
      select ${sql.raw(col)}::text as k, ${valueSql(d, period)} as v from ${sql.raw(src.from)} where ${whereFor(p, key, f, period)}
      group by 1 order by 2 desc nulls last limit ${Math.min(Math.max(limit, 1), 50)}`);
    const labels = await dimLabels(tx, dim, rows.rows.map((r) => r.k ?? "").filter(Boolean), src);
    return rows.rows.map((r) => ({ key: r.k ?? "none", label: r.k ? labels[r.k] ?? r.k.replace(/_/g, " ").replace(/^\w/, (x) => x.toUpperCase()) : NONE_LABEL[dim] ?? "None", value: roundFor(d.unit, num(r.v)) }));
  });
}

/* ───────────── formatting (shared by pages, reports and tools) ───────────── */

export function fmtValue(v: number | null, unit: Unit): string {
  if (v === null) return "—";
  switch (unit) {
    case "count": return v.toLocaleString("en-CA");
    case "currency": return `$${v.toLocaleString("en-CA", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
    case "percent": return `${Math.round(v)}%`;
    case "hours": return v < 1 ? `${Math.round(v * 60)} min` : v < 72 ? `${v.toFixed(1)} h` : `${(v / 24).toFixed(1)} days`;
    case "days": return `${v.toFixed(1)} days`;
  }
}

export function fmtChange(m: Pick<MetricValue, "change" | "better" | "unit" | "value" | "previous">): { text: string; tone: "success" | "danger" | "neutral" } | null {
  if (m.previous === null || m.value === null) return null;
  if (m.change === null) return { text: `was ${fmtValue(m.previous, m.unit)}`, tone: "neutral" };
  if (m.change === 0) return { text: "no change", tone: "neutral" };
  const up = m.change > 0;
  const good = m.better === null ? null : (m.better === "up") === up;
  return { text: `${up ? "▲" : "▼"} ${Math.abs(m.change)}%`, tone: good === null ? "neutral" : good ? "success" : "danger" };
}
