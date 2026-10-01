import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignWorkOrder, commentOnWorkOrder, createWorkOrder, getWorkOrder, listWorkOrders, scheduleWorkOrder, transitionWorkOrder, updateWorkOrderDetails,
} from "@/server/modules/maintenance/service";
import { createRule, getMaintenanceConfig, upsertSla } from "@/server/modules/maintenance/config";
import { assignTask, createTask, getTask, listTasks, setTaskStatus, toggleChecklistItem } from "@/server/modules/tasks/service";
import { completeInspection, createFollowUpWorkOrder, createTemplate, getInspection, recordItem, scheduleInspection } from "@/server/modules/inspections/service";
import { createIncident, getIncident, listIncidents, updateIncident } from "@/server/modules/incidents/service";
import { commentOnComplaint, createComplaint, getComplaint, listComplaints, updateComplaint } from "@/server/modules/complaints/service";
import { checkSlaBreaches, drainOutbox, listNotifications, markRead, savePreferences, unreadCount } from "@/server/modules/notifications/service";
import { openFile, uploadFiles } from "@/server/files/service";
import { getOpsKpis } from "@/server/modules/ops/kpis";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import { ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.9", userAgent: "vitest", requestId: "t" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}

let pm: TenantCtx, admin: TenantCtx, resident: TenantCtx, vendor: TenantCtx, staff: TenantCtx, council: TenantCtx, facility: TenantCtx, concierge: TenantCtx;
const ids: Record<string, string> = {};
let emmaUnit: string;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const file = (bytes: Uint8Array, name: string, type: string) => new File([bytes as BlobPart], name, { type });

beforeAll(async () => {
  [pm, admin, resident, vendor, staff, council, facility, concierge] = await Promise.all(
    ["pm", "admin", "resident", "vendor", "staff", "council", "facility", "concierge"].map((u) => ctxFor(`${u}@demo.test`)),
  );
  const { rows } = await ownerPool.query("select code, id from properties");
  for (const r of rows) ids[r.code] = r.id;
  const b = await ownerPool.query("select b.id, p.code, b.code bcode from buildings b join properties p on p.id = b.property_id");
  for (const r of b.rows) ids[`${r.code}-${r.bcode}`] = r.id;
  const v = await ownerPool.query("select name, id from vendors");
  for (const r of v.rows) ids[r.name] = r.id;
  emmaUnit = [...resident.principal.unitIds][0];
  // make sure earlier events don't leak into the delivery assertions below
  await drainOutbox();
});
afterAll(async () => {
  await closeDb();
  await ownerPool.end();
});

const notifs = async (email: string, entityId: string) =>
  (await ownerPool.query("select kind, title, user_id from notifications where entity_id = $1 and user_id = (select id from users where email = $2)", [entityId, email])).rows;

describe("maintenance: resident → triage → vendor → completion", () => {
  let woId: string;

  it("resident submits a request for their own unit; triage rules set priority, category, vendor and guidance", async () => {
    const r = await createWorkOrder(resident, {
      title: "Water spreading across kitchen floor", description: "Pipe under the sink is leaking badly", category: "general", priority: "low",
      isEmergency: false, unitId: emmaUnit, buildingId: null, unitNumber: null, propertyId: null, area: null, permissionToEnter: true, entryNotes: "Cat inside",
    });
    woId = r.workOrder.id;
    expect(r.workOrder.isEmergency).toBe(true); // "water spreading" rule
    expect(r.workOrder.priority).toBe("urgent"); // emergencies are urgent; residents can't pick priority
    expect(r.workOrder.category).toBe("plumbing"); // "leak" rule sets category only when resident chose "general"… and burst pipe matches
    expect(r.workOrder.vendorId).toBe(ids["Blake Plumbing & Heating"]);
    expect(r.workOrder.status).toBe("assigned");
    expect(r.workOrder.resolveDueAt!.getTime()).toBeGreaterThan(r.workOrder.createdAt.getTime());
    expect(r.instructions.join(" ")).toMatch(/shut off the valve/);
    expect(r.workOrder.residentId).toBe(resident.principal.residentId);
  });

  it("numbers are sequential per organization", async () => {
    const { rows } = await ownerPool.query("select max(number)::int m from work_orders where org_id = $1", [resident.principal.orgId]);
    const r = await createWorkOrder(staff, { title: "Lobby light out", description: "", category: "electrical", priority: null, isEmergency: false, unitId: null, buildingId: ids["HBC-MAIN"] ?? Object.entries(ids).find(([k]) => k.startsWith("HBC-"))![1], unitNumber: null, propertyId: null, area: "Lobby", permissionToEnter: false, entryNotes: null });
    expect(r.workOrder.number).toBe(rows[0].m + 1);
    expect(r.workOrder.vendorId).toBe(ids["Coastline Electric"]); // category rule
  });

  it("residents cannot file for a unit that isn't theirs", async () => {
    const { rows } = await ownerPool.query("select id from units where org_id = $1 and id <> all($2) limit 1", [resident.principal.orgId, [...resident.principal.unitIds]]);
    await expect(createWorkOrder(resident, { title: "Not my unit", description: "", category: "general", priority: null, isEmergency: false, unitId: rows[0].id, buildingId: null, unitNumber: null, propertyId: null, area: null, permissionToEnter: false, entryNotes: null }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the guidance is stored on the public timeline; triage details stay internal", async () => {
    const asResident = await getWorkOrder(resident, woId);
    expect(asResident.timeline.some((t) => t.e.kind === "guidance")).toBe(true);
    expect(asResident.timeline.some((t) => t.e.kind === "rule")).toBe(false);
    const asPm = await getWorkOrder(pm, woId);
    expect(asPm.timeline.some((t) => t.e.kind === "rule")).toBe(true);
  });

  it("delivery: managers and the assigned vendor are notified; the submitter is not notified of their own action", async () => {
    await drainOutbox();
    expect((await notifs("pm@demo.test", woId)).map((n) => n.kind)).toContain("workorder.emergency");
    expect((await notifs("vendor@demo.test", woId)).map((n) => n.kind)).toContain("workorder.assigned");
    expect(await notifs("resident@demo.test", woId)).toHaveLength(0);
    // a manager scoped elsewhere (council at Pacific Heights) isn't told about Fraser Towers
    expect(await notifs("council@demo.test", woId)).toHaveLength(0);
  });

  it("delivery is idempotent", async () => {
    const before = (await ownerPool.query("select count(*)::int n from notifications where entity_id = $1", [woId])).rows[0].n;
    await ownerPool.query("update outbox_events set processed_at = null where payload->>'workOrderId' = $1", [woId]);
    await drainOutbox();
    const after = (await ownerPool.query("select count(*)::int n from notifications where entity_id = $1", [woId])).rows[0].n;
    expect(after).toBe(before);
  });

  it("vendor sees the job and the entry notes; other jobs are invisible to them", async () => {
    const d = await getWorkOrder(vendor, woId);
    expect(d.workOrder.entryNotes).toBe("Cat inside");
    expect(d.access.worker).toBe(true);
    const list = await listWorkOrders(vendor, { view: "all", pageSize: 200 });
    expect(list.rows.length).toBeGreaterThan(0);
    const { rows } = await ownerPool.query("select count(*)::int n from work_orders where id = any($1) and (vendor_id is distinct from $2)", [list.rows.map((r) => r.id), vendor.principal.vendorId]);
    expect(rows[0].n).toBe(0);
    const other = await ownerPool.query("select id from work_orders where org_id = $1 and vendor_id is distinct from $2 limit 1", [vendor.principal.orgId, vendor.principal.vendorId]);
    await expect(getWorkOrder(vendor, other.rows[0].id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("comment visibility: internal notes are hidden from vendor and resident; vendor-level notes are hidden from the resident", async () => {
    await commentOnWorkOrder(pm, woId, { body: "INTERNAL: check insurance", visibility: "internal" });
    await commentOnWorkOrder(pm, woId, { body: "VENDOR: bring a shop vac", visibility: "vendor" });
    await commentOnWorkOrder(pm, woId, { body: "PUBLIC: plumber is on the way", visibility: "public" });
    const bodies = async (c: TenantCtx) => (await getWorkOrder(c, woId)).timeline.map((t) => t.e.body ?? "").join("|");
    const v = await bodies(vendor);
    expect(v).toContain("VENDOR:"); expect(v).toContain("PUBLIC:"); expect(v).not.toContain("INTERNAL:");
    const r = await bodies(resident);
    expect(r).toContain("PUBLIC:"); expect(r).not.toContain("VENDOR:"); expect(r).not.toContain("INTERNAL:");
    await expect(commentOnWorkOrder(resident, woId, { body: "sneaky", visibility: "internal" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(commentOnWorkOrder(vendor, woId, { body: "sneaky", visibility: "internal" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("vendor can schedule and progress the job but not cancel or close it", async () => {
    const s = await scheduleWorkOrder(vendor, woId, { start: "x", durationMinutes: 90, note: null }, new Date(Date.now() + 3 * 3600_000));
    expect(s.status).toBe("scheduled");
    expect(s.scheduledEnd!.getTime() - s.scheduledStart!.getTime()).toBe(90 * 60_000);
    await expect(transitionWorkOrder(vendor, woId, { to: "cancelled", note: null, cost: null, resolutionNotes: null })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await transitionWorkOrder(vendor, woId, { to: "in_progress", note: null, cost: null, resolutionNotes: null })).status).toBe("in_progress");
  });

  it("completion requires resolution notes and records cost", async () => {
    await expect(transitionWorkOrder(vendor, woId, { to: "completed", note: null, cost: null, resolutionNotes: null })).rejects.toBeInstanceOf(ValidationError);
    const done = await transitionWorkOrder(vendor, woId, { to: "completed", note: "All dry", cost: "220.50", resolutionNotes: "Replaced supply line" });
    expect(done.status).toBe("completed");
    expect(done.completedAt).toBeTruthy();
    expect(done.cost).toBe("220.50");
    await expect(transitionWorkOrder(vendor, woId, { to: "closed", note: null, cost: null, resolutionNotes: null })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await transitionWorkOrder(pm, woId, { to: "closed", note: null, cost: null, resolutionNotes: null })).status).toBe("closed");
  });

  it("the resident is told about status changes, and can read them in their inbox", async () => {
    await drainOutbox();
    const mine = await notifs("resident@demo.test", woId);
    expect(mine.some((n) => n.kind === "workorder.updated" && /completed/i.test(n.title))).toBe(true);
    // internal/vendor comments never produced a resident notification
    expect(mine.every((n) => n.kind !== "workorder.comment" || /PUBLIC|message|comment/i.test(n.title))).toBe(true);
    const n = await unreadCount(resident);
    expect(n).toBeGreaterThan(0);
    const list = await listNotifications(resident, { unreadOnly: true });
    await markRead(resident, list[0].id);
    expect(await unreadCount(resident)).toBe(n - 1);
    await markRead(resident, "all");
    expect(await unreadCount(resident)).toBe(0);
  });

  it("residents can only withdraw before work starts", async () => {
    const r = await createWorkOrder(resident, { title: "Closet door off track", description: "", category: "doors_locks", priority: null, isEmergency: false, unitId: emmaUnit, buildingId: null, unitNumber: null, propertyId: null, area: null, permissionToEnter: false, entryNotes: null });
    expect((await getWorkOrder(resident, r.workOrder.id)).transitions).toEqual(["cancelled"]);
    expect((await transitionWorkOrder(resident, r.workOrder.id, { to: "cancelled", note: "Fixed it myself", cost: null, resolutionNotes: null })).status).toBe("cancelled");
    await expect(transitionWorkOrder(resident, woId, { to: "in_progress", note: null, cost: null, resolutionNotes: null })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("maintenance: assignment and scope", () => {
  it("assignment is validated against the property", async () => {
    const pch = await ownerPool.query("select id from work_orders where property_id = $1 and status = 'new' limit 1", [ids.PCH]);
    const hbc = (await createWorkOrder(pm, { title: "Fob reader dead", description: "", category: "doors_locks", priority: "normal", isEmergency: false, unitId: null, buildingId: Object.entries(ids).find(([k]) => k.startsWith("HBC-"))![1], unitNumber: null, propertyId: null, area: "Lobby", permissionToEnter: false, entryNotes: null })).workOrder;
    // Pacific Pest isn't approved for Harbour Centre
    await expect(assignWorkOrder(pm, hbc.id, { membershipId: null, vendorId: ids["Pacific Pest Control"] })).rejects.toBeInstanceOf(ValidationError);
    // the council member (Pacific Heights only) can't be given Harbour Centre work
    await expect(assignWorkOrder(pm, hbc.id, { membershipId: council.principal.membershipId, vendorId: null })).rejects.toBeInstanceOf(ValidationError);
    const ok = await assignWorkOrder(pm, hbc.id, { membershipId: staff.principal.membershipId, vendorId: null });
    expect(ok.status).toBe("assigned");
    expect(ok.firstResponseAt).toBeTruthy();
    // PM doesn't manage Pacific Heights at all
    if (pch.rows[0]) await expect(getWorkOrder(pm, pch.rows[0].id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("list scope: a scoped manager only lists their properties; workers list only their assignments", async () => {
    const list = await listWorkOrders(pm, { view: "all", pageSize: 200 });
    expect(new Set(list.rows.map((r) => r.propertyName))).toEqual(new Set(["Harbour Centre", "Fraser Towers"]));
    const mine = await listWorkOrders(staff, { view: "all", pageSize: 200 });
    const { rows } = await ownerPool.query("select count(*)::int n from work_orders where id = any($1) and assigned_membership_id is distinct from $2 and submitted_by_user_id is distinct from $3",
      [mine.rows.map((r) => r.id), staff.principal.membershipId, staff.principal.userId]);
    expect(rows[0].n).toBe(0);
  });

  it("changing priority recomputes SLA targets from submission time", async () => {
    const w = (await createWorkOrder(pm, { title: "Hallway carpet stain", description: "", category: "cleaning", priority: "low", isEmergency: false, unitId: null, buildingId: Object.entries(ids).find(([k]) => k.startsWith("FRT-"))![1], unitNumber: null, propertyId: null, area: "L3 hallway", permissionToEnter: false, entryNotes: null })).workOrder;
    const u = await updateWorkOrderDetails(pm, w.id, { title: w.title, description: "", category: "cleaning", priority: "high", isEmergency: false });
    expect(u.resolveDueAt!.getTime()).toBeLessThan(w.resolveDueAt!.getTime());
    await expect(updateWorkOrderDetails(staff, w.id, { title: "x", description: "", category: "cleaning", priority: "urgent", isEmergency: false })).rejects.toThrow();
  });

  it("SLA monitor flags breaches once and queues a notification", async () => {
    const w = (await createWorkOrder(pm, { title: "Stairwell door squeaks", description: "", category: "doors_locks", priority: "low", isEmergency: false, unitId: null, buildingId: Object.entries(ids).find(([k]) => k.startsWith("FRT-"))![1], unitNumber: null, propertyId: null, area: "Stair 2", permissionToEnter: false, entryNotes: null })).workOrder;
    await ownerPool.query("update work_orders set resolve_due_at = now() - interval '1 hour', sla_breached_at = null where id = $1", [w.id]);
    expect(await checkSlaBreaches()).toBeGreaterThanOrEqual(1);
    const flagged = await ownerPool.query("select sla_breached_at from work_orders where id = $1", [w.id]);
    expect(flagged.rows[0].sla_breached_at).toBeTruthy();
    await checkSlaBreaches();
    const events = await ownerPool.query("select count(*)::int n from outbox_events where type = 'workorder.sla_breached' and payload->>'workOrderId' = $1", [w.id]);
    expect(events.rows[0].n).toBe(1);
    await drainOutbox();
    expect((await notifs("pm@demo.test", w.id)).some((n) => n.kind === "workorder.sla_breached")).toBe(true);
  });

  it("KPIs come from live rows in scope", async () => {
    const k = await getOpsKpis(pm);
    const { rows } = await ownerPool.query("select count(*)::int n from work_orders where property_id = any($1) and status in ('new','acknowledged','assigned','scheduled','in_progress','awaiting_vendor','awaiting_resident')", [[ids.HBC, ids.FRT]]);
    expect(k.workOrders!.open).toBe(rows[0].n);
    expect((await getOpsKpis(resident)).workOrders).toBeUndefined();
  });
});

describe("maintenance configuration", () => {
  it("org defaults need an org-wide role; property overrides need the property", async () => {
    await expect(upsertSla(pm, { propertyId: null, priority: "low", respondHours: 48, resolveHours: 200 })).rejects.toBeInstanceOf(ForbiddenError);
    await upsertSla(pm, { propertyId: ids.HBC, priority: "low", respondHours: 48, resolveHours: 200 });
    await expect(upsertSla(pm, { propertyId: ids.PCH, priority: "low", respondHours: 48, resolveHours: 200 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getMaintenanceConfig(resident)).rejects.toBeInstanceOf(ForbiddenError);
    const cfg = await getMaintenanceConfig(pm);
    expect(cfg.sla.some((x) => x.propertyName === "Pacific Heights")).toBe(false);
  });

  it("a new property rule changes triage for the next request there", async () => {
    await createRule(pm, { name: "Graffiti", propertyId: ids.FRT, keywords: ["graffiti"], category: null, setPriority: "urgent", setEmergency: false, setCategory: "exterior", assignVendorId: null, residentInstructions: "Please photograph it.", position: 1 });
    const r = await createWorkOrder(resident, { title: "Graffiti on my balcony wall", description: "", category: "general", priority: null, isEmergency: false, unitId: emmaUnit, buildingId: null, unitNumber: null, propertyId: null, area: null, permissionToEnter: false, entryNotes: null });
    expect(r.workOrder.priority).toBe("urgent");
    expect(r.workOrder.category).toBe("exterior");
    expect(r.instructions).toContain("Please photograph it.");
  });
});

describe("attachments", () => {
  let woId: string;
  beforeAll(async () => {
    woId = (await createWorkOrder(resident, { title: "Cracked window", description: "", category: "exterior", priority: null, isEmergency: false, unitId: emmaUnit, buildingId: null, unitNumber: null, propertyId: null, area: null, permissionToEnter: false, entryNotes: null })).workOrder.id;
  });

  it("accepts real images regardless of the claimed type and rejects disguised files", async () => {
    const rows = await uploadFiles(resident, "work_order", woId, [file(PNG, "crack.png", "image/png")], "public");
    expect(rows[0].contentType).toBe("image/png");
    await expect(uploadFiles(resident, "work_order", woId, [file(new TextEncoder().encode("<script>alert(1)</script>"), "evil.png", "image/png")], "public")).rejects.toBeInstanceOf(ValidationError);
    await expect(uploadFiles(resident, "work_order", woId, [file(PNG, "x.png", "image/png")], "internal")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("downloads are permission-checked and audited; internal files are hidden from residents", async () => {
    const [internal] = await uploadFiles(pm, "work_order", woId, [file(PNG, "insurance.png", "image/png")], "internal");
    const pub = (await getWorkOrder(resident, woId)).attachments;
    expect(pub.map((f) => f.filename)).toEqual(["crack.png"]);
    await expect(openFile(resident, internal.id)).rejects.toBeInstanceOf(NotFoundError);
    const ok = await openFile(pm, internal.id);
    expect(ok.kind).toBe("bytes");
    const audit = await ownerPool.query("select count(*)::int n from audit_logs where action = 'file.downloaded' and entity_id = $1", [internal.id]);
    expect(audit.rows[0].n).toBe(1);
    // the vendor isn't on this job, so even the public file is invisible
    await expect(openFile(vendor, pub[0].id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("other organizations can't reach the file", async () => {
    const ns = await ctxFor("admin@demo.test", "northshore-strata");
    const { rows } = await ownerPool.query("select id from files where entity_id = $1 limit 1", [woId]);
    await expect(openFile(ns, rows[0].id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("tasks", () => {
  it("dependencies block progress until done; completing unblocks dependants", async () => {
    const a = await createTask(pm, { title: "Get quotes", description: null, propertyId: ids.HBC, priority: "normal", dueAt: null, assignedMembershipId: staff.principal.membershipId, recurrence: "none", checklist: ["Quote 1", "Quote 2"], blockedByTaskId: null }, null);
    const b = await createTask(pm, { title: "Book contractor", description: null, propertyId: ids.HBC, priority: "normal", dueAt: null, assignedMembershipId: staff.principal.membershipId, recurrence: "none", checklist: [], blockedByTaskId: a.id }, null);
    expect(b.status).toBe("blocked");
    await expect(setTaskStatus(staff, b.id, "done")).rejects.toBeInstanceOf(ValidationError);
    const d = await getTask(staff, a.id);
    await toggleChecklistItem(staff, d.checklist[0].id, true);
    await setTaskStatus(staff, a.id, "done");
    expect((await getTask(pm, b.id)).task.status).toBe("open");
    await expect(setTaskStatus(staff, b.id, "cancelled")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("recurring tasks spawn their next occurrence with the checklist", async () => {
    const due = new Date(Date.now() + 86_400_000);
    const t = await createTask(pm, { title: "Weekly roof drain check", description: null, propertyId: ids.FRT, priority: "normal", dueAt: null, assignedMembershipId: null, recurrence: "weekly", checklist: ["North drain", "South drain"], blockedByTaskId: null }, due);
    await setTaskStatus(pm, t.id, "done");
    const { rows } = await ownerPool.query("select id, due_at from tasks where source_id = $1", [t.id]);
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0].due_at).getTime() - due.getTime()).toBe(7 * 86_400_000);
    const items = await ownerPool.query("select count(*)::int n from task_checklist_items where task_id = $1", [rows[0].id]);
    expect(items.rows[0].n).toBe(2);
  });

  it("assignees must cover the property; outsiders can't see tasks", async () => {
    const t = await createTask(pm, { title: "Order salt", description: null, propertyId: ids.FRT, priority: "low", dueAt: null, assignedMembershipId: null, recurrence: "none", checklist: [], blockedByTaskId: null }, null);
    await expect(assignTask(pm, t.id, council.principal.membershipId)).rejects.toBeInstanceOf(ValidationError);
    await expect(getTask(council, t.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createTask(pm, { title: "x", description: null, propertyId: ids.PCH, priority: "low", dueAt: null, assignedMembershipId: null, recurrence: "none", checklist: [], blockedByTaskId: null }, null)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listTasks(council, { view: "all" })).rows.some((r) => r.id === t.id)).toBe(false);
  });
});

describe("inspections", () => {
  let inspId: string;
  it("schedules from a template and requires every item before completion", async () => {
    const tpl = await createTemplate(facility, { name: `Boiler room ${Date.now()}`, kind: "equipment", items: [{ section: "Boiler", label: "Pressure in range" }, { section: "Boiler", label: "No leaks" }], repeatEveryDays: 30 });
    const insp = await scheduleInspection(facility, { templateId: tpl.id, buildingId: Object.entries(ids).find(([k]) => k.startsWith("FRT-"))![1], unitNumber: null, scheduledFor: "2026-10-05", inspectorMembershipId: null, title: null });
    inspId = insp.id;
    const d = await getInspection(facility, inspId);
    expect(d.items).toHaveLength(2);
    await recordItem(facility, d.items[0].id, { result: "pass", severity: null, notes: null });
    await expect(completeInspection(facility, inspId, { summary: null, signedByName: "Facility" })).rejects.toBeInstanceOf(ValidationError);
    await expect(recordItem(facility, d.items[1].id, { result: "fail", severity: null, notes: "Drip at valve" })).rejects.toBeInstanceOf(ValidationError);
    await recordItem(facility, d.items[1].id, { result: "fail", severity: "high", notes: "Drip at valve" });
    const done = await completeInspection(facility, inspId, { summary: "One leak", signedByName: "Facility Manager" });
    expect(done.result).toBe("fail");
    // repeat interval schedules the next one
    const next = await ownerPool.query("select scheduled_for::text d from inspections where template_id = $1 and status = 'scheduled'", [tpl.id]);
    expect(next.rows.map((r) => r.d)).toContain("2026-11-04");
  });

  it("failed items become linked work orders, once", async () => {
    const d = await getInspection(facility, inspId);
    const failed = d.items.find((i) => i.result === "fail")!;
    const wo = await createFollowUpWorkOrder(facility, failed.id, "plumbing");
    expect(wo.priority).toBe("high");
    expect(wo.sourceType).toBe("inspection");
    await expect(createFollowUpWorkOrder(facility, failed.id, "plumbing")).rejects.toBeInstanceOf(ValidationError);
    await expect(createFollowUpWorkOrder(facility, d.items.find((i) => i.result === "pass")!.id, "plumbing")).rejects.toBeInstanceOf(ValidationError);
    await drainOutbox();
    expect((await ownerPool.query("select count(*)::int n from notifications where entity_id = $1 and kind = 'inspection.failed'", [inspId])).rows[0].n).toBeGreaterThan(0);
  });

  it("closed inspections are read-only and residents can't see them", async () => {
    const d = await getInspection(facility, inspId);
    await expect(recordItem(facility, d.items[0].id, { result: "na", severity: null, notes: null })).rejects.toBeInstanceOf(ValidationError);
    await expect(getInspection(resident, inspId)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("incidents", () => {
  it("residents report in their own building and see only the public record", async () => {
    const bld = [...resident.principal.occupantBuildingIds][0];
    const i = await createIncident(resident, { type: "security", severity: "medium", title: "Stranger trying doors", description: "Around 2am", buildingId: bld, unitNumber: null, unitId: null, location: "L12 hallway", occurredAt: "x", peopleInvolved: "Tall man, red jacket", externalReference: null }, new Date(Date.now() - 3600_000));
    await updateIncident(concierge, i.id, { status: null, severity: null, note: "INTERNAL: reviewed camera 4", visibility: "internal", resolution: null });
    const asRes = await getIncident(resident, i.id);
    expect(asRes.incident.peopleInvolved).toBeNull();
    expect(asRes.timeline.map((t) => t.e.body ?? "").join()).not.toContain("INTERNAL");
    await expect(updateIncident(resident, i.id, { status: "closed", severity: null, note: null, visibility: "public", resolution: null })).rejects.toBeInstanceOf(ForbiddenError);
    const otherBld = (await ownerPool.query("select id from buildings where org_id = $1 and id <> all($2) limit 1", [resident.principal.orgId, [...resident.principal.occupantBuildingIds]])).rows[0].id;
    await expect(createIncident(resident, { type: "other", severity: "low", title: "Elsewhere", description: "", buildingId: otherBld, unitNumber: null, unitId: null, location: null, occurredAt: "x", peopleInvolved: null, externalReference: null }, new Date())).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listIncidents(resident, { view: "all" })).rows.every((r) => r.reporterName === "Emma Tremblay")).toBe(true);
  });

  it("future times are rejected; resolving needs a resolution; escalation notifies managers", async () => {
    const bld = Object.entries(ids).find(([k]) => k.startsWith("FRT-"))![1];
    await expect(createIncident(concierge, { type: "other", severity: "low", title: "Later", description: "", buildingId: bld, unitNumber: null, unitId: null, location: null, occurredAt: "x", peopleInvolved: null, externalReference: null }, new Date(Date.now() + 86_400_000))).rejects.toBeInstanceOf(ValidationError);
    const i = await createIncident(concierge, { type: "equipment_failure", severity: "low", title: "Garage door slow", description: "", buildingId: bld, unitNumber: null, unitId: null, location: "P1", occurredAt: "x", peopleInvolved: null, externalReference: null }, new Date());
    // the front desk reports; managing (status/severity) is for incident managers
    await expect(updateIncident(concierge, i.id, { status: null, severity: "critical", note: null, visibility: "internal", resolution: null })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateIncident(pm, i.id, { status: "resolved", severity: null, note: null, visibility: "internal", resolution: null })).rejects.toBeInstanceOf(ValidationError);
    await updateIncident(pm, i.id, { status: null, severity: "critical", note: null, visibility: "internal", resolution: null });
    await drainOutbox();
    expect((await notifs("facility@demo.test", i.id)).some((n) => n.kind === "incident.escalated")).toBe(true);
    const pmKinds = (await notifs("pm@demo.test", i.id)).map((n) => n.kind);
    expect(pmKinds).toContain("incident.reported"); // told when the front desk reported it
    expect(pmKinds).not.toContain("incident.escalated"); // but not about their own escalation
  });
});

describe("complaints", () => {
  it("residents and staff converse; internal notes and the staff-only fields stay private", async () => {
    const c = await createComplaint(resident, { category: "noise", subject: "Drumming at night", description: "Every night after 11pm from the unit above.", unitId: emmaUnit, buildingId: null, unitNumber: null });
    await commentOnComplaint(pm, c.id, { body: "INTERNAL: repeat offender", visibility: "internal" });
    await commentOnComplaint(pm, c.id, { body: "We've contacted the owner.", visibility: "public" });
    const asRes = await getComplaint(resident, c.id);
    const text = asRes.timeline.map((t) => t.e.body ?? "").join("|");
    expect(text).toContain("contacted the owner");
    expect(text).not.toContain("INTERNAL");
    expect(asRes.history).toHaveLength(0);
    await expect(commentOnComplaint(resident, c.id, { body: "x", visibility: "internal" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateComplaint(resident, c.id, { status: "closed", priority: null, resolution: null })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateComplaint(pm, c.id, { status: "resolved", priority: null, resolution: null })).rejects.toBeInstanceOf(ValidationError);
    await updateComplaint(pm, c.id, { status: "resolved", priority: null, resolution: "Owner agreed to quiet hours." });
    await drainOutbox();
    expect((await notifs("resident@demo.test", c.id)).some((n) => n.kind === "complaint.updated")).toBe(true);
    expect((await getComplaint(resident, c.id)).complaint.resolution).toBe("Owner agreed to quiet hours.");
  });

  it("other residents and out-of-scope staff can't see a complaint", async () => {
    const { rows } = await ownerPool.query("select id from complaints where submitted_by_user_id = $1 limit 1", [resident.principal.userId]);
    await expect(getComplaint(council, rows[0].id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getComplaint(vendor, rows[0].id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listComplaints(council, { view: "all" })).rows.some((r) => r.id === rows[0].id)).toBe(false);
  });
});

describe("notification preferences", () => {
  it("turning off in-app for a kind suppresses it; email preference is stored per kind", async () => {
    await savePreferences(vendor, [{ kind: "workorder.assigned", email: false, inApp: false }]);
    const w = (await createWorkOrder(pm, { title: "Shower valve stiff", description: "", category: "plumbing", priority: "normal", isEmergency: false, unitId: emmaUnit, buildingId: null, unitNumber: null, propertyId: null, area: null, permissionToEnter: false, entryNotes: null })).workOrder;
    await assignWorkOrder(pm, w.id, { membershipId: null, vendorId: ids["Blake Plumbing & Heating"] });
    await drainOutbox();
    expect((await notifs("vendor@demo.test", w.id)).filter((n) => n.kind === "workorder.assigned")).toHaveLength(0);
    await savePreferences(vendor, [{ kind: "workorder.assigned", email: true, inApp: true }]);
    void admin;
  });
});
