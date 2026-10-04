import "server-only";
import { z } from "zod";
import { facilityStats, getAsset, listAssets } from "../../modules/assets/service";
import { ASSET_CATEGORIES } from "../../db/schema";
import { WO_CATEGORIES } from "../../modules/maintenance/rules";
import { ASSET_STATUS } from "@/lib/facility-labels";
import { anyPerm, defineTool, err, ok, plural } from "./registry";
import { fmtDay, fmtWhen, label, locationArg, placeFilter, where } from "./common";
import { isErr } from "./resolve";

const ASSET_CAT_FOR_WO: Record<string, string> = { hvac: "hvac", elevator: "elevator", plumbing: "plumbing", electrical: "electrical", fire_safety: "fire_safety", parking: "doors_access", doors_locks: "doors_access", appliance: "appliance" };

export const assetHistory = defineTool({
  name: "asset_history",
  title: "Reviewing equipment history",
  description:
    "Equipment records. Give `asset` (name or tag, e.g. 'RTU-4', 'Emergency generator') for one asset's recorded history: status, reactive requests in 90 days, " +
    "downtime, cost (finance roles only), preventive maintenance schedules and recent work orders. Or set `recurring: true` to list assets with repeat failures " +
    "(3+ reactive requests in 90 days). Recorded facts only — any recommendation must be labelled as yours.",
  input: z.object({
    asset: z.string().trim().max(120).optional(),
    recurring: z.boolean().optional(),
    category: z.enum([...new Set([...ASSET_CATEGORIES, ...WO_CATEGORIES])] as [string, ...string[]]).optional(),
    location: locationArg,
  }),
  available: anyPerm("asset.read", "asset.manage"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const finance = ctx.principal.permissions.has("finance.read");
    if (!a.asset) {
      const category = a.category ? ASSET_CAT_FOR_WO[a.category] ?? a.category : undefined;
      const stats = await facilityStats(ctx);
      if (!stats) return { result: err("FORBIDDEN", "Equipment records aren't available to your role.") };
      // facilityStats lists the top repeat offenders; filter by place/category through the asset list
      const inScope = (pf.propertyId || category)
        ? new Set((await listAssets(ctx, { propertyId: pf.propertyId, category })).rows.map((r) => r.id))
        : null;
      const repeat = stats.repeat.filter((r) => !inScope || inScope.has(r.id));
      const down = stats.outOfService.filter((o) => !inScope || inScope.has(o.id));
      const items = repeat.map((r) => ({ id: r.id, asset: r.name, property: r.propertyName, reactiveRequests90d: r.count, ...(finance ? { cost90d: r.cost } : {}), href: env.href(`/assets/${r.id}`) }));
      const outOfService = down.map((o) => ({ id: o.id, asset: o.name, property: o.propertyName, criticality: o.criticality, since: fmtWhen(o.since, env), reason: o.reason, href: env.href(`/assets/${o.id}`) }));
      const scope = category ? `${label(category).toLowerCase()} ` : "";
      const repeatLine = items.length
        ? `${plural(items.length, `${scope}asset`)} had 3 or more reactive work orders in the last 90 days${where(pf.place)}.`
        : `No ${scope}equipment had 3 or more reactive work orders in the last 90 days${where(pf.place)}.`;
      const downLine = outOfService.length ? `${plural(outOfService.length, `${scope}asset`)} ${outOfService.length === 1 ? "is" : "are"} out of service now.` : `No ${scope}equipment is out of service now.`;
      return {
        result: ok(a.recurring ? repeatLine : `${downLine} ${repeatLine}`, {
          count: items.length, items,
          highlights: [
            ...(a.recurring ? [] : outOfService.map((o) => `[${o.asset}](${o.href}) at ${o.property} — out of service since ${o.since}${o.reason ? `: ${o.reason}` : ""}`)),
            ...items.map((i) => `[${i.asset}](${i.href}) at ${i.property} — ${i.reactiveRequests90d} reactive requests in 90 days${"cost90d" in i ? `, $${(i.cost90d as number).toLocaleString("en-CA")} recorded cost` : ""}`),
          ],
          facts: { outOfServiceNow: outOfService },
          note: "These are recorded counts. Whether to repair or replace is a judgement for your team.",
        }),
        display: { records: [
          ...(a.recurring ? [] : outOfService.map((o) => ({ ref: "Out of service", title: o.asset, href: o.href, sub: `${o.property} · since ${o.since}`, badges: [{ label: "Down", tone: "danger" as const }] }))),
          ...items.map((i) => ({ ref: "Repeat failures", title: i.asset, href: i.href, sub: i.property, badges: [{ label: `${i.reactiveRequests90d} requests / 90 d`, tone: "warning" as const }] })),
        ] },
      };
    }
    const found = await listAssets(ctx, { q: a.asset, propertyId: pf.propertyId });
    let rows = found.rows;
    const want = a.asset.toLowerCase();
    const exact = rows.filter((r) => r.name.toLowerCase() === want || r.tag?.toLowerCase() === want);
    // "RTU-4" should pick "Rooftop unit RTU-4", not every rooftop unit whose model number starts with 4
    const word = new RegExp(`(^|[^a-z0-9])${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i");
    const whole = rows.filter((r) => word.test(r.name) || (!!r.tag && word.test(r.tag)));
    if (exact.length) rows = exact;
    else if (whole.length) rows = whole;
    if (!rows.length) return { result: err("NOT_FOUND", `I couldn't find equipment matching "${a.asset}"${where(pf.place)}.`) };
    if (rows.length > 1) return { result: err("AMBIGUOUS", `More than one asset matches "${a.asset}".`, rows.slice(0, 8).map((r) => `${r.name}${r.tag ? ` (${r.tag})` : ""} · ${r.propertyName}`)) };
    const d = await getAsset(ctx, rows[0].id);
    const s = d.stats;
    const href = env.href(`/assets/${d.asset.id}`);
    const reactive = d.history.filter((h) => h.sourceType !== "pm_schedule");
    const facts = {
      asset: d.asset.name, tag: d.asset.tag, category: d.asset.category, status: d.asset.status, criticality: d.asset.criticality, property: d.labels.propertyName, building: d.labels.buildingName,
      location: d.asset.location, serviceVendor: d.vendor?.name ?? null, href,
      outOfServiceSince: d.openDowntime ? fmtWhen(d.openDowntime.startedAt, env) : null,
      recorded: {
        reactiveRequests90d: s.reactive90d, downtimeHours90d: Math.round(s.downtime90d * 10) / 10, downtimeHours365d: Math.round(s.downtime365d * 10) / 10, outages365d: s.outages365d,
        pmCompleted365d: s.pmDone365d, ...(finance ? { costLast365d: s.cost365d, reactiveCostLast365d: s.reactiveCost365d } : {}),
      },
      pmSchedules: d.schedules.filter((x) => x.active).map((x) => ({ title: x.title, every: x.every, nextDue: x.nextDueOn })),
      recentWorkOrders: d.history.slice(0, 8).map((h) => ({ ref: `WO-${h.number}`, title: h.title, status: h.status, opened: fmtDay(h.createdAt, env), preventive: h.sourceType === "pm_schedule", href: env.href(`/maintenance/${h.id}`) })),
    };
    const summary = `${d.asset.name}${d.asset.tag ? ` (${d.asset.tag})` : ""} at ${d.labels.propertyName} is ${ASSET_STATUS[d.asset.status]?.label.toLowerCase() ?? d.asset.status}; ` +
      `${plural(s.reactive90d, "reactive work order")} in the last 90 days and ${Math.round(s.downtime90d)} h of recorded downtime.`;
    return {
      result: ok(summary, {
        facts,
        highlights: [
          `Outages in the last year: ${s.outages365d} · downtime ${Math.round(s.downtime365d)} h`,
          ...(finance ? [`Recorded cost in the last year: $${s.cost365d.toLocaleString("en-CA")} ($${s.reactiveCost365d.toLocaleString("en-CA")} reactive)`] : []),
          ...(d.schedules.some((x) => x.active) ? [`Preventive maintenance: ${d.schedules.filter((x) => x.active).map((x) => `${x.title} (${x.every}, next ${x.nextDueOn})`).join("; ")}`] : ["No active preventive maintenance schedule."]),
          ...reactive.slice(0, 4).map((h) => `[WO-${h.number}](${env.href(`/maintenance/${h.id}`)}) ${h.title} — ${fmtDay(h.createdAt, env)}`),
          `[Open ${d.asset.name}](${href})`,
        ],
      }),
      display: {
        records: [{ ref: d.asset.tag ?? "Asset", title: d.asset.name, href, sub: [d.labels.propertyName, d.labels.buildingName, d.asset.location].filter(Boolean).join(" · "),
          badges: [{ label: ASSET_STATUS[d.asset.status]?.label ?? d.asset.status, tone: ASSET_STATUS[d.asset.status]?.tone ?? "neutral" }] }],
        metrics: [{ label: "Reactive WOs (90 d)", value: String(s.reactive90d), tone: s.reactive90d >= 3 ? "warning" : undefined }, { label: "Downtime (90 d)", value: `${Math.round(s.downtime90d)} h` },
          ...(finance ? [{ label: "Cost (12 mo)", value: `$${Math.round(s.cost365d).toLocaleString("en-CA")}` }] : [])],
      },
    };
  },
});
