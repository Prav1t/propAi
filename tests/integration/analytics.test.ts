import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { metricBreakdown, metricSeries, metricValues, type MetricKey } from "@/server/analytics/metrics";
import { periodFromDates, previousPeriod } from "@/server/analytics/period";
import { propertyHealth } from "@/server/analytics/health";
import { availableReports, buildReport, exportReportCsv } from "@/server/analytics/reports";
import { computeInsights } from "@/server/analytics/insights";
import { buildBrief, deliverDailyBriefs } from "@/server/analytics/brief";
import { analyticsSettingsSchema, getAnalyticsSettings, saveAnalyticsSettings } from "@/server/analytics/settings";
import { queryMetrics, comparePeriods } from "@/server/ai/tools/analytics";
import { makeToolEnv } from "@/server/ai/tools/registry";
import { drainOutbox } from "@/server/modules/notifications/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError } from "@/server/authz/authorize";
import type { TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import { ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.60", userAgent: "vitest", requestId: "analytics" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}
const q = async (sql: string, params: unknown[] = []) => (await ownerPool.query(sql, params)).rows;
const TZ = "America/Vancouver";
const MARCH = periodFromDates("2024-03-01", "2024-03-31", TZ); // no seeded data this far back
const FEB = previousPeriod(MARCH, TZ);

let admin: TenantCtx, pm: TenantCtx, concierge: TenantCtx, emma: TenantCtx;
const ids: Record<string, string> = {};

// hand-built fixtures with known answers (numbers 900001+ so they never collide with seeded requests)
const FIXTURES = [
  // [number, property, category, created (UTC), hours to first response, hours to completion, hours to resolution target, cost]
  [900001, "FRT", "plumbing", "2024-03-04T18:00:00Z", 2, 10, 24, "100.00"],
  [900002, "FRT", "plumbing", "2024-03-05T18:00:00Z", 4, 50, 24, "300.50"],
  [900003, "FRT", "hvac", "2024-03-12T18:00:00Z", 6, 20, 48, null],
  [900004, "FRT", "general", "2024-03-20T18:00:00Z", null, null, 24, null], // still open, never answered
  [900005, "PCH", "pest", "2024-03-21T18:00:00Z", 1, 5, 24, "50.00"], // outside the property manager's scope
] as const;

beforeAll(async () => {
  [admin, pm, concierge, emma] = await Promise.all([ctxFor("admin@demo.test"), ctxFor("pm@demo.test"), ctxFor("concierge@demo.test"), ctxFor("resident@demo.test")]);
  for (const r of await q("select code, id, org_id from properties")) { ids[r.code] = r.id; ids.org ??= r.org_id; }
  ids.org = admin.principal.orgId;
  for (const [n, prop, cat, created, resp, done, due, cost] of FIXTURES) {
    const c = new Date(created);
    const h = (x: number | null) => (x === null ? null : new Date(c.getTime() + x * 3_600_000));
    await q(`insert into work_orders (org_id, number, property_id, category, priority, title, status, created_at, first_response_at, completed_at, respond_due_at, resolve_due_at, cost)
      values ($1, $2, $3, $4, 'normal', $5, $6, $7, $8, $9, $10, $11, $12)`,
      [ids.org, n, ids[prop], cat, `Fixture ${n}`, done === null ? "new" : "completed", c, h(resp), h(done), h(3), h(due), cost]);
  }
});
afterAll(async () => {
  await q("delete from work_orders where number >= 900000 and org_id = $1", [ids.org]);
  await ownerPool.end();
  await closeDb();
});

const byKey = (vals: Awaited<ReturnType<typeof metricValues>>) => Object.fromEntries(vals.map((v) => [v.key, v]));

describe("metric definitions against hand-built data", () => {
  it("computes each metric exactly, compared with the period before", async () => {
    const keys: MetricKey[] = ["requests_created", "requests_completed", "sla_compliance", "resolution_hours", "first_response_hours", "response_compliance", "maintenance_spend"];
    const v = byKey(await metricValues(pm, keys, MARCH, FEB));
    expect(v.requests_created).toMatchObject({ value: 4, previous: 0, change: null });
    expect(v.requests_completed.value).toBe(3);
    expect(v.sla_compliance.value).toBe(66.7); // 2 of 3 completed by their target
    expect(v.resolution_hours.value).toBe(26.7); // (10 + 50 + 20) / 3
    expect(v.first_response_hours.value).toBe(4); // (2 + 4 + 6) / 3
    expect(v.response_compliance.value).toBe(25); // only the first met its 3-hour response target; the unanswered one counts as missed
    expect(v.maintenance_spend.value).toBe(400.5);
    expect(v.resolution_hours.previous).toBeNull();
  });
  it("is limited to the reader's properties and permissions", async () => {
    expect(byKey(await metricValues(admin, ["requests_created"], MARCH, null)).requests_created.value).toBe(5);
    expect(byKey(await metricValues(pm, ["requests_created"], MARCH, null, { propertyId: ids.PCH })).requests_created.value).toBe(0); // filter can't widen scope
    const noFinance: TenantCtx = { ...pm, principal: { ...pm.principal, permissions: new Set([...pm.principal.permissions].filter((x) => x !== "finance.read")) } };
    expect((await metricValues(noFinance, ["requests_created", "maintenance_spend"], MARCH, null)).map((m) => m.key)).toEqual(["requests_created"]);
    expect(await metricValues(concierge, ["requests_created"], MARCH, null)).toEqual([]); // no analytics access
  });
  it("time series and breakdowns add up to the same total", async () => {
    const series = await metricSeries(admin, "requests_created", MARCH, {}, "week");
    expect(series!.reduce((s, p) => s + (p.value ?? 0), 0)).toBe(5);
    expect(series![0].bucket).toBe("2024-02-26"); // the Monday of the week holding March 1
    const cats = await metricBreakdown(admin, "requests_created", "category", MARCH);
    expect(cats).toEqual(expect.arrayContaining([{ key: "plumbing", label: "Plumbing", value: 2 }, { key: "hvac", label: "Heating & cooling", value: 1 }, { key: "pest", label: "Pests", value: 1 }]));
    const props = await metricBreakdown(pm, "requests_created", "property", MARCH);
    expect(props).toEqual([{ key: ids.FRT, label: "Fraser Towers", value: 4 }]);
  });
  it("the assistant's tools return the same numbers", async () => {
    const env = makeToolEnv("pacific-properties", TZ);
    const out = await queryMetrics.execute(pm, { metrics: ["requests_created", "sla_compliance"], from: "2024-03-01", to: "2024-03-31", location: "Fraser Towers" }, env);
    expect(out.result.ok).toBe(true);
    const facts = (out.result as unknown as { facts: { metrics: { key: string; value: number }[] } }).facts;
    expect(facts.metrics.map((m) => [m.key, m.value])).toEqual([["requests_created", 4], ["sla_compliance", 66.7]]);
    const cmp = await comparePeriods.execute(admin, { metric: "maintenance_spend", comparison: "custom", fromA: "2024-03-01", toA: "2024-03-31", fromB: "2024-02-01", toB: "2024-02-29" }, env);
    expect(cmp.result.ok && cmp.result.summary).toBe("Maintenance spend: $450.50 from 2024-03-01 to 2024-03-31, against $0 from 2024-02-01 to 2024-02-29 — up $450.50.");
    const bad = await queryMetrics.execute(pm, { metrics: ["requests_created"], breakdown: "severity" }, env);
    expect(bad.result).toMatchObject({ ok: false, code: "INVALID" });
  });
});

describe("reports and exports", () => {
  it("lists the requests behind the numbers, with the SLA outcome", async () => {
    const r = await buildReport(pm, "maintenance", MARCH);
    expect(r.rows.map((x) => [x.number, x.sla])).toEqual([["WO-900001", "Met"], ["WO-900002", "Missed"], ["WO-900003", "Met"], ["WO-900004", "Overdue"]]);
    expect(r.columns.map((c) => c.key)).toContain("cost");
    const sla = await buildReport(admin, "sla", MARCH);
    expect(sla.rows.find((x) => x.property === "Fraser Towers")).toMatchObject({ completed: 3, sla: 66.7 });
  });
  it("exports CSV and audits it; roles without analytics get no reports", async () => {
    const { csv, filename } = await exportReportCsv(pm, "maintenance", MARCH);
    expect(filename).toBe("maintenance-2024-03-01-to-2024-03-31.csv");
    expect(csv.split("\r\n")[0]).toMatch(/^Request,Title,Property,/);
    expect(csv).toContain("WO-900002,Fixture 900002,Fraser Towers");
    const [audit] = await q("select after from audit_logs where action = 'report.exported' and actor_user_id = $1 order by created_at desc limit 1", [pm.principal.userId]);
    expect(audit.after).toMatchObject({ report: "maintenance", from: "2024-03-01", to: "2024-03-31", rows: 4 });
    expect(availableReports(concierge)).toEqual([]);
    expect(availableReports(emma)).toEqual([]);
    await expect(buildReport(concierge, "maintenance", MARCH)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("property health", () => {
  it("scores only the reader's properties, explains every factor, and follows the weights", async () => {
    const h = await propertyHealth(pm);
    expect(h.map((x) => x.name)).toEqual(["Fraser Towers", "Harbour Centre"]);
    const frt = h[0];
    expect(frt.factors).toHaveLength(8);
    expect(frt.factors.every((f) => f.href?.includes(ids.FRT) || f.factor === "incidents")).toBe(true);
    expect(frt.score).toBeGreaterThanOrEqual(0);
    const before = await getAnalyticsSettings(admin);
    const only = analyticsSettingsSchema.parse({ w_sla: "100", w_response: "0", w_overdue: "0", w_backlog: "0", w_complaints: "0", w_incidents: "0", w_inspections: "0", w_availability: "0", slaWarningMinutes: "120", briefTime: "07:00", briefEnabled: "on" });
    await saveAnalyticsSettings(admin, only);
    const [weighted] = await propertyHealth(pm, { propertyId: ids.FRT });
    expect(weighted.score).toBe(weighted.factors.find((f) => f.factor === "sla")!.score);
    await expect(saveAnalyticsSettings(pm, only)).rejects.toBeInstanceOf(ForbiddenError);
    expect(analyticsSettingsSchema.safeParse({ ...Object.fromEntries(Object.keys(only).filter((k) => k.startsWith("w_")).map((k) => [k, "0"])), slaWarningMinutes: "120", briefTime: "07:00" }).success).toBe(false);
    await saveAnalyticsSettings(admin, analyticsSettingsSchema.parse({ ...Object.fromEntries(Object.entries(before.healthWeights).map(([k, v]) => [`w_${k}`, String(v)])), slaWarningMinutes: String(before.slaWarningMinutes), briefTime: before.briefTime, briefEnabled: before.briefEnabled ? "on" : "" }));
  });
});

describe("insights and the daily brief", () => {
  it("flags a category spike in one building, with the numbers behind it", async () => {
    const [bld] = await q("select id from buildings where property_id = $1 limit 1", [ids.HBC]);
    for (let i = 0; i < 4; i++) {
      await q(`insert into work_orders (org_id, number, property_id, building_id, category, title, status, created_at) values ($1, $2, $3, $4, 'pest', 'Mice again', 'new', now() - interval '1 day')`, [ids.org, 900100 + i, ids.HBC, bld.id]);
    }
    const ins = await computeInsights(pm);
    const spike = ins.find((i) => i.key === `spike:${bld.id}:pest`);
    expect(spike).toMatchObject({ title: expect.stringMatching(/^Pests requests up at .*Harbour Centre$/), numbers: { last7Days: expect.any(Number) } });
    expect(spike!.numbers.last7Days).toBeGreaterThanOrEqual(4);
    expect(spike!.href).toContain(`building=${bld.id}`);
    expect(await computeInsights(emma)).toEqual([]);
  });
  it("the brief covers only the reader's properties", async () => {
    const b = await buildBrief(pm);
    const text = JSON.stringify(b.sections);
    expect(text).not.toMatch(/Pacific Heights|Kingsway Residences/);
    expect(b.headline.map((h) => h.key)).toEqual(expect.arrayContaining(["new", "emergency", "overdue", "due_soon", "unassigned"]));
    expect(b.summary).toMatch(/new request/);
  });
  it("delivers each manager's brief once a day after the brief time", async () => {
    const st = await getAnalyticsSettings(admin);
    const form = (time: string) => analyticsSettingsSchema.parse({ ...Object.fromEntries(Object.entries(st.healthWeights).map(([k, v]) => [`w_${k}`, String(v)])), slaWarningMinutes: String(st.slaWarningMinutes), briefTime: time, briefEnabled: "on" });
    await saveAnalyticsSettings(admin, form("00:00"));
    const first = await deliverDailyBriefs();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(await deliverDailyBriefs()).toBe(0);
    await drainOutbox();
    const notes = await q("select n.title, n.href from notifications n where n.kind = 'brief.daily' and n.user_id = $1 order by created_at desc limit 1", [admin.principal.userId]);
    expect(notes[0]).toMatchObject({ title: expect.stringMatching(/^Your daily brief — \d{4}-\d{2}-\d{2}$/), href: "/o/pacific-properties/brief" });
    expect((await q("select count(*)::int n from daily_briefs where user_id = $1", [emma.principal.userId]))[0].n).toBe(0); // residents don't get one
    await saveAnalyticsSettings(admin, form(st.briefTime));
  });
});
