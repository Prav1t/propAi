import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkOrder, createWoSchema, transitionWorkOrder } from "@/server/modules/maintenance/service";
import { drainOutbox, checkSlaApproaching } from "@/server/modules/notifications/service";
import { decideRun, MAX_CHAIN_DEPTH, MAX_RUNS_PER_HOUR, processAutomationEvents, runDueSchedules, sweepStaleRuns } from "@/server/automation/engine";
import { candidateEvents, deleteRule, dryRun, getRule, getRun, listRules, listRuns, pendingApprovalsFor, saveRule, setRuleEnabled } from "@/server/automation/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import type { RunStep } from "@/server/automation/actions";
import type { WorkflowInput } from "@/lib/automation";
import { ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.50", userAgent: "vitest", requestId: "automation" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}
const q = async (sql: string, params: unknown[] = []) => (await ownerPool.query(sql, params)).rows;
const settle = async () => {
  await drainOutbox();
  for (let i = 0; i <= MAX_CHAIN_DEPTH; i++) if (!(await processAutomationEvents())) break;
  await drainOutbox();
};
const tag = () => Math.random().toString(36).slice(2, 8);

let admin: TenantCtx, pm: TenantCtx, emma: TenantCtx, concierge: TenantCtx, vendor: TenantCtx, ns: TenantCtx, facility: TenantCtx;
const ids: Record<string, string> = {};

beforeAll(async () => {
  [admin, pm, emma, concierge, vendor, ns, facility] = await Promise.all([
    ctxFor("admin@demo.test"), ctxFor("pm@demo.test"), ctxFor("resident@demo.test"), ctxFor("concierge@demo.test"), ctxFor("vendor@demo.test"),
    ctxFor("admin@northshore.test", "northshore-strata"), ctxFor("facility@demo.test"),
  ]);
  for (const r of await q("select code, id from properties")) ids[r.code] = r.id;
  ids.summit = (await q("select id from vendors where name like 'Summit%'"))[0].id;
  ids.coastline = (await q("select id from vendors where name like 'Coastline%'"))[0].id;
  // seeded rules would also react to the requests these tests create; switch them off for this file
  await q("update workflows set enabled = false where org_id = (select id from organizations where slug = 'pacific-properties')");
});
afterAll(async () => {
  await ownerPool.end();
  await closeDb();
});

const elevatorRule = (name: string, extra: Partial<WorkflowInput> = {}): WorkflowInput => ({
  name, description: "", propertyId: ids.FRT, trigger: "workorder.created", schedule: null,
  conditions: [{ field: "emergency", op: "is_true" }, { field: "category", op: "is", value: ["elevator"] }],
  actions: [
    { type: "set_priority", priority: "urgent" },
    { type: "notify", to: { roles: ["property_manager"], members: [], onCall: true, submitter: false, assignee: false }, title: "Elevator emergency: {{ref}} at {{property}}", message: "{{title}}" },
    { type: "create_task", title: "Confirm nobody is trapped — {{ref}}", details: "", assignTo: "nobody", dueInMinutes: 60, priority: "urgent" },
    { type: "request_approval", role: "property_manager", note: "Dispatch Summit?" },
    { type: "assign", target: "vendor", vendorId: ids.summit },
    { type: "notify", to: { roles: [], members: [], onCall: false, submitter: true, assignee: false }, title: "A technician is on the way for {{ref}}", message: "" },
  ],
  ...extra,
});

// the seeded triage rules already route elevator requests to Summit; clear that so the rule's own assignment is visible
async function emergency(title: string, category = "elevator") {
  const r = await createWorkOrder(emma, createWoSchema.parse({ title, category, isEmergency: "on", unitId: [...emma.principal.unitIds][0] }));
  await q("update work_orders set vendor_id = null, assigned_membership_id = null where id = $1", [r.workOrder.id]);
  return r;
}

async function runsFor(workflowId: string) {
  return q("select * from workflow_runs where workflow_id = $1 order by created_at", [workflowId]);
}

describe("the emergency vertical slice", () => {
  it("runs the steps, pauses for a property manager's approval, then dispatches the vendor", async () => {
    const wf = await saveRule(admin, null, elevatorRule(`Elevator emergencies ${tag()}`), true);
    const { workOrder } = await emergency("Elevator stuck between floors 9 and 10");
    await settle();

    const [run] = await runsFor(wf.id);
    expect(run).toMatchObject({ status: "waiting_approval", approval_role: "property_manager", entity_id: workOrder.id, depth: 0 });
    const steps = run.steps as RunStep[];
    expect(steps.map((s) => s.status)).toEqual([expect.stringMatching(/done|skipped/), "done", "done", "waiting", "pending", "pending"]);
    expect(steps[1].summary).toMatch(/Marcus Chen/); // the property manager for Fraser Towers
    const [wo] = await q("select priority, vendor_id from work_orders where id = $1", [workOrder.id]);
    expect(wo).toMatchObject({ priority: "urgent", vendor_id: null });

    // the escalation task links back to the request; the PM was notified (to the inbox) about both the emergency and the approval
    const [task] = await q("select * from tasks where source = 'automation' and source_id = $1", [workOrder.id]);
    expect(task.title).toBe(`Confirm nobody is trapped — WO-${workOrder.number}`);
    const pmId = pm.principal.userId;
    const notes = await q("select kind, title, href from notifications where user_id = $1 and created_at > now() - interval '1 minute' order by created_at", [pmId]);
    expect(notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "workflow.notice", title: `Elevator emergency: WO-${workOrder.number} at Fraser Towers` }),
      expect.objectContaining({ kind: "workflow.approval", href: `/o/pacific-properties/automations/runs/${run.id}` }),
    ]));

    // only the people asked can see and decide
    expect((await pendingApprovalsFor(pm)).map((r) => r.id)).toContain(run.id);
    expect(await pendingApprovalsFor(concierge)).toEqual([]);
    await expect(getRun(vendor, run.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(decideRun(concierge, run.id, "approve", null)).rejects.toBeInstanceOf(NotFoundError);
    await expect(decideRun(facility, run.id, "approve", null)).rejects.toBeInstanceOf(NotFoundError);
    await expect(decideRun(admin, run.id, "approve", null)).rejects.toThrow(/Only a property manager for this property can decide/); // org admin, wrong role

    const done = await decideRun(pm, run.id, "approve", "Go ahead");
    expect(done.status).toBe("completed");
    await settle();
    const [after] = await q("select vendor_id, status from work_orders where id = $1", [workOrder.id]);
    expect(after).toMatchObject({ vendor_id: ids.summit, status: "assigned" });
    const [final] = await runsFor(wf.id);
    expect((final.steps as RunStep[]).map((s) => s.status)).toEqual([expect.stringMatching(/done|skipped/), "done", "done", "done", "done", "done"]);
    // the resident hears about it only after the manager approved
    const told = await q("select title from notifications where user_id = $1 and kind = 'workflow.notice' and entity_id = $2", [emma.principal.userId, workOrder.id]);
    expect(told.map((t) => t.title)).toEqual([`A technician is on the way for WO-${workOrder.number}`]);
    expect((final.steps as RunStep[])[3].summary).toBe("Approved by Marcus Chen: “Go ahead”");

    // every change the rule made is in the audit log, marked with the run
    const audit = await q("select action, actor_user_id from audit_logs where workflow_run_id = $1 order by created_at", [run.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["task.created", "work_order.assigned"]));
    expect(audit.every((a) => a.actor_user_id === admin.principal.userId)).toBe(true); // the owner's permissions, the owner's name
    expect((await q("select action from audit_logs where entity_id = $1", [run.id])).map((a) => a.action)).toContain("automation.approved");

    // and processing the same event again changes nothing
    await q("update outbox_events set automation_at = null where type = 'workorder.created' and payload->>'workOrderId' = $1", [workOrder.id]);
    await settle();
    expect(await runsFor(wf.id)).toHaveLength(1);
    await setRuleEnabled(admin, wf.id, false);
  });

  it("declining skips the remaining steps", async () => {
    const wf = await saveRule(admin, null, elevatorRule(`Decline ${tag()}`), true);
    const { workOrder } = await emergency("Elevator doors won't close");
    await settle();
    const [run] = await runsFor(wf.id);
    const r = await decideRun(pm, run.id, "decline", "Our tech will look first");
    expect(r.status).toBe("rejected");
    const [after] = await runsFor(wf.id);
    expect((after.steps as RunStep[]).at(-1)).toMatchObject({ status: "skipped", summary: "Not run — approval was declined." });
    expect((await q("select vendor_id from work_orders where id = $1", [workOrder.id]))[0].vendor_id).toBeNull();
    await expect(decideRun(pm, run.id, "approve", null)).rejects.toThrow(/isn't waiting/);
    await setRuleEnabled(admin, wf.id, false);
  });

  it("doesn't run when the conditions aren't met or the record is at another property", async () => {
    const wf = await saveRule(admin, null, elevatorRule(`Conditions ${tag()}`), true);
    await createWorkOrder(emma, createWoSchema.parse({ title: "Elevator chime is loud", category: "elevator", unitId: [...emma.principal.unitIds][0] })); // not an emergency
    await emergency("Kitchen tap burst", "plumbing"); // not the elevator
    await createWorkOrder(admin, createWoSchema.parse({ title: "Elevator stuck at Harbour", category: "elevator", isEmergency: "on", propertyId: ids.HBC }));
    await settle();
    expect(await runsFor(wf.id)).toHaveLength(0);
    await setRuleEnabled(admin, wf.id, false);
  });
});

describe("loop protection", () => {
  it("a rule never fires on its own events, chains stop at the depth limit, and runaway rules pause", async () => {
    // A: any status change at Fraser Towers → move it to "in progress" (its own status change must not re-trigger it)
    const a = await saveRule(admin, null, { name: `Self ${tag()}`, description: "", propertyId: ids.FRT, trigger: "workorder.status_changed", schedule: null, conditions: [{ field: "new_status", op: "is", value: ["acknowledged"] }], actions: [{ type: "set_status", status: "in_progress" }] }, true);
    // B: reacts to A's change (depth 1)
    const b = await saveRule(admin, null, { name: `Follower ${tag()}`, description: "", propertyId: ids.FRT, trigger: "workorder.status_changed", schedule: null, conditions: [{ field: "new_status", op: "is", value: ["in_progress"] }], actions: [{ type: "notify", to: { roles: ["property_manager"], members: [], onCall: false, submitter: false, assignee: false }, title: "Started: {{ref}}", message: "" }] }, true);
    const { workOrder } = await createWorkOrder(admin, createWoSchema.parse({ title: `Loop check ${tag()}`, category: "general", propertyId: ids.FRT }));
    await transitionWorkOrder(admin, workOrder.id, { to: "acknowledged", note: null, cost: null, resolutionNotes: null });
    await settle();
    const ra = await runsFor(a.id);
    const rb = await runsFor(b.id);
    expect(ra).toHaveLength(1);
    expect(rb).toHaveLength(1);
    expect(rb[0].depth).toBe(1);
    const evs = await q("select caused_by_workflow_id, chain_depth from outbox_events where type = 'workorder.status_changed' and payload->>'workOrderId' = $1 order by created_at", [workOrder.id]);
    expect(evs.at(-1)).toMatchObject({ caused_by_workflow_id: a.id, chain_depth: 1 });

    // an event already MAX_CHAIN_DEPTH hops deep is never evaluated
    await q("insert into outbox_events (org_id, type, payload, chain_depth) values ((select id from organizations where slug='pacific-properties'), 'workorder.status_changed', $1, $2)",
      [JSON.stringify({ workOrderId: workOrder.id, from: "in_progress", to: "in_progress" }), MAX_CHAIN_DEPTH]);
    await settle();
    expect(await runsFor(b.id)).toHaveLength(1);

    // more than MAX_RUNS_PER_HOUR runs in an hour pauses the rule
    await q(`insert into workflow_runs (org_id, workflow_id, workflow_version, trigger_type, status) select org_id, id, 1, trigger_type, 'completed' from workflows, generate_series(1, $2) where id = $1`, [b.id, MAX_RUNS_PER_HOUR]);
    const { workOrder: w2 } = await createWorkOrder(admin, createWoSchema.parse({ title: `Runaway ${tag()}`, category: "general", propertyId: ids.FRT }));
    await transitionWorkOrder(admin, w2.id, { to: "in_progress", note: null, cost: null, resolutionNotes: null });
    await settle();
    const [paused] = await q("select enabled, paused_reason from workflows where id = $1", [b.id]);
    expect(paused.enabled).toBe(false);
    expect(paused.paused_reason).toMatch(/ran \d{3} times in the last hour/);
    await setRuleEnabled(admin, a.id, false);
  });
});

describe("who can do what", () => {
  it("rules run with the owner's current permissions", async () => {
    const wf = await saveRule(pm, null, { name: `Owner check ${tag()}`, description: "", propertyId: ids.FRT, trigger: "workorder.created", schedule: null, conditions: [{ field: "title", op: "contains", value: "owner-check" }], actions: [{ type: "set_priority", priority: "high" }] }, true);
    await q("update workflows set owner_user_id = $2 where id = $1", [wf.id, concierge.principal.userId]); // someone without automation rights
    const { workOrder } = await createWorkOrder(admin, createWoSchema.parse({ title: "owner-check paint scuff", category: "general", propertyId: ids.FRT }));
    await settle();
    const [run] = await runsFor(wf.id);
    expect(run).toMatchObject({ status: "failed" });
    expect(run.error).toMatch(/owner no longer has permission/);
    expect((await q("select priority from work_orders where id = $1", [workOrder.id]))[0].priority).not.toBe("high");
    await deleteRule(pm, wf.id);
  });

  it("scoped managers make rules only for their properties, with things they can do there", async () => {
    const base = elevatorRule(`Scope ${tag()}`);
    await expect(saveRule(pm, null, { ...base, propertyId: null }, false)).rejects.toThrow(/organization-wide/);
    await expect(saveRule(pm, null, { ...base, propertyId: ids.PCH }, false)).rejects.toBeInstanceOf(ValidationError);
    const [unapproved] = await q("select id from vendors v where status = 'active' and org_id = (select org_id from properties where id = $1) and not exists (select 1 from vendor_properties vp where vp.vendor_id = v.id and vp.property_id = $1) limit 1", [ids.HBC]);
    await expect(saveRule(pm, null, { ...base, propertyId: ids.HBC, actions: [{ type: "assign", target: "vendor", vendorId: unapproved.id }] }, false)).rejects.toThrow(/approved for the property/);
    await expect(saveRule(concierge, null, base, false)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveRule(pm, null, { ...base, actions: [{ type: "notify", to: { roles: ["resident"], members: [], onCall: false, submitter: false, assignee: false }, title: "x", message: "" }] }, false)).rejects.toThrow(/staff roles/);
    const own = await saveRule(pm, null, base, false);
    const orgWide = await saveRule(admin, null, { ...base, propertyId: null, name: `Org ${tag()}` }, false);
    const visible = await listRules(pm);
    expect(visible.find((r) => r.id === orgWide.id)?.editable).toBe(false); // org-wide rules are read-only to a property manager
    expect(visible.find((r) => r.id === own.id)?.editable).toBe(true);
    await expect(setRuleEnabled(pm, orgWide.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getRule(ns, own.id)).rejects.toBeInstanceOf(NotFoundError); // another organization
    await expect(listRules(emma)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteRule(pm, own.id);
    await deleteRule(admin, orgWide.id);
  });
});

describe("dry runs", () => {
  it("show what would happen for a past event without changing anything", async () => {
    const { workOrder } = await emergency("Elevator making grinding noise");
    await drainOutbox();
    const events = await candidateEvents(pm, "workorder.created", ids.FRT);
    const ev = events.find((e) => e.label.startsWith(`WO-${workOrder.number} `));
    expect(ev).toBeTruthy();
    const counts = async () => (await q("select (select count(*) from tasks) t, (select count(*) from notifications) n, (select count(*) from workflow_runs) r, (select count(*) from audit_logs) a"))[0];
    const before = await counts();
    const res = await dryRun(pm, elevatorRule("Draft"), ev!.id);
    expect(res.matched).toBe(true);
    expect(res.steps.map((s) => s.afterApproval)).toEqual([false, false, false, false, true, true]);
    expect(res.steps[1].outcome).toMatch(/Would notify .*Marcus Chen/);
    expect(res.steps[4].outcome).toBe(`Would assign WO-${workOrder.number} to Summit Elevator Services.`);
    const miss = await dryRun(pm, { ...elevatorRule("Draft"), conditions: [{ field: "category", op: "is", value: ["plumbing"] }] }, ev!.id);
    expect(miss).toMatchObject({ matched: false, reason: "It wouldn't run: the condition “category is Plumbing” isn't met." });
    expect(await counts()).toEqual(before);
    // events about records the tester can't see aren't offered or accepted
    const { workOrder: other } = await createWorkOrder(admin, createWoSchema.parse({ title: `Pacific Heights only ${tag()}`, category: "elevator", propertyId: ids.PCH }));
    const [otherEv] = await q("select id from outbox_events where type = 'workorder.created' and payload->>'workOrderId' = $1", [other.id]);
    await expect(dryRun(pm, { ...elevatorRule("Draft"), propertyId: ids.FRT }, otherEv.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("schedules, reports and SLA warnings", () => {
  it("a scheduled report runs once per slot and each recipient gets what their access allows", async () => {
    const wf = await saveRule(admin, null, {
      name: `Weekly report ${tag()}`, description: "", propertyId: ids.FRT, trigger: "schedule", schedule: { frequency: "weekly", time: "08:00", weekday: 1 }, conditions: [],
      actions: [{ type: "send_report", report: "maintenance", period: "7d", to: { roles: ["property_manager", "concierge"], members: [], onCall: false, submitter: false, assignee: false } }],
    }, true);
    const [{ next_run_at }] = await q("select next_run_at from workflows where id = $1", [wf.id]);
    expect(new Date(next_run_at).getTime()).toBeGreaterThan(Date.now());
    await q("update workflows set next_run_at = now() - interval '1 minute' where id = $1", [wf.id]);
    expect(await runDueSchedules()).toBeGreaterThanOrEqual(1);
    expect(await runDueSchedules()).toBe(0);
    const runs = await runsFor(wf.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect((runs[0].steps as RunStep[])[0].summary).toMatch(/^Sent to Marcus Chen; skipped .*Aisha Rahman.* \(no access to reports\)\.$/);
    await drainOutbox();
    const [note] = await q("select title, body, href from notifications where kind = 'report.scheduled' and user_id = $1 order by created_at desc limit 1", [pm.principal.userId]);
    expect(note.title).toBe("Maintenance requests — last 7 days");
    expect(note.body).toMatch(/^Requests created: \d+/m);
    expect(note.href).toBe(`/o/pacific-properties/analytics/reports/maintenance?period=7d&property=${ids.FRT}`);
    const [{ next_run_at: n2 }] = await q("select next_run_at from workflows where id = $1", [wf.id]);
    expect(new Date(n2).getTime()).toBeGreaterThan(Date.now());
    await deleteRule(admin, wf.id);
  });

  it("warns once as a request nears its target, and rules can react to the warning", async () => {
    const wf = await saveRule(admin, null, { name: `Due soon ${tag()}`, description: "", propertyId: ids.FRT, trigger: "workorder.sla_approaching", schedule: null, conditions: [], actions: [{ type: "assistant_draft", instruction: "" }] }, true);
    const { workOrder } = await createWorkOrder(admin, createWoSchema.parse({ title: `Leaking valve ${tag()}`, category: "plumbing", propertyId: ids.FRT, description: "Valve in the P1 mechanical room is dripping steadily." }));
    await q("update work_orders set resolve_due_at = now() + interval '30 minutes', sla_warned_at = null where id = $1", [workOrder.id]);
    expect(await checkSlaApproaching()).toBeGreaterThanOrEqual(1);
    expect(await checkSlaApproaching()).toBe(0);
    await settle();
    const [run] = await runsFor(wf.id);
    expect(run.status).toBe("completed");
    const [draft] = await q("select body, visibility from timeline_events where entity_id = $1 and kind = 'comment' order by created_at desc limit 1", [workOrder.id]);
    expect(draft.visibility).toBe("internal");
    expect(draft.body).toMatch(/^Assistant draft \(demo mode — composed from the record, no language model\) — not sent:\n/);
    expect(draft.body).toContain("Valve in the P1 mechanical room is dripping steadily.");
    const [warn] = await q("select title from notifications where kind = 'workorder.sla_approaching' and entity_id = $1 limit 1", [workOrder.id]);
    expect(warn.title).toBe(`Due soon: #${workOrder.number} ${workOrder.title}`);
    await deleteRule(admin, wf.id);
  });

  it("closes runs left running by a crash", async () => {
    const wf = await saveRule(admin, null, { ...elevatorRule(`Stale ${tag()}`) }, false);
    await q("insert into workflow_runs (org_id, workflow_id, workflow_version, trigger_type, status, started_at) select org_id, id, 1, trigger_type, 'running', now() - interval '1 hour' from workflows where id = $1", [wf.id]);
    expect(await sweepStaleRuns()).toBeGreaterThanOrEqual(1);
    expect((await runsFor(wf.id))[0]).toMatchObject({ status: "failed" });
    const page = await listRuns(admin, { workflowId: wf.id });
    expect(page.rows[0].error).toMatch(/Interrupted/);
    await deleteRule(admin, wf.id);
  });
});
