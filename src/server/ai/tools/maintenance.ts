import "server-only";
import { z } from "zod";
import { canListWorkOrders, getWorkOrder, listWorkOrders, workOrderCountsByProperty, type WoView } from "../../modules/maintenance/service";
import { PRIORITY_ORDER, WO_CATEGORIES } from "../../modules/maintenance/rules";
import { PRIORITY, WO_STATUS } from "@/lib/ops-labels";
import { defineTool, err, ok, plural, type RecordCard } from "./registry";
import { ago, fmtWhen, label, lim, limitArg, locationArg, placeFilter, where } from "./common";
import { isErr, resolveUnit, resolveVendor } from "./resolve";

const VIEW_LABEL: Record<WoView, string> = {
  open: "open", overdue: "overdue", due_soon: "due soon", emergency: "open emergency", unassigned: "unassigned", mine: "open (assigned to you)", completed: "completed", all: "",
};

export const searchWorkOrders = defineTool({
  name: "search_work_orders",
  title: "Looking up work orders",
  description:
    "List maintenance requests / work orders the user can see, newest-priority first. Use view 'overdue' for past their resolution due date, " +
    "'emergency', 'unassigned', 'mine' (assigned to the user), 'completed' or 'all'. Returns total count and up to `limit` records with links.",
  input: z.object({
    view: z.enum(["open", "overdue", "emergency", "unassigned", "mine", "completed", "all"]).optional().describe("Default 'open'."),
    location: locationArg,
    unit: z.string().trim().max(20).optional().describe("Unit number, e.g. '1204'."),
    category: z.enum(WO_CATEGORIES).optional(),
    priority: z.enum(PRIORITY_ORDER).optional(),
    vendor: z.string().trim().max(120).optional().describe("Vendor company name."),
    q: z.string().trim().max(120).optional().describe("Words in the title, or a work order number."),
    limit: limitArg,
  }),
  available: canListWorkOrders,
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    let unitId: string | undefined;
    if (a.unit) {
      const u = await resolveUnit(ctx, a.unit, pf.place);
      if (isErr(u)) return { result: u };
      unitId = u?.id;
    }
    let vendorId: string | undefined;
    if (a.vendor) {
      const v = await resolveVendor(ctx, a.vendor);
      if (isErr(v)) return { result: v };
      vendorId = v.id;
    }
    const view = (a.view ?? "open") as WoView;
    const limit = lim(a.limit);
    const filters = { view, propertyId: pf.propertyId, buildingId: pf.buildingId, unitId, category: a.category, priority: a.priority, vendorId, q: a.q };
    const page = await listWorkOrders(ctx, { ...filters, pageSize: limit });
    const rows = page.rows;
    // the split by property covers every match, not just the rows shown
    const byProperty = !pf.place && page.total > 0 && ctx.principal.role.category === "staff" ? await workOrderCountsByProperty(ctx, filters) : [];
    const noun = [VIEW_LABEL[view], a.category ? label(a.category).toLowerCase() : "", "work order"].filter(Boolean).join(" ");
    let summary = page.total === 0 ? `No ${noun}s${where(pf.place)}.` : `${plural(page.total, noun)}${where(pf.place)}`;
    if (page.total > 0) summary += byProperty.length > 1 ? ` across ${plural(byProperty.length, "property", "properties")}: ${byProperty.map((b) => `${b.property} ${b.n}`).join(", ")}.` : ".";
    const items = rows.map((r) => ({
      ref: `WO-${r.number}`, id: r.id, href: env.href(`/maintenance/${r.id}`), title: r.title, status: r.status, priority: r.priority, emergency: r.isEmergency,
      category: r.category, property: r.propertyName, building: r.buildingName, unit: r.unitNumber, area: r.area, assignee: r.assigneeName, vendor: r.vendorName,
      resolveDue: fmtWhen(r.resolveDueAt, env), overdueBy: r.overdue && r.resolveDueAt ? ago(r.resolveDueAt, env.now) : null, created: fmtWhen(r.createdAt, env),
    }));
    const highlights = items.slice(0, 8).map((i) =>
      `[${i.ref}](${i.href}) ${i.title} — ${[i.property, i.unit ? `Unit ${i.unit}` : i.building, i.emergency ? "emergency" : i.priority, i.overdueBy ? `overdue by ${i.overdueBy}` : WO_STATUS[i.status]?.label.toLowerCase(), i.vendor ?? i.assignee ?? "unassigned"].filter(Boolean).join(" · ")}`);
    const records: RecordCard[] = rows.map((r) => ({
      ref: `WO-${r.number}`, title: r.title, href: env.href(`/maintenance/${r.id}`),
      sub: [r.propertyName, r.buildingName, r.unitNumber ? `Unit ${r.unitNumber}` : r.area].filter(Boolean).join(" · "),
      badges: [
        ...(r.isEmergency ? [{ label: "Emergency", tone: "danger" as const }] : []),
        ...(r.overdue ? [{ label: `Overdue ${ago(r.resolveDueAt!, env.now)}`, tone: "danger" as const }] : []),
        { label: WO_STATUS[r.status]?.label ?? r.status, tone: WO_STATUS[r.status]?.tone ?? "neutral" },
        ...(r.priority !== "normal" ? [{ label: PRIORITY[r.priority]?.label ?? r.priority, tone: PRIORITY[r.priority]?.tone ?? "neutral" }] : []),
      ],
    }));
    const qs = new URLSearchParams({ view, ...(pf.propertyId ? { property: pf.propertyId } : {}), ...(a.category ? { category: a.category } : {}) });
    return {
      result: ok(summary, { count: page.total, items, highlights, ...(byProperty.length > 1 ? { facts: { byProperty } } : {}), ...(page.total > rows.length ? { note: `Showing the ${rows.length} most urgent of ${page.total}.` } : {}) }),
      display: { records, more: page.total > rows.length ? { label: `See all ${page.total} in Maintenance`, href: env.href(`/maintenance?${qs}`) } : undefined },
    };
  },
});

export const getWorkOrderTool = defineTool({
  name: "get_work_order",
  title: "Opening the work order",
  description: "Full details of one work order by its number (e.g. 1042 for WO-1042): status, priority, location, assignee, vendor, due dates and recent updates the user may see.",
  input: z.object({ number: z.number().int().min(1).max(10_000_000).describe("The work order number without the 'WO-' prefix.") }),
  available: canListWorkOrders,
  riskClass: 1,
  async execute(ctx, a, env) {
    const found = await listWorkOrders(ctx, { view: "all", q: String(a.number), pageSize: 1 });
    const row = found.rows[0];
    if (!row || row.number !== a.number) return { result: err("NOT_FOUND", `I couldn't find WO-${a.number} among the work orders you can see.`) };
    const d = await getWorkOrder(ctx, row.id);
    const wo = d.workOrder;
    const staffView = d.access.manage || d.access.staff || d.access.worker;
    const updates = d.timeline.slice(-6).map((t) => ({
      at: fmtWhen(t.e.createdAt, env), by: t.actorName, kind: t.e.kind, ...(t.e.toStatus ? { status: t.e.toStatus } : {}), ...(t.e.body ? { note: t.e.body.slice(0, 300) } : {}),
    }));
    const href = env.href(`/maintenance/${wo.id}`);
    const overdue = !!wo.resolveDueAt && wo.resolveDueAt < env.now && !["completed", "closed", "cancelled"].includes(wo.status);
    const facts = {
      ref: `WO-${wo.number}`, href, title: wo.title, description: wo.description.slice(0, 800), status: wo.status, priority: wo.priority, emergency: wo.isEmergency,
      category: wo.category, property: d.labels?.propertyName, building: d.labels?.buildingName, unit: d.labels?.unitNumber, area: wo.area,
      submittedBy: staffView ? d.submitterName : undefined, assignee: d.assignee?.name ?? null, vendor: d.vendor?.name ?? null, asset: d.asset?.name ?? null,
      created: fmtWhen(wo.createdAt, env), respondDue: fmtWhen(wo.respondDueAt, env), resolveDue: fmtWhen(wo.resolveDueAt, env), overdue,
      scheduled: fmtWhen(wo.scheduledStart, env), completed: fmtWhen(wo.completedAt, env), recentUpdates: updates,
    };
    const status = WO_STATUS[wo.status]?.label ?? wo.status;
    const summary = `WO-${wo.number} "${wo.title}" is ${status.toLowerCase()}${overdue ? " and overdue" : ""} — ${[d.labels?.propertyName, d.labels?.unitNumber ? `Unit ${d.labels.unitNumber}` : d.labels?.buildingName].filter(Boolean).join(", ")}.`;
    const highlights = [
      `Priority: ${wo.isEmergency ? "emergency" : wo.priority} · Category: ${label(wo.category)}`,
      `Assigned to: ${d.vendor?.name ?? d.assignee?.name ?? "nobody yet"}`,
      ...(wo.resolveDueAt ? [`Resolution due: ${fmtWhen(wo.resolveDueAt, env)}`] : []),
      ...(wo.scheduledStart ? [`Scheduled: ${fmtWhen(wo.scheduledStart, env)}`] : []),
      ...(updates.length ? [`Latest update (${updates.at(-1)!.at}): ${updates.at(-1)!.note ?? label(updates.at(-1)!.status ?? updates.at(-1)!.kind)}`] : []),
      `[Open WO-${wo.number}](${href})`,
    ];
    return {
      result: ok(summary, { facts, highlights }),
      display: { records: [{ ref: `WO-${wo.number}`, title: wo.title, href, sub: [d.labels?.propertyName, d.labels?.buildingName, d.labels?.unitNumber ? `Unit ${d.labels.unitNumber}` : wo.area].filter(Boolean).join(" · "),
        badges: [{ label: status, tone: WO_STATUS[wo.status]?.tone ?? "neutral" }, ...(overdue ? [{ label: "Overdue", tone: "danger" as const }] : [])] }] },
    };
  },
});
