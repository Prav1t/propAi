import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runAssistantTurn, type AssistantEvent } from "@/server/ai/orchestrator";
import { setChatModelForTests } from "@/server/ai/providers";
import { DemoModel } from "@/server/ai/providers/demo";
import { resolveAiConfig, setAiConfigForTests } from "@/server/ai/config";
import { approvePlan, getPlanView, listPendingPlans, recentPlans, rejectPlan, reviseStep } from "@/server/ai/approvals";
import { listPolicies, setPolicy } from "@/server/ai/policies";
import { getConversationView } from "@/server/ai/store";
import { drainOutbox } from "@/server/modules/notifications/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { ConflictError, ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import type { ChatEvent, ChatModel, ChatRequest } from "@/server/ai/types";
import { ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.30", userAgent: "vitest", requestId: "ai-actions" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}

class ScriptedModel implements ChatModel {
  readonly provider = "scripted";
  readonly demo = false;
  readonly model = "scripted-1";
  requests: ChatRequest[] = [];
  constructor(private steps: ChatEvent[][]) {}
  async *stream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const step = this.steps.shift();
    if (!step) throw new Error("script exhausted");
    for (const e of step) yield e;
  }
}
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const calls = (...cs: { name: string; input: Record<string, unknown> }[]): ChatEvent[] => [
  ...cs.map((c, i): ChatEvent => ({ type: "tool_call", call: { id: `c${i}_${Math.random().toString(36).slice(2, 7)}`, name: c.name, input: c.input } })),
  { type: "end", stopReason: "tool_use", usage },
];
const say = (text: string): ChatEvent[] => [{ type: "text", delta: text }, { type: "end", stopReason: "end", usage }];

async function ask(ctx: TenantCtx, message: string, conversationId: string | null = null) {
  const events: AssistantEvent[] = [];
  for await (const ev of runAssistantTurn(ctx, { message, conversationId })) events.push(ev);
  const start = events.find((e) => e.type === "start") as Extract<AssistantEvent, { type: "start" }>;
  const plan = (events.find((e) => e.type === "plan") as Extract<AssistantEvent, { type: "plan" }> | undefined)?.plan ?? null;
  const tools = events.filter((e) => e.type === "tool_end") as Extract<AssistantEvent, { type: "tool_end" }>[];
  const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
  return { events, start, plan, tools, text, conversationId: start.conversationId, turnId: start.turnId };
}
const q = async (sql: string, params: unknown[] = []) => (await ownerPool.query(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0].n);
const localDay = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date(Date.now() + offset * 86_400_000));

let pm: TenantCtx, admin: TenantCtx, emma: TenantCtx, concierge: TenantCtx, ns: TenantCtx;
let pacId: string;

beforeAll(async () => {
  [pm, admin, emma, concierge, ns] = await Promise.all([
    ctxFor("pm@demo.test"), ctxFor("admin@demo.test"), ctxFor("resident@demo.test"), ctxFor("concierge@demo.test"), ctxFor("admin@northshore.test", "northshore-strata"),
  ]);
  pacId = pm.principal.orgId;
  setAiConfigForTests({ ...resolveAiConfig({}), requestsPerMinute: 1000 });
});
afterEach(() => setChatModelForTests(new DemoModel()));
afterAll(async () => {
  setChatModelForTests(undefined);
  setAiConfigForTests(undefined);
  await ownerPool.end();
  await closeDb();
});

const ELEVATOR = "Create a maintenance request for the broken elevator in Tower B and assign Summit Elevator";

describe("vertical slice: request → plan → approve → work order → verified → audited", () => {
  it("prepares without changing anything, then creates and assigns on approval", async () => {
    setChatModelForTests(new DemoModel());
    const before = await count("select count(*) n from work_orders where org_id = $1", [pacId]);
    const r = await ask(pm, ELEVATOR);
    // the duplicate check ran first, then the action was only prepared
    expect(r.tools.map((t) => [t.tool, t.outcome])).toEqual([["search_work_orders", "ok"], ["create_work_order", "pending"]]);
    expect(r.text).toMatch(/I've prepared this for you to approve/);
    expect(r.text).not.toMatch(/\bcreated\b/i);
    expect(r.plan).toMatchObject({ status: "pending", mode: "confirm", confirm: "click", canDecide: true });
    expect(r.plan!.steps).toHaveLength(1);
    expect(r.plan!.steps[0]).toMatchObject({ tool: "create_work_order", title: "Create work order “Broken elevator”", riskClass: 2, result: null });
    expect(r.plan!.steps[0].effects).toContain("Assigned to Summit Elevator Services, who is notified");
    expect(await count("select count(*) n from work_orders where org_id = $1", [pacId])).toBe(before);
    // the prepared call is logged as pending and linked to the plan
    const [logged] = await q("select outcome, approval_id, risk_class from ai_tool_calls where turn_id = $1 and tool = 'create_work_order'", [r.turnId]);
    expect(logged).toMatchObject({ outcome: "pending", approval_id: r.plan!.id, risk_class: 2 });

    const done = await approvePlan(pm, r.plan!.id);
    expect(done.status).toBe("executed");
    expect(done.decidedBy).toBe("Marcus Chen");
    const res = done.steps[0].result!;
    expect(res).toMatchObject({ status: "executed", verified: true });
    expect(res.summary).toMatch(/^Created WO-\d+ “Broken elevator” and assigned it to Summit Elevator Services\.$/);
    expect(res.record!.href).toMatch(/^\/o\/pacific-properties\/maintenance\/[0-9a-f-]{36}$/);
    const woId = res.record!.href.split("/").pop();
    const [wo] = await q("select w.title, w.status, v.name vendor, w.source from work_orders w left join vendors v on v.id = w.vendor_id where w.id = $1", [woId]);
    expect(wo).toMatchObject({ title: "Broken elevator", status: "assigned", vendor: "Summit Elevator Services" });
    // every change is audited as AI-generated, pointing at the plan; the approval itself is a human decision
    const audit = await q("select action, ai_generated, approval_id, actor_user_id from audit_logs where approval_id = $1 order by created_at", [r.plan!.id]);
    expect(audit.map((a) => a.action)).toEqual(["ai.plan.prepared", "ai.plan.approved", "work_order.created", "work_order.assigned", "ai.plan.executed"]);
    expect(audit.find((a) => a.action === "ai.plan.approved").ai_generated).toBe(false);
    for (const a of audit.filter((x) => x.action.startsWith("work_order."))) expect(a).toMatchObject({ ai_generated: true, actor_user_id: pm.principal.userId });
    // the vendor hears about it through the normal notification pipeline
    expect(await count("select count(*) n from outbox_events where org_id = $1 and type = 'workorder.assigned' and payload->>'workOrderId' = $2", [pacId, woId])).toBe(1);
    const [run] = await q("select outcome, approval_id from ai_tool_calls where call_id like '%:run' and approval_id = $1", [r.plan!.id]);
    expect(run).toMatchObject({ outcome: "executed", approval_id: r.plan!.id });

    // the conversation shows the plan with its result, and the next turn tells the model what happened
    const view = await getConversationView(pm, r.conversationId);
    expect(view.turns[0].plan).toMatchObject({ id: r.plan!.id, status: "executed" });
    expect(view.turns[0].steps.map((s) => s.tool)).toEqual(["search_work_orders", "create_work_order"]); // execution rows aren't repeated in the trail
    const model = new ScriptedModel([say("Noted.")]);
    setChatModelForTests(model);
    await ask(pm, "thanks", r.conversationId);
    const replay = JSON.stringify(model.requests[0].messages);
    expect(replay).toContain("[Update: The user approved the plan. Results: executed: Created WO-");
  });

  it("a second approval of the same plan is refused, including two at once", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(pm, ELEVATOR);
    const before = await count("select count(*) n from work_orders where org_id = $1", [pacId]);
    const both = await Promise.allSettled([approvePlan(pm, r.plan!.id), approvePlan(pm, r.plan!.id)]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failed = both.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ConflictError);
    await expect(approvePlan(pm, r.plan!.id)).rejects.toThrow(/already approved/);
    expect(await count("select count(*) n from work_orders where org_id = $1", [pacId])).toBe(before + 1);
  });
});

describe("deciding on plans", () => {
  it("cancelling changes nothing and can't be undone into an approval", async () => {
    setChatModelForTests(new DemoModel());
    const before = await count("select count(*) n from work_orders where org_id = $1", [pacId]);
    const r = await ask(pm, ELEVATOR);
    const v = await rejectPlan(pm, r.plan!.id);
    expect(v).toMatchObject({ status: "rejected", canDecide: false, decidedBy: "Marcus Chen" });
    await expect(approvePlan(pm, r.plan!.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await count("select count(*) n from work_orders where org_id = $1", [pacId])).toBe(before);
    expect(await count("select count(*) n from audit_logs where approval_id = $1 and action = 'ai.plan.rejected'", [r.plan!.id])).toBe(1);
    const model = new ScriptedModel([say("OK.")]);
    setChatModelForTests(model);
    await ask(pm, "never mind", r.conversationId);
    expect(JSON.stringify(model.requests[0].messages)).toContain("The user cancelled the prepared plan; nothing was changed.");
  });

  it("only the person who asked can see or decide a plan — not an admin, not another organization", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(pm, ELEVATOR);
    await expect(approvePlan(admin, r.plan!.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(rejectPlan(admin, r.plan!.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getPlanView(admin, r.plan!.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(approvePlan(ns, r.plan!.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(reviseStep(ns, r.plan!.id, "s1", { title: "pwned" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listPendingPlans(admin)).some((p) => p.id === r.plan!.id)).toBe(false);
    expect((await listPendingPlans(pm)).some((p) => p.id === r.plan!.id)).toBe(true);
    expect((await getPlanView(pm, r.plan!.id)).status).toBe("pending");
  });

  it("a newer plan in the same conversation replaces the older one", async () => {
    setChatModelForTests(new DemoModel());
    const a = await ask(pm, ELEVATOR);
    const b = await ask(pm, "Create a work order for the broken lobby door at Harbour Centre", a.conversationId);
    expect(b.plan!.steps[0].title).toBe("Create work order “Broken lobby door”");
    expect((await getPlanView(pm, a.plan!.id)).status).toBe("superseded");
    await expect(approvePlan(pm, a.plan!.id)).rejects.toThrow(/newer plan replaced/);
  });

  it("plans expire after a day", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(pm, ELEVATOR);
    await q("update ai_approvals set expires_at = now() - interval '1 minute' where id = $1", [r.plan!.id]);
    expect((await getPlanView(pm, r.plan!.id)).status).toBe("expired");
    expect((await listPendingPlans(pm)).some((p) => p.id === r.plan!.id)).toBe(false);
    await expect(approvePlan(pm, r.plan!.id)).rejects.toThrow(/expired/);
    const [row] = await q("select status from ai_approvals where id = $1", [r.plan!.id]);
    expect(row.status).toBe("expired");
  });

  it("re-checks permissions at approval: a role that lost the permission can't run the plan", async () => {
    setChatModelForTests(new DemoModel());
    const before = await count("select count(*) n from work_orders where org_id = $1", [pacId]);
    const r = await ask(pm, ELEVATOR);
    const demoted: TenantCtx = { ...pm, principal: { ...pm.principal, permissions: new Set([...pm.principal.permissions].filter((x) => x !== "workorder.create")) } };
    const v = await approvePlan(demoted, r.plan!.id);
    expect(v.status).toBe("failed");
    expect(v.steps[0].result).toMatchObject({ status: "failed", summary: "You don't have permission to do this any more." });
    expect(await count("select count(*) n from work_orders where org_id = $1", [pacId])).toBe(before);
  });

  it("re-checks policy at approval: an action an admin turned off since won't run", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(pm, ELEVATOR);
    await setPolicy(admin, { action: "workorder.assign", propertyId: null, mode: "deny" });
    try {
      const v = await approvePlan(pm, r.plan!.id);
      expect(v.status).toBe("failed");
      expect(v.steps[0].result!.summary).toMatch(/administrator has since stopped/);
    } finally {
      await setPolicy(admin, { action: "workorder.assign", propertyId: null, mode: "default" });
    }
  });

  it("edits are re-validated with the same rules before approval", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(pm, ELEVATOR);
    await expect(reviseStep(pm, r.plan!.id, "s1", { title: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(reviseStep(pm, r.plan!.id, "s1", { vendorId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/Only the fields shown/);
    await expect(reviseStep(pm, r.plan!.id, "s1", { priority: "whenever" })).rejects.toBeInstanceOf(ValidationError);
    await expect(reviseStep(pm, r.plan!.id, "s9", { title: "Fine title" })).rejects.toBeInstanceOf(NotFoundError);
    const v = await reviseStep(pm, r.plan!.id, "s1", { title: "Car 2 stuck between floors", priority: "urgent", area: "Elevator bank" });
    expect(v.steps[0].title).toBe("Create work order “Car 2 stuck between floors”");
    expect(v.steps[0].details.join(" ")).toMatch(/Elevator bank/);
    expect(v.steps[0].effects).toContain("Assigned to Summit Elevator Services, who is notified"); // untouched parts stay
    expect(await count("select count(*) n from audit_logs where approval_id = $1 and action = 'ai.plan.edited'", [r.plan!.id])).toBe(1);
    const done = await approvePlan(pm, r.plan!.id);
    const [wo] = await q("select title, priority, area from work_orders where id = $1", [done.steps[0].result!.record!.href.split("/").pop()]);
    expect(wo).toEqual({ title: "Car 2 stuck between floors", priority: "urgent", area: "Elevator bank" });
  });

  it("cancelling a work order is high impact: it needs an explicit acknowledgement", async () => {
    const [wo] = await q("select w.number from work_orders w join properties p on p.id = w.property_id where w.org_id = $1 and p.name = 'Harbour Centre' and w.status in ('new','acknowledged','assigned') order by w.number limit 1", [pacId]);
    setChatModelForTests(new DemoModel());
    const r = await ask(pm, `Cancel WO-${wo.number}`);
    expect(r.plan).toMatchObject({ confirm: "acknowledge" });
    expect(r.plan!.steps[0]).toMatchObject({ riskClass: 4, riskLabel: "High impact" });
    await expect(approvePlan(pm, r.plan!.id)).rejects.toThrow(/Tick the box/);
    expect((await getPlanView(pm, r.plan!.id)).status).toBe("pending");
    const v = await approvePlan(pm, r.plan!.id, { acknowledge: true });
    expect(v.status).toBe("executed");
    const [after] = await q("select status from work_orders where org_id = $1 and number = $2", [pacId, wo.number]);
    expect(after.status).toBe("cancelled");
  });

  it("stops at the first failed step and reports a partial result honestly", async () => {
    const [wo] = await q("select w.number from work_orders w join properties p on p.id = w.property_id where w.org_id = $1 and p.name = 'Fraser Towers' and w.status in ('new','acknowledged','assigned') order by w.number desc limit 1", [pacId]);
    setChatModelForTests(new ScriptedModel([
      calls({ name: "update_work_order_status", input: { number: wo.number, status: "cancelled", note: "Duplicate" } }, { name: "assign_work_order", input: { number: wo.number, vendor: "Coastline Electric" } }),
      say("I've prepared both changes for your approval."),
    ]));
    const r = await ask(pm, "cancel it and assign Coastline");
    expect(r.plan!.steps.map((s) => s.tool)).toEqual(["update_work_order_status", "assign_work_order"]);
    const v = await approvePlan(pm, r.plan!.id, { acknowledge: true });
    expect(v.status).toBe("partially_failed");
    expect(v.steps[0].result!.status).toBe("executed");
    expect(v.steps[1].result).toMatchObject({ status: "failed", summary: "Reopen the request before reassigning it." });
  });
});

describe("organization policies", () => {
  it("lets internal tasks run without asking where an admin allowed it, and audits them the same way", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(pm, "Create a task to restock the first-aid kit at Harbour Centre by Friday");
    expect(r.plan).toBeNull();
    expect(r.tools.map((t) => [t.tool, t.outcome])).toEqual([["create_task", "executed"]]);
    expect(r.text).toMatch(/^Done \(your organization lets .* do this without asking\): Created the task “Restock the first-aid kit”\./);
    const [call] = await q("select approval_id from ai_tool_calls where turn_id = $1", [r.turnId]);
    const [plan] = await q("select mode, status, decided_by_user_id from ai_approvals where id = $1", [call.approval_id]);
    expect(plan).toEqual({ mode: "auto", status: "executed", decided_by_user_id: null });
    const audit = await q("select action, ai_generated from audit_logs where approval_id = $1 order by created_at", [call.approval_id]);
    expect(audit.map((a) => a.action)).toEqual(["task.created", "ai.plan.auto_executed"]);
    expect(audit.every((a) => a.ai_generated)).toBe(true);
    expect((await recentPlans(admin)).find((p) => p.id === call.approval_id)).toMatchObject({ mode: "auto", status: "executed", requestedBy: "Marcus Chen" });
  });

  it("a property rule overrides the organization rule", async () => {
    await setPolicy(admin, { action: "task.create", propertyId: (await q("select id from properties where name = 'Harbour Centre'"))[0].id, mode: "deny" });
    try {
      setChatModelForTests(new DemoModel());
      const hbc = await ask(pm, "Create a task to check the lobby lights at Harbour Centre by Friday");
      expect(hbc.tools[0].outcome).toBe("policy_denied");
      expect(hbc.text).toMatch(/doesn't let .* do this .*Create tasks: not allowed for the assistant \(property rule\)/);
      const frt = await ask(pm, "Create a task to check the lobby lights at Fraser Towers by Friday");
      expect(frt.tools[0].outcome).toBe("executed");
    } finally {
      await setPolicy(admin, { action: "task.create", propertyId: (await q("select id from properties where name = 'Harbour Centre'"))[0].id, mode: "default" });
    }
  });

  it("contacting residents can be turned off but never set to run on its own; only AI admins change rules", async () => {
    await expect(setPolicy(admin, { action: "communication.send", propertyId: null, mode: "auto" })).rejects.toThrow(/always needs someone to confirm/);
    await expect(setPolicy(pm, { action: "task.create", propertyId: null, mode: "deny" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listPolicies(pm)).rejects.toBeInstanceOf(ForbiddenError);
    await setPolicy(admin, { action: "communication.send", propertyId: null, mode: "deny" });
    try {
      setChatModelForTests(new DemoModel());
      const r = await ask(pm, "Send residents of Fraser Towers a notice saying the pool will be closed tomorrow");
      expect(r.plan).toBeNull();
      expect(r.tools[0]).toMatchObject({ tool: "send_announcement", outcome: "policy_denied" });
      expect(await count("select count(*) n from ai_approvals where turn_id = $1", [r.turnId])).toBe(0);
    } finally {
      await setPolicy(admin, { action: "communication.send", propertyId: null, mode: "default" });
    }
    const rows = (await listPolicies(admin)).rows;
    expect(rows.find((x) => x.key === "communication.send")!.orgMode).toBeNull();
    expect(rows.find((x) => x.key === "task.create")!.orgMode).toBe("auto"); // from the seed
  });

  it("Northshore's rule turns package logging off for the assistant", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(ns, "A package arrived for unit 101");
    expect(r.tools[0]).toMatchObject({ tool: "log_package", outcome: "policy_denied" });
    expect(r.plan).toBeNull();
  });
});

describe("residents act only for their own home", () => {
  it("books for their own unit through the real booking rules, and never for someone else's", async () => {
    const day = localDay(2);
    setChatModelForTests(new ScriptedModel([calls({ name: "create_booking", input: { amenity: "gym", date: day, start: "19:00", unit: "905" } }), say("I can only book for your unit.")]));
    const other = await ask(emma, "book the gym for unit 905");
    expect(other.tools[0]).toMatchObject({ tool: "create_booking", outcome: "denied" });
    expect(other.plan).toBeNull();

    setChatModelForTests(new ScriptedModel([calls({ name: "create_booking", input: { amenity: "gym", date: day, start: "19:00" } }), say("Prepared — approve it below.")]));
    const own = await ask(emma, `book the gym on ${day} at 7 pm`);
    expect(own.plan!.steps[0]).toMatchObject({ tool: "create_booking" });
    expect(own.plan!.steps[0].details).toEqual(expect.arrayContaining(["Unit 1204 · Tower B · Fraser Towers", "Confirmed as soon as it's booked"]));
    const v = await approvePlan(emma, own.plan!.id);
    expect(v.status).toBe("executed");
    const [b] = await q("select b.status, u.number, bu.name building from bookings b join units u on u.id = b.unit_id join buildings bu on bu.id = u.building_id where b.id = $1", [v.steps[0].result!.record!.href.split("/").pop()]);
    expect(b).toEqual({ status: "approved", number: "1204", building: "Tower B" });
  });

  it("the booking rules refuse a slot before anything is prepared", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(emma, "Book the party room tomorrow at 7 PM");
    expect(r.tools[0]).toMatchObject({ tool: "create_booking", outcome: "invalid" });
    expect(r.text).toMatch(/can't be booked .*48 hours ahead/);
    expect(r.plan).toBeNull();
  });

  it("files a work order for their own unit and can't dispatch a vendor", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(emma, "My kitchen sink is leaking badly and water is spreading across the floor — please file a request");
    expect(r.plan!.steps[0].details[0]).toBe("Unit 1204 · Tower B · Fraser Towers");
    expect(r.plan!.steps[0].details[1]).toMatch(/emergency/); // the org's triage rules, not the model, decide urgency
    setChatModelForTests(new ScriptedModel([calls({ name: "create_work_order", input: { title: "Leak", assignVendor: "Blake Plumbing" } }), say("Residents can't assign vendors.")]));
    const r2 = await ask(emma, "file it and send Blake Plumbing");
    expect(r2.tools[0]).toMatchObject({ outcome: "denied" });
    // staff-only tools aren't even offered to a resident
    setChatModelForTests(new ScriptedModel([calls({ name: "send_announcement", input: { title: "Hi all", body: "Party at mine" } }), say("I can't do that.")]));
    const r3 = await ask(emma, "tell everyone");
    expect(r3.tools[0]).toMatchObject({ tool: "send_announcement", outcome: "unknown_tool" });
  });
});

describe("front desk and communications", () => {
  it("asks which tower when a unit number repeats, then logs the package and notifies the unit", async () => {
    setChatModelForTests(new DemoModel());
    const a = await ask(concierge, "A package arrived for unit 1204");
    expect(a.tools[0]).toMatchObject({ tool: "log_package", outcome: "ambiguous" });
    expect(a.text).toMatch(/Unit 1204 · Tower A · Fraser Towers\n- Unit 1204 · Tower B · Fraser Towers\n\nWhich one did you mean\?/);
    expect(a.plan).toBeNull();
    const b = await ask(concierge, "A package arrived for unit 1204 in Tower B from Purolator", a.conversationId);
    const v = await approvePlan(concierge, b.plan!.id);
    expect(v.steps[0].result).toMatchObject({ status: "executed", verified: true });
    const pkgId = v.steps[0].result!.record!.href.split("/").pop();
    await drainOutbox();
    expect(await count("select count(*) n from notifications where entity_id = $1 and user_id = $2", [pkgId, emma.principal.userId])).toBe(1);
  });

  it("an announcement is a full draft: edited, approved, then published to residents", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(pm, "Send residents of Fraser Towers a notice saying the pool will be closed tomorrow");
    const step = r.plan!.steps[0];
    expect(step).toMatchObject({ tool: "send_announcement", riskClass: 3, riskLabel: "Contacts people" });
    expect(step.draft!.body).toMatch(/^Hello residents,\n\nThe pool will be closed tomorrow \(\w+day, \w+ \d+\)\./);
    expect(step.effects.join(" ")).toMatch(/\d+ (person|people) who use the app get a notification/);
    // a redraft in another tone replaces the plan
    const friendlier = await ask(pm, "make it friendlier", r.conversationId);
    expect(friendlier.plan!.steps[0].draft!.body).toMatch(/^Hi neighbours,/);
    expect((await getPlanView(pm, r.plan!.id)).status).toBe("superseded");
    const edited = await reviseStep(pm, friendlier.plan!.id, "s1", { body: "Hi neighbours, the pool is closed tomorrow for cleaning. Thanks!" });
    expect(edited.steps[0].draft!.body).toBe("Hi neighbours, the pool is closed tomorrow for cleaning. Thanks!");
    const v = await approvePlan(pm, friendlier.plan!.id);
    expect(v.status).toBe("executed");
    const annId = v.steps[0].result!.record!.href.split("/").pop();
    const [ann] = await q("select status, body, audience from announcements where id = $1", [annId]);
    expect(ann).toEqual({ status: "published", body: "Hi neighbours, the pool is closed tomorrow for cleaning. Thanks!", audience: "residents" });
    await drainOutbox();
    expect(await count("select count(*) n from notifications where entity_id = $1 and user_id = $2", [annId, emma.principal.userId])).toBe(1);
  });

  it("identical steps in one turn are prepared once", async () => {
    const step = { name: "create_task", input: { title: "Check the roof drains", due: localDay(3) } };
    setChatModelForTests(new ScriptedModel([calls(step, step), say("Prepared.")]));
    const r = await ask(ns, "roof drains");
    expect(r.tools.map((t) => t.outcome)).toEqual(["pending", "pending"]);
    expect(r.plan!.steps).toHaveLength(1);
  });
});
