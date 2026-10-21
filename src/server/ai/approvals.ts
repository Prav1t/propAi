import "server-only";
import { loadEntitlements } from "../billing/entitlements";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { aiApprovals, aiConversations, aiToolCalls, organizations, users } from "../db/schema";
import type { Tx } from "../db/client";
import { ForbiddenError, NotFoundError } from "../authz/authorize";
import { ConflictError, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { writeAudit } from "../audit";
import { log as logger } from "../log";
import { readAiSettings } from "./usage";
import { loadPolicyRules } from "./policies";
import { confirmFor, decide, RISK_LABEL, type Confirm, type PolicyKey, type RiskClass } from "./policy";
import { toolByName } from "./tools";
import { isAction, makeToolEnv, type ActionDef, type ActionOutcome, type EditableField, type PreparedStep, type ToolEnv } from "./tools/registry";
import type { ToolName } from "./tools/names";

// A plan is the set of changes the assistant prepared in one turn. Nothing in it runs until the person who asked
// approves it (or an organization policy lets a low-risk step run on its own). Plans expire after a day.

export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
export const TYPED_CONFIRMATION = "CONFIRM";

export type PlanStep = {
  id: string; // "s1", "s2" … within the plan
  callId: string; // the model's tool call that prepared it
  tool: ToolName;
  riskClass: RiskClass;
  policyKeys: PolicyKey[];
  propertyId: string | null;
  input: Record<string, unknown>; // validated tool arguments (what an edit changes)
  resolved: Record<string, unknown>; // ids and values execute() uses
  title: string;
  details: string[];
  effects: string[];
  draft?: { title?: string; body: string };
};

export type StepResult = {
  stepId: string;
  status: "executed" | "failed" | "skipped";
  summary: string;
  record?: { ref: string; title: string; href: string };
  verified?: boolean;
  check?: string; // what verification found
  warning?: string;
};

export type PlanStatus = (typeof aiApprovals.$inferSelect)["status"];
type PlanRow = typeof aiApprovals.$inferSelect;

export type PlanView = {
  id: string;
  turnId: string;
  conversationId: string | null;
  status: string; // pending | executing | executed | failed | partially_failed | rejected | expired | superseded
  mode: "confirm" | "auto";
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  confirm: Confirm;
  canDecide: boolean; // pending, not expired, and the viewer asked for it
  steps: {
    id: string; tool: string; title: string; details: string[]; effects: string[]; draft: { title?: string; body: string } | null;
    riskClass: RiskClass; riskLabel: string;
    editable: (EditableField & { value: string })[];
    result: StepResult | null;
  }[];
};

const stepsOf = (row: PlanRow) => (row.steps as PlanStep[]) ?? [];
const resultsOf = (row: PlanRow) => (row.results as StepResult[] | null) ?? [];
const strictest = (steps: PlanStep[]): Confirm => confirmFor(Math.max(2, ...steps.map((s) => s.riskClass)) as RiskClass);
const isExpired = (row: PlanRow, now = new Date()) => row.status === "pending" && row.expiresAt.getTime() <= now.getTime();

export function stepFromPrepared(def: ActionDef, callId: string, input: Record<string, unknown>, riskClass: RiskClass, policyKeys: PolicyKey[], s: PreparedStep, n: number): PlanStep {
  return {
    id: `s${n}`, callId, tool: def.name, riskClass, policyKeys, propertyId: s.propertyId, input, resolved: s.resolved,
    title: s.title, details: s.details.filter(Boolean), effects: s.effects, ...(s.draft ? { draft: s.draft } : {}),
  };
}

function toView(row: PlanRow, viewerId: string, names: Map<string, string>, now = new Date()): PlanView {
  const steps = stepsOf(row);
  const results = resultsOf(row);
  const expired = isExpired(row, now);
  const canDecide = row.status === "pending" && !expired && row.requestedByUserId === viewerId;
  return {
    id: row.id, turnId: row.turnId, conversationId: row.conversationId, status: expired ? "expired" : row.status, mode: row.mode as "confirm" | "auto",
    createdAt: row.createdAt, expiresAt: row.expiresAt, decidedAt: row.decidedAt, decidedBy: row.decidedByUserId ? names.get(row.decidedByUserId) ?? null : null,
    confirm: strictest(steps), canDecide,
    steps: steps.map((s) => {
      const def = toolByName(s.tool);
      const editable = canDecide && def && isAction(def) ? def.editable.map((f) => ({ ...f, value: s.input[f.key] === undefined || s.input[f.key] === null ? "" : String(s.input[f.key]) })) : [];
      return {
        id: s.id, tool: s.tool, title: s.title, details: s.details, effects: s.effects, draft: s.draft ?? null,
        riskClass: s.riskClass, riskLabel: RISK_LABEL[s.riskClass], editable, result: results.find((r) => r.stepId === s.id) ?? null,
      };
    }),
  };
}

async function namesFor(tx: Tx, rows: PlanRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.decidedByUserId).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const found = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.name]));
}

/* ───────────── creating plans (called by the orchestrator) ───────────── */

// one plan per turn; an older pending plan in the same conversation is superseded so only the latest can be approved
export async function createPlan(tx: Tx, ctx: TenantCtx, input: { conversationId: string; turnId: string; steps: PlanStep[] }): Promise<PlanRow> {
  const p = ctx.principal;
  await tx.update(aiApprovals).set({ status: "superseded" })
    .where(and(eq(aiApprovals.orgId, p.orgId), eq(aiApprovals.conversationId, input.conversationId), eq(aiApprovals.requestedByUserId, p.userId), eq(aiApprovals.status, "pending")));
  const [row] = await tx.insert(aiApprovals).values({
    orgId: p.orgId, conversationId: input.conversationId, turnId: input.turnId, requestedByUserId: p.userId, mode: "confirm", status: "pending",
    steps: input.steps, expiresAt: new Date(Date.now() + PLAN_TTL_MS),
  }).returning();
  await writeAudit(tx, {
    orgId: p.orgId, actorUserId: p.userId, action: "ai.plan.prepared", entityType: "ai_approval", entityId: row.id,
    after: { steps: input.steps.map((s) => ({ tool: s.tool, title: s.title, riskClass: s.riskClass })) }, aiGenerated: true, approvalId: row.id,
  }, ctx.meta);
  return row;
}

export function planViewOf(row: PlanRow, ctx: TenantCtx): PlanView {
  return toView(row, ctx.principal.userId, new Map());
}

/* ───────────── running steps ───────────── */

function failureMessage(e: unknown): string {
  if (e instanceof ValidationError || e instanceof ConflictError) return e.message || "That's no longer possible.";
  if (e instanceof ForbiddenError) return "You don't have permission to do this any more.";
  if (e instanceof NotFoundError) return "Something this step needs no longer exists or isn't visible to you.";
  logger.error("ai.action_failed", { error: e instanceof Error ? e.message : String(e) });
  return "Something went wrong, so this step wasn't completed.";
}

// steps run one at a time through the same domain services as the UI, as the approving user, with ctx.ai set so
// every audit row they write is marked AI-generated and points at this plan; the first failure stops the rest
async function runSteps(ctx: TenantCtx, planId: string, steps: PlanStep[], env: ToolEnv): Promise<StepResult[]> {
  const actx: TenantCtx = { ...ctx, ai: { approvalId: planId } };
  const results: StepResult[] = [];
  let stopped = false;
  for (const s of steps) {
    if (stopped) {
      results.push({ stepId: s.id, status: "skipped", summary: "Not run because an earlier step failed." });
      continue;
    }
    const def = toolByName(s.tool);
    if (!def || !isAction(def)) {
      results.push({ stepId: s.id, status: "failed", summary: "This kind of action is no longer available." });
      stopped = true;
      continue;
    }
    let out: ActionOutcome;
    try {
      out = await def.execute(actx, s.resolved, env);
    } catch (e) {
      results.push({ stepId: s.id, status: "failed", summary: failureMessage(e) });
      stopped = true;
      continue;
    }
    let verified = false;
    let check = "";
    try {
      const v = await def.verify(actx, out, s.resolved, env);
      verified = v.ok;
      check = v.summary;
    } catch (e) {
      check = `Couldn't re-read the result: ${failureMessage(e)}`;
    }
    results.push({ stepId: s.id, status: "executed", summary: out.summary, record: out.record, verified, check, ...(out.warning ? { warning: out.warning } : {}) });
  }
  return results;
}

const overall = (results: StepResult[]): PlanStatus => {
  const done = results.filter((r) => r.status === "executed");
  if (!done.length) return "failed";
  return done.length === results.length && !results.some((r) => r.warning) ? "executed" : "partially_failed";
};

// tool-call log rows for executed steps, linked to the plan (the prepared rows stay as they were logged)
async function logExecution(tx: Tx, ctx: TenantCtx, row: PlanRow, results: StepResult[], startedAt: number) {
  const steps = stepsOf(row);
  const rows = results.filter((r) => r.status !== "skipped").map((r) => {
    const s = steps.find((x) => x.id === r.stepId)!;
    return {
      orgId: row.orgId, userId: ctx.principal.userId, conversationId: row.conversationId, turnId: row.turnId, callId: `${s.callId}:run`, tool: s.tool, riskClass: s.riskClass,
      args: s.input, outcome: r.status === "executed" ? "executed" : "error", errorMessage: r.status === "failed" ? r.summary.slice(0, 500) : r.warning?.slice(0, 500) ?? null,
      summary: r.summary.slice(0, 500), display: r.record ? { records: [{ ref: r.record.ref, title: r.record.title, href: r.record.href }] } : null,
      durationMs: Date.now() - startedAt, approvalId: row.id,
    };
  });
  if (rows.length) await tx.insert(aiToolCalls).values(rows);
}

/* ───────────── auto-run (policy says the assistant may do it without asking) ───────────── */

export async function runAutoStep(ctx: TenantCtx, input: { conversationId: string; turnId: string; step: PlanStep }, env: ToolEnv): Promise<{ planId: string; result: StepResult }> {
  const p = ctx.principal;
  const row = await tenantTx(ctx, async (tx) => {
    const [r] = await tx.insert(aiApprovals).values({
      orgId: p.orgId, conversationId: input.conversationId, turnId: input.turnId, requestedByUserId: p.userId, mode: "auto", status: "executing",
      steps: [input.step], decidedAt: new Date(), expiresAt: new Date(Date.now() + PLAN_TTL_MS),
    }).returning();
    return r;
  });
  const [result] = await runSteps(ctx, row.id, [input.step], env);
  await tenantTx(ctx, async (tx) => {
    await tx.update(aiApprovals).set({ status: overall([result]), results: [result], executedAt: new Date() }).where(eq(aiApprovals.id, row.id));
    await writeAudit(tx, {
      orgId: p.orgId, actorUserId: p.userId, action: "ai.plan.auto_executed", entityType: "ai_approval", entityId: row.id,
      after: { tool: input.step.tool, title: input.step.title, status: result.status, summary: result.summary, policy: "auto" }, aiGenerated: true, approvalId: row.id,
    }, ctx.meta);
  });
  return { planId: row.id, result };
}

/* ───────────── decisions ───────────── */

async function lockOwnPlan(tx: Tx, ctx: TenantCtx, id: string): Promise<PlanRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
  // only the person who asked can decide; nobody else sees a way to approve it
  const [row] = await tx.select().from(aiApprovals)
    .where(and(eq(aiApprovals.id, id), eq(aiApprovals.orgId, ctx.principal.orgId), eq(aiApprovals.requestedByUserId, ctx.principal.userId), eq(aiApprovals.mode, "confirm")))
    .for("update");
  if (!row) throw new NotFoundError();
  return row;
}

function assertPending(row: PlanRow) {
  if (row.status === "pending") return;
  const what: Record<string, string> = {
    executing: "This plan is already running.", executed: "This plan was already approved and carried out.", failed: "This plan already ran.",
    partially_failed: "This plan already ran.", rejected: "This plan was cancelled.", expired: "This plan has expired. Ask again to prepare a fresh one.",
    superseded: "A newer plan replaced this one.",
  };
  throw new ConflictError(what[row.status] ?? "This plan can't be changed now.");
}

export type ApproveInput = { acknowledge?: boolean; typed?: string };

export async function approvePlan(ctx: TenantCtx, id: string, input: ApproveInput = {}): Promise<PlanView> {
  const p = ctx.principal;
  if (!p.permissions.has("ai.use")) throw new ForbiddenError();
  const t0 = Date.now();

  // 1. lock, check it's still pending and in date, re-authorize every step against the current role and policies
  const gate = await tenantTx(ctx, async (tx) => {
    const row = await lockOwnPlan(tx, ctx, id);
    if (isExpired(row)) {
      await tx.update(aiApprovals).set({ status: "expired" }).where(eq(aiApprovals.id, row.id));
      return { row: { ...row, status: "expired" }, expired: true as const };
    }
    assertPending(row);
    const steps = stepsOf(row);
    const need = strictest(steps);
    if (need === "acknowledge" && !input.acknowledge) throw new ValidationError("Tick the box to confirm you understand the impact.", "acknowledge");
    if (need === "typed" && (input.typed ?? "").trim().toUpperCase() !== TYPED_CONFIRMATION) throw new ValidationError(`Type ${TYPED_CONFIRMATION} to approve.`, "typed");

    const [org] = await tx.select({ timezone: organizations.timezone, settings: organizations.settings }).from(organizations).where(eq(organizations.id, p.orgId));
    const rules = await loadPolicyRules(tx, p.orgId);
    let blocked: { stepId: string; why: string } | null = null;
    if (!readAiSettings(org.settings).enabled) blocked = { stepId: steps[0]?.id ?? "s1", why: "The assistant has been switched off for your organization." };
    const ent = await loadEntitlements(tx, p.orgId);
    if (!blocked && ent.readOnly) blocked = { stepId: steps[0]?.id ?? "s1", why: ent.access.reason ?? "Changes are paused for your organization." };
    for (const s of steps) {
      if (blocked) break;
      const def = toolByName(s.tool);
      if (!def || !isAction(def) || !def.available(p)) blocked = { stepId: s.id, why: "You don't have permission to do this any more." };
      else if (decide({ riskClass: s.riskClass, keys: s.policyKeys, propertyId: s.propertyId, rules }).mode === "deny") {
        blocked = { stepId: s.id, why: "An administrator has since stopped the assistant from doing this." };
      }
    }
    const now = new Date();
    await writeAudit(tx, {
      orgId: p.orgId, actorUserId: p.userId, action: "ai.plan.approved", entityType: "ai_approval", entityId: row.id,
      after: { steps: steps.map((s) => s.title), confirmation: need, ...(blocked ? { blocked: blocked.why } : {}) }, approvalId: row.id,
    }, ctx.meta);
    if (blocked) {
      const results: StepResult[] = steps.map((s) => (s.id === blocked!.stepId ? { stepId: s.id, status: "failed", summary: blocked!.why } : { stepId: s.id, status: "skipped", summary: "Not run." }));
      const [upd] = await tx.update(aiApprovals).set({ status: "failed", results, decidedByUserId: p.userId, decidedAt: now, executedAt: now }).where(eq(aiApprovals.id, row.id)).returning();
      return { row: upd, expired: false as const, blocked: true as const, tz: org.timezone };
    }
    const [upd] = await tx.update(aiApprovals).set({ status: "executing", decidedByUserId: p.userId, decidedAt: now }).where(eq(aiApprovals.id, row.id)).returning();
    return { row: upd, expired: false as const, blocked: false as const, tz: org.timezone };
  });
  if (gate.expired) throw new ConflictError("This plan has expired. Ask again to prepare a fresh one.");
  if (gate.blocked) return getPlanView(ctx, id);

  // 2. run the steps (each through its own domain transaction), then verify
  const env = makeToolEnv(p.orgSlug, gate.tz);
  let results: StepResult[];
  try {
    results = await runSteps(ctx, gate.row.id, stepsOf(gate.row), env);
  } catch (e) {
    results = stepsOf(gate.row).map((s, i) => ({ stepId: s.id, status: i === 0 ? "failed" : "skipped", summary: i === 0 ? failureMessage(e) : "Not run." }));
  }

  // 3. record the outcome
  await tenantTx(ctx, async (tx) => {
    const status = overall(results);
    await tx.update(aiApprovals).set({ status, results, executedAt: new Date() }).where(eq(aiApprovals.id, gate.row.id));
    await logExecution(tx, ctx, gate.row, results, t0);
    if (gate.row.conversationId) await tx.update(aiConversations).set({ lastMessageAt: new Date() }).where(eq(aiConversations.id, gate.row.conversationId));
    await writeAudit(tx, {
      orgId: p.orgId, actorUserId: p.userId, action: "ai.plan.executed", entityType: "ai_approval", entityId: gate.row.id,
      after: { status, results: results.map((r) => ({ step: r.stepId, status: r.status, summary: r.summary, verified: r.verified ?? null })) }, aiGenerated: true, approvalId: gate.row.id,
    }, ctx.meta);
  });
  return getPlanView(ctx, id);
}

export async function rejectPlan(ctx: TenantCtx, id: string): Promise<PlanView> {
  const p = ctx.principal;
  await tenantTx(ctx, async (tx) => {
    const row = await lockOwnPlan(tx, ctx, id);
    if (isExpired(row)) throw new ConflictError("This plan has already expired; nothing will run.");
    assertPending(row);
    await tx.update(aiApprovals).set({ status: "rejected", decidedByUserId: p.userId, decidedAt: new Date() }).where(eq(aiApprovals.id, row.id));
    await writeAudit(tx, {
      orgId: p.orgId, actorUserId: p.userId, action: "ai.plan.rejected", entityType: "ai_approval", entityId: row.id,
      after: { steps: stepsOf(row).map((s) => s.title) }, approvalId: row.id,
    }, ctx.meta);
  });
  return getPlanView(ctx, id);
}

// change a prepared step's editable fields; the step is re-validated and re-prepared with the same rules
export async function reviseStep(ctx: TenantCtx, id: string, stepId: string, edits: Record<string, string>): Promise<PlanView> {
  const p = ctx.principal;
  const { row, tz } = await tenantTx(ctx, async (tx) => {
    const r = await lockOwnPlan(tx, ctx, id);
    if (isExpired(r)) throw new ConflictError("This plan has expired. Ask again to prepare a fresh one.");
    assertPending(r);
    const [org] = await tx.select({ timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, p.orgId));
    return { row: r, tz: org.timezone };
  });
  const steps = stepsOf(row);
  const step = steps.find((s) => s.id === stepId);
  if (!step) throw new NotFoundError();
  const def = toolByName(step.tool);
  if (!def || !isAction(def) || !def.available(p)) throw new ForbiddenError();

  const next: Record<string, unknown> = { ...step.input };
  for (const f of def.editable) {
    if (!(f.key in edits)) continue;
    const raw = String(edits[f.key] ?? "").trim();
    if (!raw) delete next[f.key];
    else if (f.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ValidationError(`${f.label} must be a number.`, f.key);
      next[f.key] = n;
    } else if (f.type === "select" && f.options && !f.options.some((o) => o.value === raw)) throw new ValidationError(`Choose a valid ${f.label.toLowerCase()}.`, f.key);
    else next[f.key] = raw;
  }
  const unknownKeys = Object.keys(edits).filter((k) => !def.editable.some((f) => f.key === k));
  if (unknownKeys.length) throw new ValidationError("Only the fields shown can be changed.");
  const parsed = def.input.safeParse(next);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    const field = def.editable.find((f) => f.key === String(i.path[0]));
    throw new ValidationError(`${field?.label ?? "That value"}: ${i.message}`, field?.key);
  }
  const args = parsed.data as Record<string, unknown>;
  const env = makeToolEnv(p.orgSlug, tz);
  const prepared = await def.prepare(ctx, args, env);
  if (!prepared.ok) throw new ValidationError(prepared.message);
  const riskClass = def.riskClass(args, p);
  const policyKeys = def.policyKeys(args, p);
  const rules = await tenantTx(ctx, (tx) => loadPolicyRules(tx, p.orgId));
  if (decide({ riskClass, keys: policyKeys, propertyId: prepared.step.propertyId, rules }).mode === "deny") throw new ValidationError("The assistant isn't allowed to do that.");
  const revised = { ...stepFromPrepared(def, step.callId, args, riskClass, policyKeys, prepared.step, 0), id: step.id };

  await tenantTx(ctx, async (tx) => {
    const cur = await lockOwnPlan(tx, ctx, id);
    assertPending(cur);
    const newSteps = stepsOf(cur).map((s) => (s.id === stepId ? revised : s));
    await tx.update(aiApprovals).set({ steps: newSteps }).where(eq(aiApprovals.id, id));
    await writeAudit(tx, {
      orgId: p.orgId, actorUserId: p.userId, action: "ai.plan.edited", entityType: "ai_approval", entityId: id,
      before: { step: stepId, input: step.input }, after: { step: stepId, input: args }, approvalId: id,
    }, ctx.meta);
  });
  return getPlanView(ctx, id);
}

/* ───────────── reading ───────────── */

export async function getPlanView(ctx: TenantCtx, id: string): Promise<PlanView> {
  return tenantTx(ctx, async (tx) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError();
    const [row] = await tx.select().from(aiApprovals)
      .where(and(eq(aiApprovals.id, id), eq(aiApprovals.orgId, ctx.principal.orgId), eq(aiApprovals.requestedByUserId, ctx.principal.userId)));
    if (!row) throw new NotFoundError();
    return toView(row, ctx.principal.userId, await namesFor(tx, [row]));
  });
}

// plans shown under each turn of a conversation (auto-run steps show in the trail instead)
export async function plansForConversation(tx: Tx, ctx: TenantCtx, conversationId: string): Promise<Map<string, PlanView>> {
  const rows = await tx.select().from(aiApprovals)
    .where(and(eq(aiApprovals.orgId, ctx.principal.orgId), eq(aiApprovals.conversationId, conversationId), eq(aiApprovals.requestedByUserId, ctx.principal.userId), eq(aiApprovals.mode, "confirm")))
    .orderBy(desc(aiApprovals.createdAt));
  const names = await namesFor(tx, rows);
  const out = new Map<string, PlanView>();
  for (const r of rows) if (!out.has(r.turnId)) out.set(r.turnId, toView(r, ctx.principal.userId, names));
  return out;
}

export type PendingPlan = { id: string; conversationId: string | null; conversationTitle: string | null; title: string; steps: number; createdAt: Date; expiresAt: Date };

export async function listPendingPlans(ctx: TenantCtx, limit = 10): Promise<PendingPlan[]> {
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({ row: aiApprovals, title: aiConversations.title }).from(aiApprovals)
      .leftJoin(aiConversations, eq(aiConversations.id, aiApprovals.conversationId))
      .where(and(eq(aiApprovals.orgId, ctx.principal.orgId), eq(aiApprovals.requestedByUserId, ctx.principal.userId), eq(aiApprovals.status, "pending"), gt(aiApprovals.expiresAt, sql`now()`)))
      .orderBy(desc(aiApprovals.createdAt)).limit(limit);
    return rows.map(({ row, title }) => {
      const steps = stepsOf(row);
      return { id: row.id, conversationId: row.conversationId, conversationTitle: title, title: steps[0]?.title ?? "Prepared changes", steps: steps.length, createdAt: row.createdAt, expiresAt: row.expiresAt };
    });
  });
}

// what the model is told on its next turn about plans decided since (the transcript itself is never rewritten)
export async function planNotesForHistory(tx: Tx, ctx: TenantCtx, conversationId: string): Promise<Map<string, string>> {
  const rows = await tx.select().from(aiApprovals)
    .where(and(eq(aiApprovals.orgId, ctx.principal.orgId), eq(aiApprovals.conversationId, conversationId), eq(aiApprovals.mode, "confirm")));
  const notes = new Map<string, string>();
  const now = new Date();
  for (const r of rows) {
    if (r.status === "pending" && !isExpired(r, now)) continue;
    const results = resultsOf(r);
    const note =
      isExpired(r, now) ? "That plan expired without approval; nothing from it ran."
        : r.status === "rejected" ? "The user cancelled the prepared plan; nothing was changed."
        : r.status === "superseded" ? "That plan was replaced by a newer one; nothing from it ran."
          : r.status === "expired" ? "That plan expired without approval; nothing from it ran."
            : r.status === "executing" ? "The user approved the plan and it is running."
              : `The user approved the plan. Results: ${results.map((x) => `${x.status}: ${x.summary}${x.warning ? ` (${x.warning})` : ""}`).join(" ")}`;
    notes.set(r.turnId, `[Update: ${note}]`);
  }
  return notes;
}

export type RecentPlan = { id: string; createdAt: Date; requestedBy: string | null; title: string; steps: number; tools: string[]; mode: string; status: string };

// for admins: the organization's latest assistant plans, whoever asked (settings → AI assistant)
export async function recentPlans(ctx: TenantCtx, limit = 15): Promise<RecentPlan[]> {
  if (!ctx.principal.permissions.has("ai.settings.manage")) throw new ForbiddenError();
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({ row: aiApprovals, name: users.name }).from(aiApprovals)
      .leftJoin(users, eq(users.id, aiApprovals.requestedByUserId))
      .where(eq(aiApprovals.orgId, ctx.principal.orgId)).orderBy(desc(aiApprovals.createdAt)).limit(limit);
    const now = new Date();
    return rows.map(({ row, name }) => {
      const steps = stepsOf(row);
      return { id: row.id, createdAt: row.createdAt, requestedBy: name, title: steps[0]?.title ?? "—", steps: steps.length, tools: [...new Set(steps.map((s) => s.tool))], mode: row.mode, status: isExpired(row, now) ? "expired" : row.status };
    });
  });
}
