import "server-only";
import { z } from "zod";
import { can } from "../../authz/authorize";
import {
  assignmentOptions, assignWorkOrder, canListWorkOrders, commentOnWorkOrder, createWorkOrder, getWorkOrder, listWorkOrders, transitionWorkOrder,
  triagePreview, woStatusLabel, type CreateWoInput,
} from "../../modules/maintenance/service";
import { isOpen, PRIORITY_ORDER, WO_CATEGORIES } from "../../modules/maintenance/rules";
import { WO_CATEGORY } from "@/lib/ops-labels";
import { defineAction, err, type ToolErr } from "./registry";
import { isToolErr, locationArg, pickByName, placeFilter } from "./common";
import { isErr, myUnits, propertyFor, resolveUnit } from "./resolve";
import type { TenantCtx } from "../../modules/context";

const STATUSES = ["new", "acknowledged", "assigned", "scheduled", "in_progress", "awaiting_vendor", "awaiting_resident", "completed", "closed", "cancelled"] as const;
const opt = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ value, label }));
const PRIORITY_OPTIONS = PRIORITY_ORDER.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));

// a work order by its number, only among those the user can see
async function woByNumber(ctx: TenantCtx, number: number): Promise<{ id: string; number: number } | ToolErr> {
  const found = await listWorkOrders(ctx, { view: "all", q: String(number), pageSize: 1 });
  const row = found.rows[0];
  if (!row || row.number !== number) return err("NOT_FOUND", `I couldn't find WO-${number} among the work orders you can see.`);
  return row;
}

const woLabel = (d: Awaited<ReturnType<typeof getWorkOrder>>) =>
  [d.labels?.unitNumber ? `Unit ${d.labels.unitNumber}` : d.workOrder.area, d.labels?.buildingName, d.labels?.propertyName].filter(Boolean).join(" · ");

export const createWorkOrderAction = defineAction({
  name: "create_work_order",
  title: "Preparing a work order",
  description:
    "Prepare a new maintenance request / work order (and optionally assign it). Nothing is created until the user approves the plan, " +
    "unless the organization lets the assistant do this on its own. Residents can only file for their own unit. Search for similar open work orders first.",
  input: z.object({
    title: z.string().trim().min(3).max(160).describe("Short summary, e.g. 'Elevator stuck on floor 9'."),
    description: z.string().trim().max(5000).optional(),
    category: z.enum(WO_CATEGORIES).optional().describe("Best guess; the triage rules may refine it."),
    priority: z.enum(PRIORITY_ORDER).optional().describe("Staff only."),
    emergency: z.boolean().optional(),
    location: locationArg,
    unit: z.string().trim().max(20).optional().describe("Unit number when the problem is in a unit."),
    area: z.string().trim().max(120).optional().describe("Common area, e.g. 'Lobby' or 'Elevator bank'."),
    assignVendor: z.string().trim().max(120).optional().describe("Staff only: vendor company to assign."),
    assignStaff: z.string().trim().max(120).optional().describe("Staff only: staff member to assign."),
  }),
  available: (p) => p.permissions.has("workorder.create"),
  riskClass: () => 2,
  policyKeys: (a) => (a.assignVendor || a.assignStaff ? ["workorder.create", "workorder.assign"] : ["workorder.create"]),
  editable: [
    { key: "title", label: "Title", type: "text" },
    { key: "description", label: "Description", type: "textarea" },
    { key: "priority", label: "Priority", type: "select", options: PRIORITY_OPTIONS },
    { key: "area", label: "Area", type: "text" },
  ],
  async prepare(ctx, a) {
    const p = ctx.principal;
    const resident = p.role.category === "resident";
    let loc: { propertyId: string; buildingId: string | null; unitId: string | null; label: string };
    if (resident) {
      if (a.assignVendor || a.assignStaff) return err("FORBIDDEN", "Residents can't assign work; management does that.");
      const mine = await myUnits(ctx);
      const pick = a.unit ? mine.filter((u) => u.number.toLowerCase() === a.unit!.toLowerCase()) : mine;
      if (!pick.length) return err(a.unit ? "NOT_FOUND" : "FORBIDDEN", a.unit ? `Unit ${a.unit} isn't one of your units.` : "Your account isn't linked to a unit yet.");
      if (pick.length > 1) return err("AMBIGUOUS", "Which of your units is this for?", pick.map((u) => u.label));
      loc = { propertyId: pick[0].propertyId, buildingId: pick[0].buildingId, unitId: pick[0].id, label: pick[0].label };
    } else {
      const pf = await placeFilter(ctx, a.location);
      if (isErr(pf)) return pf;
      if (a.unit) {
        const u = await resolveUnit(ctx, a.unit, pf.place);
        if (isErr(u)) return u;
        loc = { propertyId: u!.propertyId, buildingId: u!.buildingId, unitId: u!.id, label: u!.label };
      } else {
        const prop = await propertyFor(ctx, pf.place);
        if (isErr(prop)) return prop;
        loc = { propertyId: prop.propertyId!, buildingId: prop.buildingId, unitId: null, label: prop.label };
      }
      if (!can(p, "workorder.create", { orgId: p.orgId, propertyId: loc.propertyId, buildingId: loc.buildingId })) return err("FORBIDDEN", "You can't create work orders there.");
    }
    let assign: { membershipId: string | null; vendorId: string | null; names: string } | null = null;
    if (a.assignVendor || a.assignStaff) {
      if (!can(p, "workorder.manage", { orgId: p.orgId, propertyId: loc.propertyId })) return err("FORBIDDEN", "You can file work here but not assign it.");
      const options = await assignmentOptions(ctx, loc.propertyId);
      const vendor = a.assignVendor ? pickByName(options.vendors, a.assignVendor, (v) => v.name, "approved vendor for this property") : null;
      if (isToolErr(vendor)) return vendor;
      const staff = a.assignStaff ? pickByName(options.staff, a.assignStaff, (s) => s.name, "staff member who works at this property") : null;
      if (isToolErr(staff)) return staff;
      assign = { membershipId: staff?.membershipId ?? null, vendorId: vendor?.id ?? null, names: [staff?.name, vendor?.name].filter(Boolean).join(" and ") };
    }
    const description = a.description ?? "";
    const triage = await triagePreview(ctx, { propertyId: loc.propertyId, title: a.title, description, category: a.category ?? "general" });
    const emergency = !!a.emergency || triage.isEmergency;
    const priority = emergency ? "urgent" : (!resident && a.priority) || triage.priority || "normal";
    const category = triage.category && (a.category ?? "general") === "general" ? triage.category : a.category ?? "general";
    const input: CreateWoInput = {
      title: a.title, description, category: category as CreateWoInput["category"], priority: resident ? null : (a.priority ?? null), isEmergency: !!a.emergency,
      unitId: loc.unitId, buildingId: loc.buildingId, propertyId: loc.propertyId, unitNumber: null, area: a.area ?? null, permissionToEnter: false, entryNotes: null,
    };
    return {
      ok: true,
      step: {
        title: `Create work order “${a.title}”`,
        details: [
          [loc.label, a.area].filter(Boolean).join(" · "),
          `${WO_CATEGORY[category] ?? category} · priority ${priority}${emergency ? " · emergency" : ""}`,
          ...(triage.rules.length ? [`Triage rules that will apply: ${triage.rules.join(", ")}`] : []),
          ...(description ? [description.length > 220 ? `${description.slice(0, 217)}…` : description] : []),
        ],
        effects: [
          "The property's managers are notified",
          ...(assign ? [`Assigned to ${assign.names}, who ${assign.names.includes(" and ") ? "are" : "is"} notified`] : emergency ? ["An emergency with nobody assigned goes to whoever is on call"] : []),
        ],
        resolved: { input, assign },
        propertyId: loc.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const res = await createWorkOrder(ctx, r.input as CreateWoInput);
    let wo = res.workOrder;
    const assign = r.assign as { membershipId: string | null; vendorId: string | null; names: string } | null;
    let warning: string | undefined;
    if (assign) {
      // the request exists either way; a failed assignment is reported, not hidden
      try {
        wo = await assignWorkOrder(ctx, wo.id, { membershipId: assign.membershipId ?? wo.assignedMembershipId, vendorId: assign.vendorId ?? wo.vendorId });
      } catch (e) {
        warning = `WO-${wo.number} was created, but assigning ${assign.names} failed: ${e instanceof Error && e.message ? e.message : "unknown error"}`;
      }
    }
    return {
      summary: `Created WO-${wo.number} “${wo.title}”${assign && !warning ? ` and assigned it to ${assign.names}` : ""}.`,
      record: { ref: `WO-${wo.number}`, title: wo.title, href: env.href(`/maintenance/${wo.id}`) },
      check: { id: wo.id, vendorId: warning ? null : wo.vendorId, membershipId: warning ? null : wo.assignedMembershipId },
      warning,
    };
  },
  async verify(ctx, o) {
    const d = await getWorkOrder(ctx, String(o.check!.id));
    const assignedOk = (!o.check!.vendorId || d.workOrder.vendorId === o.check!.vendorId) && (!o.check!.membershipId || d.workOrder.assignedMembershipId === o.check!.membershipId);
    return { ok: assignedOk, summary: `WO-${d.workOrder.number} is on file at ${woLabel(d)}, status ${woStatusLabel(d.workOrder.status).toLowerCase()}${d.vendor ? `, vendor ${d.vendor.name}` : ""}${d.assignee ? `, assigned to ${d.assignee.name}` : ""}.` };
  },
});

export const assignWorkOrderAction = defineAction({
  name: "assign_work_order",
  title: "Preparing an assignment",
  description: "Prepare assigning an existing work order (by number) to a staff member and/or an approved vendor. Runs after approval unless policy allows.",
  input: z.object({
    number: z.number().int().min(1).describe("Work order number without 'WO-'."),
    vendor: z.string().trim().max(120).optional(),
    staff: z.string().trim().max(120).optional(),
  }),
  available: (p) => p.permissions.has("workorder.manage"),
  riskClass: () => 2,
  policyKeys: () => ["workorder.assign"],
  editable: [],
  async prepare(ctx, a) {
    if (!a.vendor && !a.staff) return err("INVALID", "Say who to assign: a vendor, a staff member, or both.");
    const found = await woByNumber(ctx, a.number);
    if (isToolErr(found)) return found;
    const d = await getWorkOrder(ctx, found.id);
    if (!d.access.manage || !d.assignOptions) return err("FORBIDDEN", `You can't assign WO-${a.number}.`);
    if (!isOpen(d.workOrder.status)) return err("INVALID", `WO-${a.number} is ${woStatusLabel(d.workOrder.status).toLowerCase()}; reopen it before reassigning.`);
    const vendor = a.vendor ? pickByName(d.assignOptions.vendors, a.vendor, (v) => v.name, "approved vendor for this property") : null;
    if (isToolErr(vendor)) return vendor;
    const staff = a.staff ? pickByName(d.assignOptions.staff, a.staff, (s) => s.name, "staff member who works at this property") : null;
    if (isToolErr(staff)) return staff;
    const names = [staff?.name, vendor?.name].filter(Boolean).join(" and ");
    const current = [d.assignee?.name, d.vendor?.name].filter(Boolean).join(" and ") || "nobody";
    return {
      ok: true,
      step: {
        title: `Assign WO-${d.workOrder.number} “${d.workOrder.title}” to ${names}`,
        details: [woLabel(d), `Currently assigned to ${current}`],
        effects: [`${names} ${names.includes(" and ") ? "are" : "is"} notified`],
        resolved: { id: d.workOrder.id, number: d.workOrder.number, membershipId: staff?.membershipId ?? d.workOrder.assignedMembershipId, vendorId: vendor?.id ?? d.workOrder.vendorId, names },
        propertyId: d.workOrder.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const wo = await assignWorkOrder(ctx, String(r.id), { membershipId: (r.membershipId as string | null) ?? null, vendorId: (r.vendorId as string | null) ?? null });
    return { summary: `Assigned WO-${wo.number} to ${r.names}.`, record: { ref: `WO-${wo.number}`, title: wo.title, href: env.href(`/maintenance/${wo.id}`) }, check: { id: wo.id, vendorId: r.vendorId, membershipId: r.membershipId } };
  },
  async verify(ctx, o) {
    const d = await getWorkOrder(ctx, String(o.check!.id));
    const ok = d.workOrder.vendorId === (o.check!.vendorId ?? null) && d.workOrder.assignedMembershipId === (o.check!.membershipId ?? null);
    return { ok, summary: `WO-${d.workOrder.number}: ${[d.assignee?.name, d.vendor?.name].filter(Boolean).join(" and ") || "unassigned"}, status ${woStatusLabel(d.workOrder.status).toLowerCase()}.` };
  },
});

export const updateWorkOrderStatusAction = defineAction({
  name: "update_work_order_status",
  title: "Preparing a status change",
  description: "Prepare moving a work order (by number) to a new status, with an optional note. Completing needs resolution notes. Cancelling is high impact and needs explicit confirmation.",
  input: z.object({
    number: z.number().int().min(1),
    status: z.enum(STATUSES),
    note: z.string().trim().max(2000).optional(),
    resolutionNotes: z.string().trim().max(4000).optional().describe("What was done (required to complete)."),
  }),
  available: canListWorkOrders,
  riskClass: (a) => (a.status === "cancelled" ? 4 : 2),
  policyKeys: () => ["workorder.update"],
  editable: [{ key: "note", label: "Note", type: "textarea" }, { key: "resolutionNotes", label: "Resolution notes", type: "textarea" }],
  async prepare(ctx, a) {
    const found = await woByNumber(ctx, a.number);
    if (isToolErr(found)) return found;
    const d = await getWorkOrder(ctx, found.id);
    if (!d.transitions.includes(a.status)) {
      return err("INVALID", `WO-${a.number} is ${woStatusLabel(d.workOrder.status).toLowerCase()}; ${d.transitions.length ? `it can move to: ${d.transitions.map((t) => woStatusLabel(t).toLowerCase()).join(", ")}` : "you can't change its status"}.`);
    }
    const staff = d.access.manage || d.access.worker;
    if (a.status === "completed" && staff && !a.resolutionNotes && !d.workOrder.resolutionNotes) return err("INVALID", "Completing needs resolution notes describing what was done (resolutionNotes).");
    return {
      ok: true,
      step: {
        title: `${a.status === "cancelled" ? "Cancel" : `Mark ${woStatusLabel(a.status).toLowerCase()}:`} WO-${d.workOrder.number} “${d.workOrder.title}”`,
        details: [woLabel(d), `${woStatusLabel(d.workOrder.status)} → ${woStatusLabel(a.status)}`, ...(a.note ? [`Note: ${a.note}`] : []), ...(a.resolutionNotes ? [`Resolution: ${a.resolutionNotes}`] : [])],
        effects: ["The change shows on the request's timeline for the requester", ...(a.status === "cancelled" ? ["The request stops counting toward SLAs; this is hard to undo"] : [])],
        resolved: { id: d.workOrder.id, to: a.status, note: a.note ?? null, resolutionNotes: a.resolutionNotes ?? null },
        propertyId: d.workOrder.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const wo = await transitionWorkOrder(ctx, String(r.id), { to: r.to as (typeof STATUSES)[number], note: (r.note as string | null) ?? null, cost: null, resolutionNotes: (r.resolutionNotes as string | null) ?? null });
    return { summary: `WO-${wo.number} is now ${woStatusLabel(wo.status).toLowerCase()}.`, record: { ref: `WO-${wo.number}`, title: wo.title, href: env.href(`/maintenance/${wo.id}`) }, check: { id: wo.id, status: r.to } };
  },
  async verify(ctx, o) {
    const d = await getWorkOrder(ctx, String(o.check!.id));
    return { ok: d.workOrder.status === o.check!.status, summary: `WO-${d.workOrder.number} status: ${woStatusLabel(d.workOrder.status).toLowerCase()}.` };
  },
});

const VIS_LABEL: Record<string, string> = { public: "public comment (the requester sees it)", vendor: "note for the vendor", internal: "internal note (staff only)" };

export const commentOnWorkOrderAction = defineAction({
  name: "comment_on_work_order",
  title: "Preparing a note",
  description: "Prepare a comment on a work order. visibility: 'internal' (staff only, default for staff), 'vendor' (assigned vendor sees it) or 'public' (the requester sees it; counts as contacting a resident).",
  input: z.object({
    number: z.number().int().min(1),
    body: z.string().trim().min(1).max(4000),
    visibility: z.enum(["public", "vendor", "internal"]).optional(),
  }),
  available: canListWorkOrders,
  riskClass: (a, p) => (p.role.category === "staff" && a.visibility === "public" ? 3 : 2),
  policyKeys: (a, p) => (p.role.category === "staff" && a.visibility === "public" ? ["workorder.update", "communication.send"] : ["workorder.update"]),
  editable: [{ key: "body", label: "Comment", type: "textarea" }, { key: "visibility", label: "Who sees it", type: "select", options: opt({ internal: "Staff only", vendor: "Vendor and staff", public: "Requester, vendor and staff" }) }],
  async prepare(ctx, a) {
    const found = await woByNumber(ctx, a.number);
    if (isToolErr(found)) return found;
    const d = await getWorkOrder(ctx, found.id);
    const vis = a.visibility ?? (ctx.principal.role.category === "staff" ? "internal" : "public");
    if (!d.commentLevels.includes(vis)) return err("FORBIDDEN", `You can't add a ${vis} comment to WO-${a.number}.`);
    return {
      ok: true,
      step: {
        title: `Add ${vis === "internal" ? "an" : "a"} ${VIS_LABEL[vis].split(" (")[0]} to WO-${d.workOrder.number}`,
        details: [`“${d.workOrder.title}” · ${woLabel(d)}`, `Visible to: ${VIS_LABEL[vis].includes("(") ? VIS_LABEL[vis].split("(")[1].replace(")", "") : "staff"}`],
        effects: vis === "public" ? ["The requester is notified"] : vis === "vendor" ? ["The assigned vendor can read it"] : [],
        resolved: { id: d.workOrder.id, body: a.body, visibility: vis },
        propertyId: d.workOrder.propertyId,
        draft: { body: a.body },
      },
    };
  },
  async execute(ctx, r, env) {
    await commentOnWorkOrder(ctx, String(r.id), { body: String(r.body), visibility: r.visibility as "public" | "vendor" | "internal" });
    const d = await getWorkOrder(ctx, String(r.id));
    return { summary: `Added the note to WO-${d.workOrder.number}.`, record: { ref: `WO-${d.workOrder.number}`, title: d.workOrder.title, href: env.href(`/maintenance/${d.workOrder.id}`) }, check: { id: d.workOrder.id, body: r.body } };
  },
  async verify(ctx, o) {
    const d = await getWorkOrder(ctx, String(o.check!.id));
    const ok = d.timeline.some((t) => t.e.kind === "comment" && t.e.body === o.check!.body);
    return { ok, summary: ok ? "The note is on the timeline." : "The note wasn't found on the timeline." };
  },
});
