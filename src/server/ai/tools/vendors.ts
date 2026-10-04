import "server-only";
import { z } from "zod";
import { listVendors, VENDOR_CATEGORIES } from "../../modules/vendors/service";
import { vendorPerformance } from "../../modules/analytics/vendors";
import { WO_CATEGORIES } from "../../modules/maintenance/rules";
import { VENDOR_STATUS } from "@/lib/labels";
import { addDaysIso } from "../demo/dates";
import { anyPerm, defineTool, err, ok, plural } from "./registry";
import { dateArg, dayEnd, dayStart, dur, fmtDay, label, lim, limitArg, locationArg, placeFilter, where } from "./common";
import { isErr } from "./resolve";

export const searchVendors = defineTool({
  name: "search_vendors",
  title: "Looking up vendors",
  description: "Find vendors (contractors) by name or trade category, optionally only those approved for a property.",
  input: z.object({
    q: z.string().trim().max(120).optional().describe("Part of the company name."),
    category: z.enum(VENDOR_CATEGORIES).optional(),
    location: locationArg,
    limit: limitArg,
  }),
  available: anyPerm("vendor.read"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const page = await listVendors(ctx, { q: a.q, category: a.category, propertyId: pf.propertyId, status: "active" });
    const rows = page.rows.slice(0, lim(a.limit));
    const items = rows.map((v) => ({
      id: v.id, name: v.name, categories: v.categories, phone: v.phone, email: v.email, primaryContact: v.primaryContact,
      insuranceExpires: v.insuranceExpiresOn, properties: v.propertyCount, href: env.href(`/vendors/${v.id}`),
    }));
    const today = env.today;
    return {
      result: ok(page.total ? `${plural(page.total, `active ${a.category ? label(a.category).toLowerCase() + " " : ""}vendor`)}${where(pf.place)}.` : `No active vendors match${where(pf.place)}.`, {
        count: page.total, items,
        highlights: items.slice(0, 8).map((v) => `[${v.name}](${v.href}) — ${v.categories.map(label).join(", ")}${v.phone ? ` · ${v.phone}` : ""}${v.insuranceExpires && v.insuranceExpires < today ? " · insurance expired" : ""}`),
      }),
      display: { records: items.map((v) => ({ ref: "Vendor", title: v.name, href: v.href, sub: v.categories.map(label).join(", "),
        badges: v.insuranceExpires && v.insuranceExpires < today ? [{ label: "Insurance expired", tone: "danger" as const }] : [{ label: VENDOR_STATUS.active.label, tone: VENDOR_STATUS.active.tone }] })) },
    };
  },
});

export const vendorPerformanceTool = defineTool({
  name: "vendor_performance",
  title: "Calculating vendor performance",
  description:
    "Vendor scorecard computed from work orders in the user's scope: jobs completed in the period, average hours from request to completion, " +
    "average first-response hours, % completed by the SLA due time, and open/overdue jobs right now. Sorted slowest (highest average completion time) first. " +
    "Use this for 'slowest/fastest vendor', 'who misses SLA'. Spend appears only for users with finance access.",
  input: z.object({
    from: dateArg.optional().describe("Period start (YYYY-MM-DD, inclusive). Default 30 days ago."),
    to: dateArg.optional().describe("Period end (YYYY-MM-DD, inclusive). Default today."),
    category: z.enum(WO_CATEGORIES).optional(),
    location: locationArg,
  }),
  available: (p) => p.permissions.has("workorder.read") && p.permissions.has("vendor.read"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const fromDate = a.from ?? addDaysIso(env.today, -30);
    const toDate = a.to ?? env.today;
    if (fromDate > toDate) return { result: err("INVALID", "The period start is after its end.") };
    const rows = await vendorPerformance(ctx, { from: dayStart(fromDate, env), to: dayEnd(toDate, env), propertyId: pf.propertyId, buildingId: pf.buildingId, category: a.category });
    const MIN_SAMPLE = 2;
    const ranked = rows.filter((r) => r.completed >= MIN_SAMPLE && r.avgResolveHours !== null);
    const period = `between ${fmtDay(fromDate, env)} and ${fmtDay(toDate, env)}`;
    const items = rows.map((r) => ({ ...r, href: env.href(`/vendors/${r.vendorId}`) }));
    const slowest = ranked[0];
    const fastest = ranked.at(-1);
    const missing = [...rows].filter((r) => r.completedLate + r.overdueNow > 0).sort((x, y) => (y.completedLate + y.overdueNow) - (x.completedLate + x.overdueNow));
    const summary = !rows.length
      ? `No vendor work in ${period}${where(pf.place)}.`
      : slowest
        ? `${plural(rows.length, "vendor")} had work ${period}${where(pf.place)}. Slowest on average: ${slowest.name}, ${dur(slowest.avgResolveHours)} from request to completion over ${plural(slowest.completed, "completed job")}.`
        : `${plural(rows.length, "vendor")} had work ${period}${where(pf.place)}, but none completed ${MIN_SAMPLE}+ jobs, so there is no fair speed ranking.`;
    const highlights = items.slice(0, 8).map((r) =>
      `[${r.name}](${r.href}) — ${plural(r.completed, "job")} completed, avg ${dur(r.avgResolveHours)} to complete, ${r.onTimePct ?? "–"}% on time, ${r.overdueNow} overdue now${r.spend !== null ? `, $${r.spend.toLocaleString("en-CA")} spent` : ""}`);
    return {
      result: ok(summary, {
        count: rows.length, items,
        facts: { period: { from: fromDate, to: toDate }, rankingMinimumCompletedJobs: MIN_SAMPLE, slowest: slowest?.name ?? null, fastest: fastest && fastest !== slowest ? fastest.name : null,
          mostSlaMisses: missing[0] ? { name: missing[0].name, completedLate: missing[0].completedLate, overdueNow: missing[0].overdueNow } : null },
        highlights,
        note: `Vendors with fewer than ${MIN_SAMPLE} completed jobs in the period aren't ranked for speed.`,
      }),
      display: {
        records: items.map((r) => ({ ref: "Vendor", title: r.name, href: r.href, sub: `${plural(r.completed, "job")} completed · ${r.openNow} open`,
          badges: [
            ...(r.avgResolveHours !== null ? [{ label: `${dur(r.avgResolveHours)} avg`, tone: "neutral" as const }] : []),
            ...(r.onTimePct !== null ? [{ label: `${r.onTimePct}% on time`, tone: r.onTimePct >= 90 ? "success" as const : r.onTimePct >= 70 ? "warning" as const : "danger" as const }] : []),
            ...(r.overdueNow ? [{ label: `${r.overdueNow} overdue`, tone: "danger" as const }] : []),
          ] })),
      },
    };
  },
});
