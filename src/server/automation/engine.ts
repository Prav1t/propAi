import "server-only";
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { withContext, type Tx } from "../db/client";
import { buildings, memberships, organizations, outboxEvents, properties, roles, users, vendors, workflowRuns, workflows } from "../db/schema";
import { can, ForbiddenError, NotFoundError } from "../authz/authorize";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { loadPrincipal } from "../modules/organizations/principal";
import { log } from "../log";
import { getEntitlements, loadEntitlements } from "../billing/entitlements";
import {
  actionSchema, conditionSchema, describeAction, describeCondition, describeSchedule, evaluateConditions, nextOccurrence, scheduleSchema,
  type NameBook, type Schedule, type Subject, type TriggerType, type WorkflowAction, type Condition, TRIGGERS,
} from "@/lib/automation";
import { loadSubject, SUBJECT_ID_KEY, subjectLabel } from "./subjects";
import { planAction, runAction, type ActionEnv, type RunStep } from "./actions";
import { membersWithRoleAt, names } from "./recipients";
import { z } from "zod";

// The automation engine (Iteration 9).
// • Consumes the transactional outbox a second time (automation_at), independently of notification delivery.
// • A rule runs at most once per event (unique workflow_id + event_id) and once per scheduled slot.
// • Loop protection: events raised by a rule's actions carry the run that caused them; a rule never fires on its own
//   events, chains stop after MAX_CHAIN_DEPTH hops, and a rule that runs more than MAX_RUNS_PER_HOUR times is paused.
// • Actions run with the rule owner's permissions, loaded fresh and re-checked on every run.

export const MAX_CHAIN_DEPTH = 3;
export const MAX_RUNS_PER_HOUR = 100;
const STALE_RUN_MINUTES = 15;

type Wf = typeof workflows.$inferSelect;
type Run = typeof workflowRuns.$inferSelect;

// which outbox events feed which triggers
export const TRIGGER_FOR_EVENT: Record<string, TriggerType> = {
  "workorder.created": "workorder.created", "workorder.status_changed": "workorder.status_changed", "workorder.assigned": "workorder.assigned",
  "workorder.sla_approaching": "workorder.sla_approaching", "workorder.sla_breached": "workorder.sla_breached", "complaint.created": "complaint.created",
  "incident.created": "incident.created", "inspection.failed": "inspection.failed", "booking.created": "booking.created", "package.arrived": "package.arrived",
  "document.uploaded": "document.uploaded",
};
export const EVENTS_FOR_TRIGGER = (t: TriggerType) => Object.entries(TRIGGER_FOR_EVENT).filter(([, v]) => v === t).map(([k]) => k);

export function parseRule(wf: Pick<Wf, "conditions" | "actions" | "schedule">) {
  const conditions = z.array(conditionSchema).safeParse(wf.conditions);
  const actions = z.array(actionSchema).safeParse(wf.actions);
  const schedule = wf.schedule ? scheduleSchema.safeParse(wf.schedule) : null;
  if (!conditions.success || !actions.success || (schedule && !schedule.success)) return null;
  return { conditions: conditions.data as Condition[], actions: actions.data as WorkflowAction[], schedule: (schedule?.data ?? null) as Schedule | null };
}

// ids → names for sentences and step labels (one small read per organization; sequential, since a transaction's
// connection runs one query at a time)
export async function loadNameBook(tx: Tx, orgId: string): Promise<NameBook> {
  const b = await tx.select({ id: buildings.id, name: buildings.name }).from(buildings).where(eq(buildings.orgId, orgId));
  const m = await tx.select({ id: memberships.id, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.orgId, orgId));
  const v = await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.orgId, orgId));
  const r = await tx.select({ key: roles.key, name: roles.name }).from(roles).where(sql`(${roles.orgId} is null or ${roles.orgId} = ${orgId})`);
  const p = await tx.select({ id: properties.id, name: properties.name }).from(properties).where(eq(properties.orgId, orgId));
  const map = (rows: { id: string; name: string }[]) => Object.fromEntries(rows.map((x) => [x.id, x.name]));
  return { buildings: map(b), members: map(m), vendors: map(v), roles: Object.fromEntries(r.map((x) => [x.key, x.name])), properties: map(p) };
}

const initialSteps = (actions: WorkflowAction[], n: NameBook): RunStep[] =>
  actions.map((action, index) => ({ index, type: action.type, label: describeAction(action, n), status: "pending", action }));

/* ───────────── event-triggered runs ───────────── */

let consuming: Promise<number> | null = null;

// evaluates pending outbox events against enabled rules; coalesced like the notification drain
export function processAutomationEvents(limit = 100): Promise<number> {
  consuming ??= (async () => {
    let started = 0;
    try {
      const pending = await withContext({ system: true }, (tx) => tx.select({ id: outboxEvents.id, orgId: outboxEvents.orgId }).from(outboxEvents)
        .where(isNull(outboxEvents.automationAt)).orderBy(asc(outboxEvents.createdAt)).limit(limit));
      for (const ev of pending) {
        let created: Run[] = [];
        try {
          created = await withContext({ orgId: ev.orgId, system: true }, (tx) => matchEvent(tx, ev.id));
        } catch (err) {
          log.error("automation.match_failed", { eventId: ev.id, err });
          await withContext({ orgId: ev.orgId, system: true }, (tx) => tx.update(outboxEvents).set({ automationAt: new Date() }).where(eq(outboxEvents.id, ev.id))).catch(() => {});
        }
        for (const run of created) {
          await executeRun(run.id);
          started++;
        }
      }
    } finally {
      consuming = null;
    }
    return started;
  })();
  return consuming;
}

// in one transaction: claim the event, decide which rules match, create their runs (the decision and the claim commit together)
async function matchEvent(tx: Tx, eventId: string): Promise<Run[]> {
  const claimed = await tx.execute(sql`select id from outbox_events where id = ${eventId} and automation_at is null for update skip locked`);
  if (!claimed.rows.length) return [];
  const [e] = await tx.select().from(outboxEvents).where(eq(outboxEvents.id, eventId));
  await tx.update(outboxEvents).set({ automationAt: new Date() }).where(eq(outboxEvents.id, eventId));
  const trigger = TRIGGER_FOR_EVENT[e.type];
  if (!trigger) return [];
  if (e.chainDepth >= MAX_CHAIN_DEPTH) {
    log.warn("automation.chain_limit", { eventId, type: e.type, depth: e.chainDepth, causedByWorkflowId: e.causedByWorkflowId });
    return [];
  }
  const rules = await tx.select().from(workflows).where(and(eq(workflows.orgId, e.orgId), eq(workflows.enabled, true), eq(workflows.triggerType, trigger)));
  if (!rules.length) return [];
  // the plan must include automation and the organization must not be read-only (Iteration 10)
  const ent = await loadEntitlements(tx, e.orgId);
  if (!ent.features.automation || ent.readOnly) return [];
  const subject = await loadSubject(tx, trigger, e.payload as Record<string, unknown>);
  if (!subject) return [];
  const names = await loadNameBook(tx, e.orgId);
  const out: Run[] = [];
  for (const wf of rules) {
    if (wf.id === e.causedByWorkflowId) continue; // a rule never fires on events its own actions raised
    if (wf.propertyId && wf.propertyId !== subject.propertyId) continue;
    const rule = parseRule(wf);
    if (!rule) { log.warn("automation.invalid_rule", { workflowId: wf.id }); continue; }
    if (!evaluateConditions(trigger, rule.conditions, subject).ok) continue;
    if (await pauseIfRunaway(tx, wf)) continue;
    const [run] = await tx.insert(workflowRuns).values({
      orgId: e.orgId, workflowId: wf.id, workflowVersion: wf.version, eventId: e.id, triggerType: trigger, entityType: subject.type, entityId: subject.id,
      entityLabel: subjectLabel(subject), propertyId: subject.propertyId, depth: e.chainDepth, steps: initialSteps(rule.actions, names),
    }).onConflictDoNothing().returning();
    if (!run) continue;
    await tx.update(workflows).set({ lastRunAt: new Date(), runCount: sql`${workflows.runCount} + 1` }).where(eq(workflows.id, wf.id));
    out.push(run);
  }
  return out;
}

async function pauseIfRunaway(tx: Tx, wf: Wf): Promise<boolean> {
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(workflowRuns).where(and(eq(workflowRuns.workflowId, wf.id), gte(workflowRuns.createdAt, new Date(Date.now() - 3_600_000))));
  if (n < MAX_RUNS_PER_HOUR) return false;
  await tx.update(workflows).set({ enabled: false, pausedReason: `Paused automatically: it ran ${n} times in the last hour. Check its conditions, then turn it back on.` }).where(eq(workflows.id, wf.id));
  log.warn("automation.paused_runaway", { workflowId: wf.id, runsLastHour: n });
  return true;
}

/* ───────────── scheduled runs ───────────── */

// one run per due slot; a server that was down for a while runs the latest missed slot once, not every missed one
export async function runDueSchedules(now = new Date(), limit = 20): Promise<number> {
  const due = await withContext({ system: true }, (tx) => tx.select({ id: workflows.id, orgId: workflows.orgId }).from(workflows)
    .where(and(eq(workflows.enabled, true), eq(workflows.triggerType, "schedule"), lte(workflows.nextRunAt, now))).limit(limit));
  let n = 0;
  for (const d of due) {
    const run = await withContext({ orgId: d.orgId, system: true }, async (tx) => {
      const locked = await tx.execute(sql`select id from workflows where id = ${d.id} and enabled and next_run_at <= ${now} for update skip locked`);
      if (!locked.rows.length) return null;
      const [wf] = await tx.select().from(workflows).where(eq(workflows.id, d.id));
      const [org] = await tx.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, wf.orgId));
      const rule = parseRule(wf);
      if (!rule?.schedule) { await tx.update(workflows).set({ nextRunAt: null }).where(eq(workflows.id, wf.id)); return null; }
      const next = nextOccurrence(rule.schedule, org.tz, now);
      const ent = await loadEntitlements(tx, wf.orgId);
      if (!ent.features.automation || ent.readOnly) { await tx.update(workflows).set({ nextRunAt: next }).where(eq(workflows.id, wf.id)); return null; }
      if (await pauseIfRunaway(tx, wf)) return null;
      const [r] = await tx.insert(workflowRuns).values({
        orgId: wf.orgId, workflowId: wf.id, workflowVersion: wf.version, scheduledFor: wf.nextRunAt, triggerType: "schedule",
        entityLabel: describeSchedule(rule.schedule), propertyId: wf.propertyId, steps: initialSteps(rule.actions, await loadNameBook(tx, wf.orgId)),
      }).onConflictDoNothing().returning();
      await tx.update(workflows).set({ nextRunAt: next, ...(r ? { lastRunAt: now, runCount: sql`${workflows.runCount} + 1` } : {}) }).where(eq(workflows.id, wf.id));
      return r ?? null;
    });
    if (run) { await executeRun(run.id, now); n++; }
  }
  return n;
}

/* ───────────── execution ───────────── */

const friendly = (e: unknown): string => {
  if (e instanceof ValidationError || e instanceof ForbiddenError) return e.message;
  if (e instanceof NotFoundError) return "The record no longer exists, or the rule's owner can't see it.";
  if (e instanceof Error && e.message && e.message.length < 200 && !/sql|relation|column|syntax/i.test(e.message)) return e.message;
  return "Something went wrong running this step.";
};

async function saveRun(orgId: string, id: string, patch: Partial<Run>) {
  await withContext({ orgId, system: true }, (tx) => tx.update(workflowRuns).set(patch).where(eq(workflowRuns.id, id)));
}

// runs the pending steps of a run in order, as the rule's owner; stops at an approval step or the first failure
export async function executeRun(runId: string, now = new Date()): Promise<Run | null> {
  const [head] = await withContext({ system: true }, (tx) => tx.select({ orgId: workflowRuns.orgId }).from(workflowRuns).where(eq(workflowRuns.id, runId)));
  if (!head) return null;
  const loaded = await withContext({ orgId: head.orgId, system: true }, async (tx) => {
    const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    if (!run) return null;
    const [wf] = await tx.select().from(workflows).where(eq(workflows.id, run.workflowId));
    const [org] = await tx.select({ slug: organizations.slug, tz: organizations.timezone, status: organizations.status }).from(organizations).where(eq(organizations.id, run.orgId));
    return { run, wf, org };
  });
  if (!loaded || loaded.run.status !== "running") return loaded?.run ?? null;
  const { run, wf, org } = loaded;
  const steps = (run.steps as RunStep[]).map((s) => ({ ...s }));
  const fail = async (error: string, at?: number) => {
    steps.forEach((s, i) => { if (s.status === "pending") { s.status = "skipped"; s.summary = at !== undefined && i > at ? "Not run because an earlier step failed." : "Not run."; } });
    await saveRun(run.orgId, run.id, { status: "failed", error, steps, finishedAt: new Date() });
    log.warn("automation.run_failed", { runId, workflowId: run.workflowId, error });
    return { ...run, status: "failed", error, steps } as Run;
  };
  if (org.status !== "active") return fail("The organization is suspended.");
  const ent = await getEntitlements(run.orgId, now);
  if (!ent.features.automation) return fail(`Automation rules aren't included in the ${ent.plan.name} plan.`);
  if (ent.readOnly) return fail(ent.access.reason ?? "The organization is read-only.");

  // the owner's permissions, loaded now (not when the rule was written)
  const owner = wf.ownerUserId ? await loadPrincipal(wf.ownerUserId, org.slug) : null;
  if (!owner || !can(owner, "automation.manage", wf.propertyId ? { orgId: run.orgId, propertyId: wf.propertyId } : undefined) || (!wf.propertyId && owner.role.scopeLevel !== "org")) {
    return fail("The rule's owner no longer has permission to run it. Someone who manages automation for this property needs to open the rule and save it again.");
  }
  const ctx: TenantCtx = { principal: owner, meta: null, automation: { workflowId: wf.id, runId: run.id, depth: run.depth } };
  const subject: Subject | null = run.entityType && run.entityId
    ? await tenantTx(ctx, (tx) => loadSubject(tx, run.triggerType as TriggerType, { [SUBJECT_ID_KEY[run.entityType as keyof typeof SUBJECT_ID_KEY]]: run.entityId }))
    : null;
  if (run.entityId && !subject) return fail("The record that triggered this rule no longer exists.");
  const env: ActionEnv = { ctx, orgSlug: org.slug, wf: { id: wf.id, name: wf.name, propertyId: wf.propertyId }, subject, tz: org.tz, now };

  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.status !== "pending") continue;
    if (st.action.type === "request_approval") {
      const approvers = await tenantTx(ctx, (tx) => membersWithRoleAt(tx, run.orgId, [(st.action as { role: string }).role], run.propertyId ?? wf.propertyId, subject?.buildingId ?? null));
      if (!approvers.length) { st.status = "failed"; st.error = "Nobody with that role covers this property, so nobody can approve."; return fail(st.error, i); }
      st.status = "waiting";
      st.summary = `Waiting for ${names(approvers)}.`;
      st.at = new Date().toISOString();
      const note = (st.action as { note?: string }).note;
      await saveRun(run.orgId, run.id, { status: "waiting_approval", steps, approvalRole: (st.action as { role: string }).role, approvalStep: i, approvalRequestedAt: new Date() });
      await tenantTx(ctx, (tx) => tx.insert(outboxEvents).values({
        orgId: run.orgId, type: "workflow.notify", actorUserId: null, automationAt: new Date(), causedByRunId: run.id, causedByWorkflowId: wf.id, chainDepth: run.depth + 1,
        payload: { userIds: approvers.map((a) => a.userId), kind: "workflow.approval", title: `Approval needed: ${wf.name}`, body: [run.entityLabel, note].filter(Boolean).join(" — ") || null, href: `/automations/runs/${run.id}`, entityType: "workflow_run", entityId: run.id, runId: run.id },
      }));
      return { ...run, status: "waiting_approval", steps } as Run;
    }
    try {
      const r = await runAction(st.action, env);
      st.status = r.status;
      st.summary = r.summary;
      if (r.record) st.record = r.record;
    } catch (e) {
      st.status = "failed";
      st.error = friendly(e);
      if (!(e instanceof ValidationError || e instanceof ForbiddenError || e instanceof NotFoundError)) log.error("automation.step_error", { runId, step: i, type: st.type, err: e });
      st.at = new Date().toISOString();
      return fail(`Step ${i + 1} failed: ${st.error}`, i);
    }
    st.at = new Date().toISOString();
    await saveRun(run.orgId, run.id, { steps });
  }
  await saveRun(run.orgId, run.id, { status: "completed", steps, finishedAt: new Date() });
  return { ...run, status: "completed", steps } as Run;
}

/* ───────────── approvals ───────────── */

export async function isApprover(tx: Tx, p: TenantCtx["principal"], run: Pick<Run, "orgId" | "status" | "approvalRole" | "propertyId">, buildingId: string | null = null) {
  if (run.status !== "waiting_approval" || !run.approvalRole || p.role.key !== run.approvalRole) return false;
  const people = await membersWithRoleAt(tx, run.orgId, [run.approvalRole], run.propertyId, buildingId);
  return people.some((x) => x.userId === p.userId);
}

// approve → the remaining steps run now (as the rule's owner); decline → they're skipped
export async function decideRun(ctx: TenantCtx, runId: string, decision: "approve" | "decline", note: string | null) {
  const p = ctx.principal;
  const decided = await tenantTx(ctx, async (tx) => {
    const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.orgId, p.orgId)));
    if (!run) throw new NotFoundError();
    if (run.status !== "waiting_approval") throw new ValidationError("This run isn't waiting for approval any more.");
    if (!(await isApprover(tx, p, run))) {
      // automation managers who can see the run are told who decides; anyone else learns nothing about it
      if (!p.permissions.has("automation.manage")) throw new NotFoundError();
      throw new ForbiddenError(`Only a ${run.approvalRole?.replace(/_/g, " ")} for this property can decide.`);
    }
    const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, p.userId));
    const steps = (run.steps as RunStep[]).map((s) => ({ ...s }));
    const st = steps[run.approvalStep ?? -1];
    if (st) { st.status = "done"; st.summary = `${decision === "approve" ? "Approved" : "Declined"} by ${me?.name ?? "a manager"}${note ? `: “${note}”` : "."}`; st.at = new Date().toISOString(); }
    if (decision === "decline") steps.forEach((s) => { if (s.status === "pending") { s.status = "skipped"; s.summary = "Not run — approval was declined."; } });
    const [updated] = await tx.update(workflowRuns).set({
      status: decision === "approve" ? "running" : "rejected", steps, decidedByUserId: p.userId, decidedAt: new Date(), decisionNote: note,
      ...(decision === "decline" ? { finishedAt: new Date() } : {}),
    }).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.status, "waiting_approval"))).returning();
    if (!updated) throw new ValidationError("Someone else decided first.");
    await auditAs(tx, ctx, decision === "approve" ? "automation.approved" : "automation.declined", "workflow_run", runId, undefined, { workflowId: run.workflowId, note });
    return updated;
  });
  return decision === "approve" ? (await executeRun(decided.id)) ?? decided : decided;
}

// runs left "running" by a crash are closed so they don't look stuck forever
export async function sweepStaleRuns(now = new Date()): Promise<number> {
  const stale = await withContext({ system: true }, (tx) => tx.select({ id: workflowRuns.id, orgId: workflowRuns.orgId }).from(workflowRuns)
    .where(and(eq(workflowRuns.status, "running"), sql`coalesce(${workflowRuns.decidedAt}, ${workflowRuns.startedAt}) < ${new Date(now.getTime() - STALE_RUN_MINUTES * 60_000)}`)).limit(200));
  for (const r of stale) {
    await withContext({ orgId: r.orgId, system: true }, (tx) => tx.update(workflowRuns)
      .set({ status: "failed", error: "Interrupted before it finished (the server restarted). Steps marked done did happen.", finishedAt: now })
      .where(and(eq(workflowRuns.id, r.id), eq(workflowRuns.status, "running"))));
  }
  return stale.length;
}

/* ───────────── dry run ───────────── */

export type DryRun = { matched: boolean; reason?: string; subjectLabel: string | null; steps: { label: string; outcome: string; afterApproval: boolean }[] };

// what the rule would do for a past event (or right now, for schedules) — reads only, nothing is written
export async function dryRunRule(ctx: TenantCtx, rule: { name: string; propertyId: string | null; trigger: TriggerType; conditions: Condition[]; actions: WorkflowAction[] }, eventId: string | null): Promise<DryRun> {
  const p = ctx.principal;
  const tz = p.orgTimezone ?? "UTC";
  let subject: Subject | null = null;
  if (rule.trigger !== "schedule") {
    if (!eventId) throw new ValidationError("Pick a past event to test against.");
    const e = await tenantTx(ctx, async (tx) => (await tx.select().from(outboxEvents).where(and(eq(outboxEvents.id, eventId), eq(outboxEvents.orgId, p.orgId), inArray(outboxEvents.type, EVENTS_FOR_TRIGGER(rule.trigger)))))[0]);
    if (!e) throw new NotFoundError("That event isn't available.");
    subject = await tenantTx(ctx, (tx) => loadSubject(tx, rule.trigger, e.payload as Record<string, unknown>));
    if (!subject) return { matched: false, reason: "The record behind that event no longer exists.", subjectLabel: null, steps: [] };
    if (!canSeeSubject(ctx, subject)) throw new NotFoundError("That event isn't available.");
    if (rule.propertyId && subject.propertyId !== rule.propertyId) return { matched: false, reason: "It happened at a different property, so this rule wouldn't run.", subjectLabel: subjectLabel(subject), steps: [] };
    const n = await tenantTx(ctx, (tx) => loadNameBook(tx, p.orgId));
    const ev = evaluateConditions(rule.trigger, rule.conditions, subject);
    if (!ev.ok) return { matched: false, reason: `It wouldn't run: the condition “${describeCondition(rule.trigger, ev.failed, n)}” isn't met.`, subjectLabel: subjectLabel(subject), steps: [] };
  }
  const env: ActionEnv = { ctx, orgSlug: p.orgSlug, wf: { id: "00000000-0000-0000-0000-000000000000", name: rule.name || "This rule", propertyId: rule.propertyId }, subject, tz, now: new Date() };
  const n = await tenantTx(ctx, (tx) => loadNameBook(tx, p.orgId));
  const steps: DryRun["steps"] = [];
  let afterApproval = false;
  for (const a of rule.actions) {
    let outcome: string;
    try { outcome = await planAction(a, env); } catch (e) { outcome = `Would fail: ${friendly(e)}`; }
    steps.push({ label: describeAction(a, n), outcome, afterApproval });
    if (a.type === "request_approval") afterApproval = true;
  }
  return { matched: true, subjectLabel: subject ? subjectLabel(subject) : TRIGGERS.schedule.label, steps };
}

// the tester only sees events about records they could open themselves
function canSeeSubject(ctx: TenantCtx, s: Subject): boolean {
  const p = ctx.principal;
  const perm = ({ work_order: "workorder.read", complaint: "complaint.read", incident: "incident.read", inspection: "inspection.read", booking: "booking.manage", package: "package.manage", document: "document.read" } as const)[s.type];
  return can(p, perm, { orgId: p.orgId, propertyId: s.propertyId, buildingId: s.buildingId });
}
