import "server-only";
import { getEntitlements } from "../../billing/entitlements";
import { z } from "zod";
import { defineTool, err, ok, plural, type ToolDisplay } from "./registry";
import { dateArg, locationArg, placeFilter, where } from "./common";
import { isErr } from "./resolve";
import { canReadMetric, dimsFor, fmtChange, fmtValue, metricBreakdown, metricDef, metricValues, METRIC_KEYS, type DimKey, type MetricKey, type MetricValue } from "../../analytics/metrics";
import { addDays, PERIOD_PRESETS, PRESET_LABEL, periodFromDates, previousPeriod, previousQuarterSpan, resolvePeriod, type Period } from "../../analytics/period";
import { propertyHealth } from "../../analytics/health";
import { buildBrief, canGetBrief } from "../../analytics/brief";
import { HEALTH_GRADE } from "@/lib/analytics-labels";

// Analytics tools (Iteration 9). Every number comes from the metric catalog — the same SQL definitions as the
// Analytics page — and each result carries the definition and the exact periods compared, so the answer can state them.

const metricEnum = z.enum(METRIC_KEYS as [MetricKey, ...MetricKey[]]);
const DIMS = ["property", "building", "category", "priority", "vendor", "type", "severity", "kind", "amenity", "carrier", "assignee", "source"] as const;
const METRIC_LIST = METRIC_KEYS.map((k) => `${k} (${metricDef(k).label}${metricDef(k).snapshot ? ", right now" : ""})`).join("; ");

const line = (m: MetricValue, period: Period, prev: Period | null) => {
  if (m.snapshot) return `${m.label}: ${fmtValue(m.value, m.unit)} right now`;
  const ch = fmtChange(m);
  return `${m.label}: ${fmtValue(m.value, m.unit)} (${period.fromDate} to ${period.toDate})${prev && m.previous !== null ? ` vs ${fmtValue(m.previous, m.unit)} (${prev.fromDate} to ${prev.toDate})${ch && m.change !== null ? `, ${ch.text.replace("▲", "up").replace("▼", "down")}` : ""}` : ""}`;
};

function periodFrom(env: { timeZone: string; now: Date }, a: { period?: string; from?: string; to?: string }): Period | string {
  if (a.from || a.to) {
    const from = a.from ?? a.to!;
    const to = a.to ?? a.from!;
    if (from > to) return "The period start is after its end.";
    return periodFromDates(from, to, env.timeZone);
  }
  return resolvePeriod((a.period as (typeof PERIOD_PRESETS)[number]) ?? "30d", env.timeZone, env.now);
}

export const queryMetrics = defineTool({
  name: "query_metrics",
  title: "Calculating metrics",
  description:
    "Computes operational metrics from recorded data in the user's scope, for a period, compared with the period of the same length just before. " +
    `Metrics: ${METRIC_LIST}. Optionally split the first metric by a dimension (property, building, category, priority, vendor, type, severity, kind, amenity, carrier, assignee, source — ` +
    "only the ones that apply to that metric). Use for any numeric question: counts, averages, rates, spend, 'which property has the most…', 'most common…'. Never estimate numbers yourself.",
  input: z.object({
    metrics: z.array(metricEnum).min(1).max(6),
    period: z.enum(PERIOD_PRESETS).optional().describe(`Preset: ${PERIOD_PRESETS.map((p) => `${p} = ${PRESET_LABEL[p]}`).join(", ")}. Default 30d.`),
    from: dateArg.optional().describe("Custom period start (inclusive). Overrides `period`."),
    to: dateArg.optional().describe("Custom period end (inclusive)."),
    breakdown: z.enum(DIMS).optional().describe("Split the first metric by this dimension."),
    location: locationArg,
  }),
  available: (p) => p.permissions.has("analytics.read"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const period = periodFrom(env, a);
    if (typeof period === "string") return { result: err("INVALID", period) };
    const prev = previousPeriod(period, env.timeZone);
    const allowed = a.metrics.filter((k) => canReadMetric(ctx.principal, k));
    if (!allowed.length) return { result: err("FORBIDDEN", "Your role can't see the data behind those metrics.") };
    const f = { propertyId: pf.propertyId ?? null, buildingId: pf.buildingId ?? null };
    const vals = await metricValues(ctx, allowed, period, prev, f);
    let breakdown: { key: string; label: string; value: number | null; display: string }[] | null = null;
    if (a.breakdown) {
      if (!dimsFor(allowed[0]).includes(a.breakdown as DimKey)) return { result: err("INVALID", `${metricDef(allowed[0]).label} can't be split by ${a.breakdown}. It can be split by: ${dimsFor(allowed[0]).join(", ")}.`) };
      const rows = await metricBreakdown(ctx, allowed[0], a.breakdown as DimKey, metricDef(allowed[0]).snapshot ? null : period, f, 10);
      breakdown = (rows ?? []).map((r) => ({ ...r, display: fmtValue(r.value, metricDef(allowed[0]).unit) }));
    }
    const skipped = a.metrics.filter((k) => !allowed.includes(k));
    const highlights = vals.map((m) => line(m, period, prev));
    if (breakdown) highlights.push(`${metricDef(allowed[0]).label} by ${a.breakdown}: ${breakdown.length ? breakdown.map((b) => `${b.label} ${b.display}`).join(", ") : "nothing recorded"}`);
    const first = vals[0];
    return {
      result: ok(`${first.label}${where(pf.place)}: ${fmtValue(first.value, first.unit)}${first.snapshot ? " right now" : ` from ${period.fromDate} to ${period.toDate}`}.`, {
        facts: {
          period: { label: period.label, from: period.fromDate, to: period.toDate, days: period.days },
          previousPeriod: { from: prev.fromDate, to: prev.toDate },
          place: pf.place?.label ?? "everything you can see",
          metrics: vals.map((m) => ({ key: m.key, label: m.label, value: m.value, display: fmtValue(m.value, m.unit), previous: m.snapshot ? undefined : m.previous, changePct: m.change, definition: m.description, rightNow: m.snapshot })),
          ...(breakdown ? { breakdown: { metric: allowed[0], by: a.breakdown, rows: breakdown.map((b) => ({ label: b.label, value: b.value, display: b.display })) } } : {}),
          ...(skipped.length ? { notVisibleToYou: skipped } : {}),
        },
        highlights,
        note: "Computed from recorded data with the definitions shown, for the periods stated.",
      }),
      display: {
        metrics: vals.map((m) => ({ label: m.label, value: fmtValue(m.value, m.unit), ...(fmtChange(m)?.tone === "danger" ? { tone: "danger" as const } : fmtChange(m)?.tone === "success" ? { tone: "success" as const } : {}) })),
        more: { label: "Open analytics", href: env.href(`/analytics${pf.propertyId ? `?property=${pf.propertyId}` : ""}`) },
      },
    };
  },
});

export const comparePeriods = defineTool({
  name: "compare_periods",
  title: "Comparing periods",
  description:
    "Compares one metric between two periods: this quarter so far vs the same days of last quarter, this month so far vs the same days of last month, " +
    "the last 7 or 30 days vs the 7 or 30 before, or two explicit date ranges. Use for 'how much did X change', 'X this quarter vs last'. Returns both values and the change.",
  input: z.object({
    metric: metricEnum,
    comparison: z.enum(["quarter", "month", "7d", "30d", "custom"]).default("30d"),
    fromA: dateArg.optional().describe("custom: first (current) period start"), toA: dateArg.optional(),
    fromB: dateArg.optional().describe("custom: second (earlier) period start"), toB: dateArg.optional(),
    location: locationArg,
  }),
  available: (p) => p.permissions.has("analytics.read"),
  riskClass: 1,
  async execute(ctx, a, env) {
    if (!canReadMetric(ctx.principal, a.metric)) return { result: err("FORBIDDEN", "Your role can't see the data behind that metric.") };
    const def = metricDef(a.metric);
    if (def.snapshot) return { result: err("INVALID", `${def.label} is a right-now number; it can't be compared across periods.`) };
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const tz = env.timeZone;
    let cur: Period, prev: Period;
    if (a.comparison === "custom") {
      if (!a.fromA || !a.toA || !a.fromB || !a.toB) return { result: err("INVALID", "Give both date ranges for a custom comparison.") };
      if (a.fromA > a.toA || a.fromB > a.toB) return { result: err("INVALID", "A period starts after it ends.") };
      cur = periodFromDates(a.fromA, a.toA, tz); prev = periodFromDates(a.fromB, a.toB, tz);
    } else if (a.comparison === "quarter") {
      cur = resolvePeriod("qtd", tz, env.now); prev = previousQuarterSpan(cur, tz);
    } else if (a.comparison === "month") {
      cur = resolvePeriod("mtd", tz, env.now);
      const [y, m] = cur.fromDate.split("-").map(Number);
      const start = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      prev = periodFromDates(start, addDays(start, cur.days - 1), tz);
    } else {
      cur = resolvePeriod(a.comparison, tz, env.now); prev = previousPeriod(cur, tz);
    }
    const f = { propertyId: pf.propertyId ?? null, buildingId: pf.buildingId ?? null };
    const [[mA], [mB]] = await Promise.all([metricValues(ctx, [a.metric], cur, null, f), metricValues(ctx, [a.metric], prev, null, f)]);
    const change = mA.value !== null && mB.value !== null ? mA.value - mB.value : null;
    const pct = mA.value !== null && mB.value ? Math.round(((mA.value - mB.value) / Math.abs(mB.value)) * 1000) / 10 : null;
    const dir = change === null ? "" : change > 0 ? "up" : change < 0 ? "down" : "unchanged";
    const summary = `${def.label}${where(pf.place)}: ${fmtValue(mA.value, def.unit)} from ${cur.fromDate} to ${cur.toDate}, against ${fmtValue(mB.value, def.unit)} from ${prev.fromDate} to ${prev.toDate}` +
      (change === null ? "." : change === 0 ? " — no change." : ` — ${dir} ${fmtValue(Math.abs(change), def.unit)}${pct !== null ? ` (${Math.abs(pct)}%)` : ""}.`);
    return {
      result: ok(summary, {
        facts: {
          metric: { key: a.metric, label: def.label, definition: def.description },
          current: { from: cur.fromDate, to: cur.toDate, days: cur.days, value: mA.value, display: fmtValue(mA.value, def.unit) },
          earlier: { from: prev.fromDate, to: prev.toDate, days: prev.days, value: mB.value, display: fmtValue(mB.value, def.unit) },
          difference: change === null ? null : { value: Math.round(change * 100) / 100, display: fmtValue(Math.abs(change), def.unit), direction: dir, percent: pct },
          place: pf.place?.label ?? "everything you can see",
        },
        highlights: [`Definition: ${def.description}`],
      }),
      display: { metrics: [{ label: `${def.label} · ${cur.fromDate} – ${cur.toDate}`, value: fmtValue(mA.value, def.unit) }, { label: `${prev.fromDate} – ${prev.toDate}`, value: fmtValue(mB.value, def.unit) }] },
    };
  },
});

export const propertyHealthTool = defineTool({
  name: "property_health",
  title: "Scoring property health",
  description:
    "Each property's health score (0–100) with the factors behind it: SLA met, response on time, overdue share, open backlog per 100 units, complaints per 100 units, " +
    "serious incidents, inspection failures and equipment availability, with each factor's value, score and weight. Use for 'how healthy is…', 'which property needs attention'.",
  input: z.object({ location: locationArg }),
  available: (p) => p.permissions.has("analytics.read") && p.permissions.has("workorder.read"),
  riskClass: 1,
  async execute(ctx, a, env) {
    if (!(await getEntitlements(ctx.principal.orgId)).features.advanced_analytics) return { result: err("FORBIDDEN", "Property health scores aren't included in your organization's plan.") };
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const rows = await propertyHealth(ctx, { propertyId: pf.propertyId ?? null, now: env.now });
    if (!rows.length) return { result: ok("No properties in your scope to score.") };
    const ranked = [...rows].filter((r) => r.score !== null).sort((x, y) => (x.score as number) - (y.score as number));
    const items = rows.map((h) => ({
      property: h.name, score: h.score, status: h.grade ? HEALTH_GRADE[h.grade].label : null, href: env.href(`/analytics/health/${h.propertyId}`),
      factors: h.factors.map((f) => ({ factor: f.label, value: f.valueText, score: f.score, weight: f.weight, ...(f.unavailable ? { note: f.unavailable } : {}) })),
      weakest: h.weakest ? `${h.weakest.label}: ${h.weakest.valueText} (scores ${h.weakest.score})` : null,
    }));
    return {
      result: ok(ranked.length > 1 ? `${plural(rows.length, "property", "properties")} scored; lowest: ${ranked[0].name} at ${ranked[0].score}.` : `${rows[0].name}: ${rows[0].score ?? "not enough data"}.`, {
        count: rows.length, items,
        highlights: items.map((h) => `[${h.property}](${h.href}): ${h.score ?? "—"}${h.status ? ` (${h.status})` : ""}${h.weakest ? ` — weakest: ${h.weakest}` : ""}`),
        note: "Each score is a weighted average of factor scores computed from recorded data; open a property to see every factor and its weight.",
      }),
      display: { records: items.map((h) => ({ ref: "Health", title: h.property, sub: h.weakest ?? undefined, href: h.href, badges: h.score === null ? [] : [{ label: `${h.score}${h.status ? ` · ${h.status}` : ""}`, tone: (h.score >= 80 ? "success" : h.score >= 60 ? "warning" : "danger") as "success" | "warning" | "danger" }] })) },
    };
  },
});

export const dailyBriefTool = defineTool({
  name: "daily_brief",
  title: "Preparing your brief",
  description:
    "The user's daily operations brief from recorded data: new requests in the last 24 hours, open emergencies, overdue and due-soon work, critical incidents, today's vendor visits and inspections, " +
    "packages and bookings, automation steps waiting for their approval, and patterns worth a look (spikes, vendors missing targets, repeat failures). Use for 'morning briefing', 'what do I need to know today'.",
  input: z.object({}),
  available: (p) => p.role.category === "staff" && (p.permissions.has("analytics.read") || p.permissions.has("workorder.manage")),
  riskClass: 1,
  async execute(ctx, _a, env) {
    if (!canGetBrief(ctx)) return { result: err("FORBIDDEN", "The daily brief is for managers.") };
    const b = await buildBrief(ctx, env.now);
    const highlights = [
      ...b.sections.flatMap((s) => (s.items.length ? [`**${s.title}**`, ...s.items.slice(0, 5).map((i) => (i.href ? `[${i.text}](${env.href(i.href)})` : i.text))] : [])),
      ...(b.insights.length ? ["**Worth a look**", ...b.insights.slice(0, 5).map((i) => `[${i.title}](${env.href(i.href)}) — ${i.detail}`)] : []),
    ];
    const display: ToolDisplay = { metrics: b.headline.map((h) => ({ label: h.label, value: String(h.value), ...(h.tone ? { tone: h.tone } : {}) })), more: { label: "Open the daily brief", href: env.href("/brief") } };
    return {
      result: ok(`Your brief for ${b.date}: ${b.summary}`, {
        facts: { date: b.date, headline: Object.fromEntries(b.headline.map((h) => [h.key, h.value])), sections: b.sections.map((s) => ({ title: s.title, items: s.items.map((i) => i.text) })), insights: b.insights.map((i) => ({ title: i.title, detail: i.detail, numbers: i.numbers })) },
        highlights,
      }),
      display,
    };
  },
});
