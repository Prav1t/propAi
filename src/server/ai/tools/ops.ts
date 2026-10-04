import "server-only";
import { z } from "zod";
import { canUseIncidents, listIncidents, SEVERITIES } from "../../modules/incidents/service";
import { canUseComplaints, listComplaints } from "../../modules/complaints/service";
import { canUseTasks, listTasks } from "../../modules/tasks/service";
import { listInspections } from "../../modules/inspections/service";
import { getOpsKpis } from "../../modules/ops/kpis";
import { facilityStats } from "../../modules/assets/service";
import { availableSources, CAL_SOURCE_LABEL, CAL_SOURCES, calendarEvents } from "../../modules/calendar/service";
import { COMPLAINT_CATEGORIES, INCIDENT_TYPES } from "../../db/schema";
import { COMPLAINT_STATUS, INCIDENT_STATUS, INSPECTION_STATUS, SEVERITY, TASK_STATUS } from "@/lib/ops-labels";
import { addDaysIso } from "../demo/dates";
import { anyPerm, defineTool, err, ok, plural, type ToolDisplay } from "./registry";
import { dateArg, dayEnd, dayStart, fmtDay, fmtWhen, label, lim, limitArg, locationArg, placeFilter, where } from "./common";
import { isErr } from "./resolve";

export const searchIncidents = defineTool({
  name: "search_incidents",
  title: "Looking up incidents",
  description:
    "Incident reports (security, water damage, injuries…) the user can see — residents only their own reports. " +
    "Use since/until (dates) for a period such as today; otherwise view 'open' or 'recent' (last 7 days).",
  input: z.object({
    view: z.enum(["open", "recent", "all"]).optional().describe("Ignored when since is given. Default 'recent'."),
    since: dateArg.optional().describe("Occurred on or after this date (YYYY-MM-DD)."),
    until: dateArg.optional().describe("Occurred on or before this date (YYYY-MM-DD)."),
    type: z.enum(INCIDENT_TYPES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    location: locationArg,
    limit: limitArg,
  }),
  available: canUseIncidents,
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const ranged = !!(a.since || a.until);
    const page = await listIncidents(ctx, {
      view: ranged ? "all" : a.view ?? "recent", type: a.type, severity: a.severity, propertyId: pf.propertyId, buildingId: pf.buildingId,
      since: a.since ? dayStart(a.since, env) : undefined, until: a.until ? dayEnd(a.until, env) : undefined, pageSize: lim(a.limit, 15),
    });
    const staff = ctx.principal.permissions.has("incident.read");
    const items = page.rows.map((i) => ({
      ref: `Incident #${i.number}`, id: i.id, title: i.title, type: i.type, severity: i.severity, status: i.status, occurred: fmtWhen(i.occurredAt, env),
      property: i.propertyName, location: i.location, reportedBy: staff ? i.reporterName : undefined, href: env.href(`/incidents/${i.id}`),
    }));
    const serious = items.filter((i) => i.severity === "high" || i.severity === "critical").length;
    const period = a.since && (a.until === a.since || (!a.until && a.since === env.today)) ? (a.since === env.today ? " today" : ` on ${fmtDay(a.since, env)}`)
      : a.since ? ` since ${fmtDay(a.since, env)}` : ranged ? "" : a.view === "open" ? "" : " in the last 7 days";
    const noun = a.view === "open" && !ranged ? "open incident" : "incident";
    const summary = page.total
      ? `${plural(page.total, noun)}${period}${where(pf.place)}${serious ? ` — ${serious} high or critical severity` : ""}.`
      : `No ${noun}s${period}${where(pf.place)}.`;
    return {
      result: ok(summary, {
        count: page.total, items,
        highlights: items.slice(0, 8).map((i) => `[#${i.ref.split("#")[1]} ${i.title}](${i.href}) — ${[SEVERITY[i.severity]?.label ?? i.severity, label(i.type), i.property, i.location, i.occurred, INCIDENT_STATUS[i.status]?.label.toLowerCase()].filter(Boolean).join(" · ")}`),
      }),
      display: { records: items.map((i) => ({ ref: i.ref, title: i.title, href: i.href, sub: [i.property, i.location, i.occurred].filter(Boolean).join(" · "),
        badges: [{ label: SEVERITY[i.severity]?.label ?? i.severity, tone: SEVERITY[i.severity]?.tone ?? "neutral" }, { label: INCIDENT_STATUS[i.status]?.label ?? i.status, tone: INCIDENT_STATUS[i.status]?.tone ?? "neutral" }] })) },
    };
  },
});

export const searchComplaints = defineTool({
  name: "search_complaints",
  title: "Looking up complaints",
  description:
    "Resident complaints the user can see (residents: only their own). Filter by topic words (q, matched in subject/description/category), " +
    "category, or since a date. These are reports, not findings — don't treat a complaint as proof that someone did something.",
  input: z.object({
    view: z.enum(["open", "resolved", "all"]).optional().describe("Default 'open'."),
    q: z.string().trim().max(80).optional().describe("Topic words, e.g. 'gym', 'noise'."),
    category: z.enum(COMPLAINT_CATEGORIES).optional(),
    since: dateArg.optional().describe("Submitted on or after this date (YYYY-MM-DD)."),
    location: locationArg,
    limit: limitArg,
  }),
  available: canUseComplaints,
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const view = a.view ?? "open";
    const page = await listComplaints(ctx, { view, q: a.q, category: a.category, propertyId: pf.propertyId, buildingId: pf.buildingId, since: a.since ? dayStart(a.since, env) : undefined, pageSize: lim(a.limit, 15) });
    const staff = ctx.principal.permissions.has("complaint.read");
    const items = page.rows.map((c) => ({
      ref: `Complaint #${c.number}`, id: c.id, subject: c.subject, category: c.category, status: c.status, priority: c.priority, submitted: fmtWhen(c.createdAt, env),
      property: c.propertyName, unit: staff ? c.unitNumber : undefined, assignee: staff ? c.assigneeName : undefined, href: env.href(`/complaints/${c.id}`),
    }));
    const about = a.q ? ` about "${a.q}"` : a.category ? ` about ${label(a.category).toLowerCase()}` : "";
    const viewWord = view === "all" ? "" : `${view} `;
    const since = a.since ? ` since ${fmtDay(a.since, env)}` : "";
    const units = new Set(items.map((i) => i.unit).filter(Boolean));
    const summary = page.total
      ? `${plural(page.total, `${viewWord}complaint`)}${about}${since}${where(pf.place)}${staff && units.size && page.total <= items.length ? `, from ${plural(units.size, "unit")}` : ""}.`
      : `No ${viewWord}complaints${about}${since}${where(pf.place)}.`;
    return {
      result: ok(summary, {
        count: page.total, items,
        highlights: items.slice(0, 8).map((c) => `[#${c.ref.split("#")[1]} ${c.subject}](${c.href}) — ${[c.unit ? `Unit ${c.unit}` : null, c.property, c.submitted, COMPLAINT_STATUS[c.status]?.label.toLowerCase()].filter(Boolean).join(" · ")}`),
      }),
      display: { records: items.map((c) => ({ ref: c.ref, title: c.subject, href: c.href, sub: [c.unit ? `Unit ${c.unit}` : null, c.property, c.submitted].filter(Boolean).join(" · "),
        badges: [{ label: COMPLAINT_STATUS[c.status]?.label ?? c.status, tone: COMPLAINT_STATUS[c.status]?.tone ?? "neutral" }] })) },
    };
  },
});

export const searchTasks = defineTool({
  name: "search_tasks",
  title: "Looking up tasks",
  description: "Operational tasks: open, assigned to the user ('mine'), overdue, or done.",
  input: z.object({ view: z.enum(["open", "mine", "overdue", "done", "all"]).optional().describe("Default 'open'."), location: locationArg, limit: limitArg }),
  available: canUseTasks,
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const view = a.view ?? "open";
    const page = await listTasks(ctx, { view, propertyId: pf.propertyId });
    const items = page.rows.slice(0, lim(a.limit)).map((t) => ({
      id: t.id, title: t.title, status: t.status, priority: t.priority, due: fmtWhen(t.dueAt, env), overdue: t.overdue, property: t.propertyName, assignee: t.assigneeName,
      checklist: t.checklistTotal ? `${t.checklistDone}/${t.checklistTotal}` : null, href: env.href(`/tasks/${t.id}`),
    }));
    const noun = { open: "open task", mine: "open task assigned to you", overdue: "overdue task", done: "completed task", all: "task" }[view];
    return {
      result: ok(page.total ? `${plural(page.total, noun, noun.replace("task", "tasks"))}${where(pf.place)}.` : `No ${noun.replace("task", "tasks")}${where(pf.place)}.`, {
        count: page.total, items,
        highlights: items.slice(0, 8).map((t) => `[${t.title}](${t.href}) — ${[t.property, t.assignee ?? "unassigned", t.due ? `due ${t.due}` : null, t.overdue ? "overdue" : null].filter(Boolean).join(" · ")}`),
      }),
      display: { records: items.map((t) => ({ ref: "Task", title: t.title, href: t.href, sub: [t.property, t.assignee, t.due ? `due ${t.due}` : null].filter(Boolean).join(" · "),
        badges: [{ label: TASK_STATUS[t.status]?.label ?? t.status, tone: TASK_STATUS[t.status]?.tone ?? "neutral" }, ...(t.overdue ? [{ label: "Overdue", tone: "danger" as const }] : [])] })) },
    };
  },
});

export const searchInspections = defineTool({
  name: "search_inspections",
  title: "Looking up inspections",
  description: "Inspections: upcoming, overdue (scheduled date passed, not completed) or completed, with failed-item counts.",
  input: z.object({ view: z.enum(["upcoming", "overdue", "completed", "all"]).optional().describe("Default 'upcoming'."), location: locationArg, limit: limitArg }),
  available: anyPerm("inspection.read", "inspection.manage"),
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const view = a.view ?? "upcoming";
    const page = await listInspections(ctx, { view, propertyId: pf.propertyId });
    const items = page.rows.slice(0, lim(a.limit)).map((i) => ({
      id: i.id, title: i.title, kind: i.kind, status: i.status, result: i.result, scheduledFor: i.scheduledFor, property: i.propertyName, building: i.buildingName, unit: i.unitNumber,
      inspector: i.inspectorName, failedItems: i.failed, totalItems: i.total, href: env.href(`/inspections/${i.id}`),
    }));
    return {
      result: ok(page.total ? `${plural(page.total, `${view === "all" ? "" : `${view} `}inspection`)}${where(pf.place)}.` : `No ${view === "all" ? "" : `${view} `}inspections${where(pf.place)}.`, {
        count: page.total, items,
        highlights: items.slice(0, 8).map((i) => `[${i.title}](${i.href}) — ${[fmtDay(i.scheduledFor, env), i.property, i.unit ? `Unit ${i.unit}` : i.building, i.inspector, i.status === "completed" ? `${i.failedItems}/${i.totalItems} items failed` : null].filter(Boolean).join(" · ")}`),
      }),
      display: { records: items.map((i) => ({ ref: "Inspection", title: i.title, href: i.href, sub: [fmtDay(i.scheduledFor, env), i.property, i.unit ? `Unit ${i.unit}` : i.building].filter(Boolean).join(" · "),
        badges: [{ label: INSPECTION_STATUS[i.status]?.label ?? i.status, tone: INSPECTION_STATUS[i.status]?.tone ?? "neutral" }, ...(i.failedItems ? [{ label: `${i.failedItems} failed`, tone: "danger" as const }] : [])] })) },
    };
  },
});

export const opsKpis = defineTool({
  name: "ops_kpis",
  title: "Calculating operations KPIs",
  description:
    "Live operational numbers for everything in the user's scope: open/overdue/emergency/unassigned work orders, 30-day completion stats " +
    "(average response and resolution hours, SLA compliance), open work by property and vendor, complaints, incidents, inspections, the user's tasks and, " +
    "for facility roles, equipment out of service, preventive maintenance and repeat failures. Use for briefings and 'how are we doing'.",
  input: z.object({}),
  available: (p) => p.role.category === "staff" && ["workorder.read", "incident.read", "complaint.read", "inspection.read", "asset.read"].some((x) => p.permissions.has(x)),
  riskClass: 1,
  async execute(ctx, _a, env) {
    const k = await getOpsKpis(ctx);
    const fac = await facilityStats(ctx);
    const finance = ctx.principal.permissions.has("finance.read");
    const lines: string[] = [];
    const metrics: NonNullable<ToolDisplay["metrics"]> = [];
    if (k.workOrders) {
      const w = k.workOrders;
      lines.push(`Open work orders: ${w.open} (${w.overdue} overdue, ${w.emergency} emergency, ${w.unassigned} unassigned)`);
      lines.push(`Completed in the last 30 days: ${w.completed}${w.avgResponseH !== null ? ` · avg first response ${w.avgResponseH} h` : ""}${w.avgResolveH !== null ? ` · avg resolution ${w.avgResolveH} h` : ""}${w.slaCompliance !== null ? ` · ${w.slaCompliance}% within SLA` : ""}`);
      if (finance) lines.push(`Maintenance cost of work completed in the last 30 days: $${w.spend.toLocaleString("en-CA")}`);
      if (w.byProperty.length > 1) lines.push(`Open work by property: ${w.byProperty.map((p) => `${p.key} ${p.n}${p.overdue ? ` (${p.overdue} overdue)` : ""}`).join(", ")}`);
      metrics.push({ label: "Open work orders", value: String(w.open) }, { label: "Overdue", value: String(w.overdue), tone: w.overdue ? "danger" : "success" },
        { label: "Emergencies", value: String(w.emergency), tone: w.emergency ? "danger" : undefined }, ...(w.slaCompliance !== null ? [{ label: "SLA (30 d)", value: `${w.slaCompliance}%` }] : []));
    }
    if (k.complaints) lines.push(`Open complaints: ${k.complaints.open}`);
    if (k.incidents) {
      lines.push(`Incidents: ${k.incidents.last7} in the last 7 days · ${k.incidents.open} open (${k.incidents.openSerious} high/critical)`);
      metrics.push({ label: "Open incidents", value: String(k.incidents.open), tone: k.incidents.openSerious ? "danger" : undefined });
    }
    if (k.inspections) lines.push(`Inspections: ${k.inspections.upcoming} in the next 14 days · ${k.inspections.overdue} overdue`);
    lines.push(`Your tasks: ${k.myTasks.open} open (${k.myTasks.overdue} overdue)`);
    if (fac) {
      lines.push(`Equipment: ${fac.down} out of service${fac.criticalDown ? ` (${fac.criticalDown} high-criticality)` : ""} · ${fac.attention} need attention · PM due in 14 days: ${fac.pmDueSoon} · PM work overdue: ${fac.pmOverdue}`);
      if (fac.repeat.length) lines.push(`Repeat failures (3+ requests in 90 days): ${fac.repeat.map((r) => `${r.name} at ${r.propertyName} (${r.count})`).join(", ")}`);
      metrics.push({ label: "Assets down", value: String(fac.down), tone: fac.down ? "warning" : undefined });
    }
    const facts = {
      ...k, ...(k.workOrders && !finance ? { workOrders: { ...k.workOrders, spend: undefined } } : {}),
      facility: fac ? { total: fac.total, down: fac.down, needsAttention: fac.attention, criticalDown: fac.criticalDown, pmDueIn14Days: fac.pmDueSoon, pmOverdue: fac.pmOverdue, downtimeHours30d: Math.round(fac.downtimeHours30d), repeatFailures: fac.repeat.map((r) => ({ asset: r.name, property: r.propertyName, requests90d: r.count, href: env.href(`/assets/${r.id}`) })), outOfService: fac.outOfService.map((o) => ({ asset: o.name, property: o.propertyName, since: fmtWhen(o.since, env), reason: o.reason })) } : undefined,
    };
    return {
      result: ok(`Operations snapshot as of ${fmtWhen(env.now, env)} for everything you can see.`, { facts, highlights: lines }),
      display: { metrics, more: { label: "Open the dashboard", href: env.href("/dashboard") } },
    };
  },
});

export const calendarRange = defineTool({
  name: "calendar_range",
  title: "Reading the calendar",
  description: "Everything scheduled between two dates that the user can see: scheduled work, inspections, preventive maintenance, amenity bookings, visitors, shifts and task due dates.",
  input: z.object({
    from: dateArg.describe("First day (YYYY-MM-DD)."),
    to: dateArg.optional().describe("Last day (YYYY-MM-DD), at most 14 days after from. Default: same as from."),
    sources: z.array(z.enum(CAL_SOURCES)).max(7).optional().describe("Limit to some kinds of events."),
    location: locationArg,
  }),
  available: (p) => availableSources(p).length > 0,
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const to = a.to ?? a.from;
    if (to < a.from) return { result: err("INVALID", "The end date is before the start date.") };
    if (to > addDaysIso(a.from, 14)) return { result: err("INVALID", "Ask for at most 14 days at a time.") };
    const events = await calendarEvents(ctx, { from: dayStart(a.from, env), to: dayEnd(to, env), sources: a.sources, propertyId: pf.propertyId });
    const bySource = new Map<string, number>();
    for (const e of events) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
    const items = events.slice(0, 25).map((e) => ({ source: e.source, title: e.title, detail: e.sub, start: e.allDay ? fmtDay(e.start, env) : fmtWhen(e.start, env), allDay: e.allDay, pending: e.pending ?? false, href: e.href.startsWith("/") ? e.href : env.href(e.href) }));
    const span = a.from === to ? (a.from === env.today ? "today" : `on ${fmtDay(a.from, env)}`) : `from ${fmtDay(a.from, env)} to ${fmtDay(to, env)}`;
    const breakdown = [...bySource.entries()].map(([s, n]) => `${n} ${CAL_SOURCE_LABEL[s as keyof typeof CAL_SOURCE_LABEL].toLowerCase()}`).join(", ");
    return {
      result: ok(events.length ? `${plural(events.length, "calendar item")} ${span}${where(pf.place)}: ${breakdown}.` : `Nothing scheduled ${span}${where(pf.place)}.`, {
        count: events.length, items, highlights: items.slice(0, 10).map((e) => `${e.start} — [${e.title}](${e.href})${e.detail ? ` · ${e.detail}` : ""}`),
        ...(events.length > items.length ? { note: `Showing the first ${items.length} of ${events.length}.` } : {}),
      }),
      display: { records: items.slice(0, 12).map((e) => ({ ref: CAL_SOURCE_LABEL[e.source as keyof typeof CAL_SOURCE_LABEL], title: e.title, href: e.href, sub: [e.start, e.detail].filter(Boolean).join(" · ") })),
        more: { label: "Open the calendar", href: env.href(`/calendar?view=agenda&date=${a.from}`) } },
    };
  },
});
