import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "../db/client";
import { aiUsage, complaints, incidents, organizations, outboxEvents, timelineEvents, vendors, workOrders, memberships, users } from "../db/schema";
import { authorize } from "../authz/authorize";
import type { Permission } from "../authz/permissions";
import { auditAs, tenantTx, type TenantCtx } from "../modules/context";
import { addTimeline } from "../modules/ops/core";
import { assignWorkOrder, setWorkOrderPriority, transitionWorkOrder } from "../modules/maintenance/service";
import { createTask } from "../modules/tasks/service";
import { createAnnouncement } from "../modules/announcements/service";
import { usersWithPermAt } from "../modules/notifications/recipients";
import { loadPrincipal } from "../modules/organizations/principal";
import { routeModel } from "../ai/providers";
import { aiConfig } from "../ai/config";
import { estimateCostUsd, priceFor } from "../ai/pricing";
import { readAiSettings, requestsThisMonth } from "../ai/usage";
import { ZERO_USAGE, addUsage, type Usage } from "../ai/types";
import { fmtValue, metricValues, type MetricKey } from "../analytics/metrics";
import { previousPeriod, resolvePeriod } from "../analytics/period";
import { propertyHealth } from "../analytics/health";
import { HEALTH_GRADE } from "@/lib/analytics-labels";
import { describeAction, renderAutomationText, REPORT_LABEL, type AutomationVars, type Subject, type WorkflowAction } from "@/lib/automation";
import { PRIORITY, WO_STATUS } from "@/lib/ops-labels";
import { membersWithRoleAt, names, onCallPerson, resolveRecipients, type Person } from "./recipients";
import { connectedChat, sendChatMessage } from "../integrations/service";

// What each automation action does. `plan` describes the effect without writing anything (dry runs);
// `run` makes the change through the same domain services as the UI, as the rule's owner (ctx.automation set).

export type StepStatus = "pending" | "done" | "skipped" | "failed" | "waiting";
export type RunStep = {
  index: number; type: WorkflowAction["type"]; label: string; status: StepStatus; action: WorkflowAction;
  summary?: string; error?: string; record?: { ref: string; title: string; href: string }; at?: string;
};

export type ActionEnv = {
  ctx: TenantCtx; // the owner's principal, with ctx.automation = { workflowId, runId, depth }
  orgSlug: string;
  wf: { id: string; name: string; propertyId: string | null };
  subject: Subject | null;
  tz: string;
  now: Date;
};

export type ActionResult = { status: "done" | "skipped"; summary: string; record?: RunStep["record"] };

export const propertyOf = (env: Pick<ActionEnv, "subject" | "wf">) => env.subject?.propertyId ?? env.wf.propertyId;

export function templateVars(env: Pick<ActionEnv, "subject" | "wf" | "tz" | "now">, propertyName: string | null): AutomationVars {
  const s = env.subject;
  return {
    ref: s?.ref ?? null, title: s?.title ?? null, property: s?.propertyName ?? propertyName, building: s?.buildingName ?? null, unit: s?.unitLabel ?? null,
    category: (s?.fields.category_label as string) ?? null, priority: (s?.fields.priority_label as string) ?? null, status: (s?.fields.status_label as string) ?? null,
    rule: env.wf.name, date: env.now.toLocaleDateString("en-CA", { timeZone: env.tz, dateStyle: "medium" }),
  };
}

// notifications from rules are addressed to resolved people; actorUserId is null so the owner is included if addressed
async function sendNotice(env: ActionEnv, userIds: string[], n: { kind: "workflow.notice" | "workflow.approval" | "report.scheduled"; title: string; body: string | null; href: string; entityType?: string; entityId?: string }) {
  if (!userIds.length) return;
  const a = env.ctx.automation!;
  await tenantTx(env.ctx, (tx) => tx.insert(outboxEvents).values({
    orgId: env.ctx.principal.orgId, type: "workflow.notify", actorUserId: null, automationAt: env.now,
    causedByRunId: a.runId, causedByWorkflowId: a.workflowId, chainDepth: a.depth + 1,
    payload: { userIds, kind: n.kind, title: n.title.slice(0, 200), body: n.body?.slice(0, 2000) ?? null, href: n.href, entityType: n.entityType ?? "workflow_run", entityId: n.entityId ?? a.runId, runId: a.runId },
  }));
}

// reads run in the owner's tenant context: RLS pins them to the organization
const readTx = <T,>(env: Pick<ActionEnv, "ctx">, fn: (tx: Tx) => Promise<T>) => tenantTx(env.ctx, fn);

async function currentWo(env: ActionEnv) {
  const [w] = await readTx(env, (tx) => tx.select().from(workOrders).where(and(eq(workOrders.id, env.subject!.id), eq(workOrders.orgId, env.ctx.principal.orgId))));
  if (!w) throw new Error("The request no longer exists.");
  return w;
}

const requireWo = (env: ActionEnv) => {
  if (env.subject?.type !== "work_order") throw new Error("This action only applies to maintenance requests.");
};

async function onCall(env: ActionEnv): Promise<Person | null> {
  return readTx(env, (tx) => onCallPerson(tx, env.ctx.principal.orgId, propertyOf(env), env.subject?.buildingId ?? null));
}

async function lookupName(env: ActionEnv, kind: "member" | "vendor", id: string) {
  return readTx(env, async (tx) => {
    const org = env.ctx.principal.orgId;
    if (kind === "vendor") return (await tx.select({ name: vendors.name }).from(vendors).where(and(eq(vendors.id, id), eq(vendors.orgId, org))))[0]?.name ?? "a removed vendor";
    return (await tx.select({ name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.id, id), eq(memberships.orgId, org))))[0]?.name ?? "a removed person";
  });
}

const REPORT_METRICS: Record<string, MetricKey[]> = {
  maintenance: ["requests_created", "requests_completed", "sla_compliance", "overdue_now", "open_backlog"],
  sla: ["sla_compliance", "response_compliance", "first_response_hours", "resolution_hours", "overdue_now"],
  vendors: ["requests_completed", "resolution_hours", "sla_compliance"],
  complaints: ["complaints_created", "complaint_resolution_hours"],
  incidents: ["incidents_reported", "serious_incidents"],
  workload: ["open_backlog", "open_tasks", "tasks_completed", "requests_completed"],
  health: [],
};

/* ───────────── dry run ───────────── */

export async function planAction(a: WorkflowAction, env: ActionEnv): Promise<string> {
  const s = env.subject;
  const label = s ? `${s.ref === "Package" || s.ref === "Document" || s.ref === "Inspection" ? s.title : s.ref}` : "";
  const propertyName = s?.propertyName ?? null;
  const vars = templateVars(env, propertyName);
  switch (a.type) {
    case "set_priority": {
      const w = await currentWo(env);
      return w.priority === a.priority ? `${label} is already ${a.priority} — no change.` : `Would change ${label}'s priority from ${w.priority} to ${a.priority}; SLA targets are recalculated.`;
    }
    case "set_status": {
      const w = await currentWo(env);
      return w.status === a.status ? `${label} is already ${WO_STATUS[a.status]?.label.toLowerCase()} — no change.` : `Would move ${label} from ${WO_STATUS[w.status]?.label.toLowerCase()} to ${WO_STATUS[a.status]?.label.toLowerCase()}.`;
    }
    case "assign": {
      if (a.target === "on_call") { const p = await onCall(env); return p ? `Would assign ${label} to ${p.name} (on call now).` : `Nobody is on call at ${propertyName ?? "the property"} right now — this step would be skipped.`; }
      return `Would assign ${label} to ${await lookupName(env, a.target, (a.target === "vendor" ? a.vendorId : a.membershipId)!)}.`;
    }
    case "escalate": {
      const w = await currentWo(env);
      const mgrs = await readTx(env, (tx) => usersWithPermAt(tx, env.ctx.principal.orgId, "workorder.manage", w.propertyId, w.buildingId));
      return `Would raise ${label} to urgent${w.priority === "urgent" ? " (already urgent)" : ""} and alert ${mgrs.length} manager${mgrs.length === 1 ? "" : "s"}.`;
    }
    case "notify": {
      const ps = await readTx(env, (tx) => resolveRecipients(tx, env.ctx.principal.orgId, a.to, s, propertyOf(env)));
      return ps.length ? `Would notify ${names(ps)}: “${renderAutomationText(a.title, vars)}”.` : "Nobody matches the recipients right now — this step would be skipped.";
    }
    case "create_task": {
      const who = a.assignTo === "on_call" ? (await onCall(env))?.name ?? "nobody (no one on call right now)" : a.assignTo === "member" ? await lookupName(env, "member", a.membershipId!) : "nobody";
      return `Would create the task “${renderAutomationText(a.title, vars)}” for ${who}, due ${new Date(env.now.getTime() + a.dueInMinutes * 60_000).toLocaleString("en-CA", { timeZone: env.tz, dateStyle: "medium", timeStyle: "short" })}.`;
    }
    case "draft_announcement": return `Would save a draft announcement “${renderAutomationText(a.title, vars)}” for review — nothing is published.`;
    case "request_approval": {
      const ps = await readTx(env, (tx) => membersWithRoleAt(tx, env.ctx.principal.orgId, [a.role], propertyOf(env), s?.buildingId ?? null));
      return ps.length ? `Would pause and ask for approval from ${names(ps)}; the steps below run only after one of them approves.` : `Nobody with that role covers ${propertyName ?? "this property"} — the run would stop here.`;
    }
    case "assistant_draft": return `Would ask the assistant to draft a summary of ${label} as an internal note marked “draft”. Nothing is sent.`;
    case "send_report": {
      const ps = await readTx(env, (tx) => resolveRecipients(tx, env.ctx.principal.orgId, a.to, s, propertyOf(env)));
      return ps.length ? `Would send the ${REPORT_LABEL[a.report]?.toLowerCase()} report to ${names(ps)} (each sees only what their own access allows).` : "Nobody matches the recipients right now — this step would be skipped.";
    }
    case "post_to_chat": {
      const chat = (await connectedChat(env.ctx.principal.orgId)).find((c) => c.provider === a.provider);
      const where = a.provider === "slack" ? "Slack" : "Microsoft Teams";
      return chat ? `Would post to ${where}${chat.channel ? ` (${chat.channel})` : ""}: “${renderAutomationText(a.message, vars)}”.` : `${where} isn't connected — this step would fail. Connect it in Organization → Integrations.`;
    }
  }
}

/* ───────────── execution ───────────── */

export async function runAction(a: WorkflowAction, env: ActionEnv): Promise<ActionResult> {
  const s = env.subject;
  const ctx = env.ctx;
  const note = `By automation “${env.wf.name}”.`;
  const [org] = await readTx(env, (tx) => tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.principal.orgId)));
  const vars = templateVars(env, s?.propertyName ?? org?.name ?? null);
  const woRecord = () => (s ? { ref: s.ref, title: s.title, href: s.href } : undefined);

  switch (a.type) {
    case "set_priority": {
      requireWo(env);
      const r = await setWorkOrderPriority(ctx, s!.id, a.priority, note);
      return r.changed ? { status: "done", summary: `Priority set to ${PRIORITY[a.priority]?.label.toLowerCase()}.`, record: woRecord() } : { status: "skipped", summary: `Already ${a.priority}.` };
    }
    case "set_status": {
      requireWo(env);
      const w = await currentWo(env);
      if (w.status === a.status) return { status: "skipped", summary: `Already ${WO_STATUS[a.status]?.label.toLowerCase()}.` };
      await transitionWorkOrder(ctx, s!.id, { to: a.status, note, cost: null, resolutionNotes: null });
      return { status: "done", summary: `Status changed to ${WO_STATUS[a.status]?.label.toLowerCase()}.`, record: woRecord() };
    }
    case "assign": {
      requireWo(env);
      const w = await currentWo(env);
      let membershipId = w.assignedMembershipId;
      let vendorId = w.vendorId;
      let who: string;
      if (a.target === "on_call") {
        const p = await onCall(env);
        if (!p) return { status: "skipped", summary: `Nobody is on call at ${s!.propertyName ?? "the property"} right now.` };
        membershipId = p.membershipId; who = p.name;
      } else if (a.target === "vendor") {
        vendorId = a.vendorId!; who = await lookupName(env, "vendor", vendorId);
      } else {
        membershipId = a.membershipId!; who = await lookupName(env, "member", membershipId);
      }
      if (membershipId === w.assignedMembershipId && vendorId === w.vendorId) return { status: "skipped", summary: `${who} is already assigned.` };
      await assignWorkOrder(ctx, s!.id, { membershipId, vendorId });
      return { status: "done", summary: `Assigned to ${who}.`, record: woRecord() };
    }
    case "escalate": {
      requireWo(env);
      const r = await setWorkOrderPriority(ctx, s!.id, "urgent", `Escalated by automation “${env.wf.name}”.`);
      const w = r.workOrder;
      const mgrs = await readTx(env, (tx) => usersWithPermAt(tx, ctx.principal.orgId, "workorder.manage", w.propertyId, w.buildingId));
      await sendNotice(env, mgrs, { kind: "workflow.notice", title: `Escalated: #${w.number} ${w.title}`, body: `Raised to urgent by the rule “${env.wf.name}”.`, href: s!.href, entityType: "work_order", entityId: w.id });
      return { status: "done", summary: `${r.changed ? "Raised to urgent" : "Already urgent"}; ${mgrs.length} manager${mgrs.length === 1 ? "" : "s"} alerted.`, record: woRecord() };
    }
    case "notify": {
      const ps = await readTx(env, (tx) => resolveRecipients(tx, ctx.principal.orgId, a.to, s, propertyOf(env)));
      if (!ps.length) return { status: "skipped", summary: "Nobody matched the recipients." };
      await sendNotice(env, ps.map((p) => p.userId), {
        kind: "workflow.notice", title: renderAutomationText(a.title, vars), body: a.message ? renderAutomationText(a.message, vars) : null,
        href: s?.href ?? `/automations/${env.wf.id}`, entityType: s?.type ?? "workflow", entityId: s?.id ?? env.wf.id,
      });
      return { status: "done", summary: `Notified ${names(ps)}.` };
    }
    case "create_task": {
      let assignee: string | null = null;
      let who = "nobody";
      if (a.assignTo === "on_call") { const p = await onCall(env); if (p) { assignee = p.membershipId; who = p.name; } else who = "nobody (no one was on call)"; }
      if (a.assignTo === "member") { assignee = a.membershipId!; who = await lookupName(env, "member", assignee); }
      const due = new Date(env.now.getTime() + a.dueInMinutes * 60_000);
      const t = await createTask(ctx, {
        title: renderAutomationText(a.title, vars).slice(0, 200), description: [a.details ? renderAutomationText(a.details, vars) : null, `Created by the automation rule “${env.wf.name}”.`].filter(Boolean).join("\n\n"),
        propertyId: propertyOf(env), priority: a.priority, dueAt: null, assignedMembershipId: assignee, recurrence: "none", checklist: [], blockedByTaskId: null,
      }, due, { source: "automation", sourceType: s?.type ?? "workflow", sourceId: s?.id ?? env.wf.id, buildingId: s?.buildingId ?? null });
      return { status: "done", summary: `Task created for ${who}.`, record: { ref: "Task", title: t.title, href: `/tasks/${t.id}` } };
    }
    case "draft_announcement": {
      const ann = await createAnnouncement(ctx, {
        title: renderAutomationText(a.title, vars).slice(0, 140), body: renderAutomationText(a.body, vars), category: s?.type === "work_order" ? "maintenance" : "general",
        propertyId: propertyOf(env), audience: a.audience, pinned: false, notify: true, mode: "draft", publishAt: undefined, expiresOn: null,
      }, s?.buildingId ? [s.buildingId] : []);
      const owner = ctx.principal.userId;
      await sendNotice(env, [owner], { kind: "workflow.notice", title: `Draft announcement ready: ${ann.title}`, body: `The rule “${env.wf.name}” drafted it. Review and publish it if it's right.`, href: `/announcements/${ann.id}`, entityType: "announcement", entityId: ann.id });
      return { status: "done", summary: "Draft saved for review (not published).", record: { ref: "Announcement", title: ann.title, href: `/announcements/${ann.id}` } };
    }
    case "assistant_draft": return assistantDraft(a.instruction, env);
    case "send_report": return sendReport(a, env);
    case "post_to_chat": {
      const r = await sendChatMessage(ctx.principal.orgId, a.provider, renderAutomationText(a.message, vars));
      return { status: "done", summary: `Posted to ${a.provider === "slack" ? "Slack" : "Microsoft Teams"}${r.channel ? ` (${r.channel})` : ""}.` };
    }
    case "request_approval": throw new Error("approval steps are handled by the engine");
  }
}

/* ───────────── assistant draft ───────────── */

const MANAGE_PERM: Partial<Record<Subject["type"], Permission>> = { work_order: "workorder.manage", complaint: "complaint.manage", incident: "incident.manage" };

async function recordFacts(env: ActionEnv): Promise<{ text: string; body: string }> {
  const s = env.subject!;
  return readTx(env, async (tx) => {
    const rec = s.type === "work_order" ? (await tx.select({ d: workOrders.description, at: workOrders.createdAt }).from(workOrders).where(eq(workOrders.id, s.id)))[0]
      : s.type === "complaint" ? (await tx.select({ d: complaints.description, at: complaints.createdAt }).from(complaints).where(eq(complaints.id, s.id)))[0]
        : (await tx.select({ d: incidents.description, at: incidents.occurredAt }).from(incidents).where(eq(incidents.id, s.id)))[0];
    const notes = await tx.select({ body: timelineEvents.body, kind: timelineEvents.kind, at: timelineEvents.createdAt }).from(timelineEvents)
      .where(and(eq(timelineEvents.orgId, env.ctx.principal.orgId), eq(timelineEvents.entityId, s.id), inArray(timelineEvents.kind, ["comment", "status", "assigned", "scheduled"])))
      .orderBy(desc(timelineEvents.createdAt)).limit(6);
    const place = [s.unitLabel ? `Unit ${s.unitLabel}` : null, s.buildingName, s.propertyName].filter(Boolean).join(", ");
    const lines = [
      `${s.ref} — ${s.title}`, place ? `Location: ${place}` : null,
      `Category: ${s.fields.category_label ?? "—"} · Priority/severity: ${s.fields.priority_label ?? "—"} · Status: ${s.fields.status_label ?? "—"}`,
      rec?.at ? `Reported: ${rec.at.toLocaleString("en-CA", { timeZone: env.tz, dateStyle: "medium", timeStyle: "short" })}` : null,
      rec?.d ? `Description: ${rec.d.slice(0, 1500)}` : null,
      ...notes.filter((n) => n.body).reverse().map((n) => `Update (${n.kind}): ${n.body!.slice(0, 300)}`),
    ].filter(Boolean) as string[];
    return { text: lines.join("\n"), body: rec?.d ?? "" };
  });
}

async function assistantDraft(instruction: string, env: ActionEnv): Promise<ActionResult> {
  const s = env.subject;
  const perm = s ? MANAGE_PERM[s.type] : undefined;
  if (!s || !perm) throw new Error("The assistant can only draft notes on requests, complaints and incidents.");
  authorize(env.ctx.principal, perm, { orgId: env.ctx.principal.orgId, propertyId: s.propertyId, buildingId: s.buildingId });
  const facts = await recordFacts(env);
  const model = routeModel("extract");
  let text: string;
  let label: string;
  if (model.demo) {
    // no language model configured: a factual digest built from the record, clearly labelled
    const first = facts.body.replace(/\s+/g, " ").trim();
    text = [`${s.ref} — ${s.title}${s.propertyName ? ` at ${[s.buildingName, s.propertyName].filter(Boolean).join(", ")}` : ""}.`,
      `${s.fields.category_label ?? ""}${s.fields.priority_label ? `, ${String(s.fields.priority_label).toLowerCase()}` : ""}; currently ${String(s.fields.status_label ?? "").toLowerCase()}.`,
      first ? `Reported: “${first.slice(0, 280)}${first.length > 280 ? "…" : ""}”` : null].filter(Boolean).join(" ");
    label = "Assistant draft (demo mode — composed from the record, no language model)";
  } else {
    const cfg = aiConfig();
    const started = Date.now();
    const [org] = await readTx(env, (tx) => tx.select({ settings: organizations.settings, tz: organizations.timezone }).from(organizations).where(eq(organizations.id, env.ctx.principal.orgId)));
    const settings = readAiSettings(org.settings);
    if (!settings.enabled) return { status: "skipped", summary: "The assistant is switched off for the organization." };
    if (settings.monthlyRequestCap !== null && (await readTx(env, (tx) => requestsThisMonth(tx, env.ctx.principal.orgId, org.tz))) >= settings.monthlyRequestCap) return { status: "skipped", summary: "This month's assistant limit has been reached." };
    let usage: Usage = { ...ZERO_USAGE };
    let out = "";
    let outcome = "ok";
    try {
      for await (const ev of model.stream({
        system: "You summarise property-maintenance records for building staff. Use only the facts given; never invent times, people, causes or costs. " +
          "Write 2–4 plain sentences: what happened, where, current status, and the next step if the record states one. If something is unknown, say so.",
        messages: [{ role: "user", content: `${instruction ? `Instruction from the rule: ${instruction}\n\n` : ""}Record:\n${facts.text}` }],
        tools: [], maxTokens: 400, temperature: 0.2,
      })) {
        if (ev.type === "text") out += ev.delta;
        if (ev.type === "end") usage = addUsage(usage, ev.usage);
      }
    } catch (e) {
      outcome = "error";
      throw new Error(`The assistant couldn't write the draft (${e instanceof Error ? e.message : "provider error"}).`);
    } finally {
      const cost = estimateCostUsd(usage, priceFor(model.model, cfg.priceOverride));
      await readTx(env, (tx) => tx.insert(aiUsage).values({
        orgId: env.ctx.principal.orgId, userId: env.ctx.principal.userId, turnId: randomUUID(), feature: "automation", provider: model.provider, model: model.model,
        inputTokens: usage.inputTokens + usage.cacheWriteTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cacheReadTokens, modelCalls: 1, toolCalls: 0,
        estCostUsd: cost === null ? null : cost.toFixed(6), latencyMs: Date.now() - started, outcome,
      })).catch(() => {});
    }
    text = out.trim().slice(0, 2000);
    if (!text) return { status: "skipped", summary: "The assistant returned nothing." };
    label = `Assistant draft (${model.provider} ${model.model})`;
  }
  const actx: TenantCtx = { ...env.ctx, ai: { approvalId: null } };
  await tenantTx(actx, async (tx) => {
    const ev = await addTimeline(tx, actx, { entityType: s.type, entityId: s.id, kind: "comment", visibility: "internal", body: `${label} — not sent:\n${text}` });
    await auditAs(tx, actx, "automation.assistant_draft", s.type, s.id, undefined, { timelineEventId: ev.id, demo: model.demo });
  });
  return { status: "done", summary: "Draft note added (internal, not sent).", record: { ref: s.ref, title: s.title, href: s.href } };
}

/* ───────────── scheduled reports ───────────── */

// each recipient gets the numbers their own access allows (computed with their principal, not the rule owner's)
async function sendReport(a: Extract<WorkflowAction, { type: "send_report" }>, env: ActionEnv): Promise<ActionResult> {
  const people = await readTx(env, (tx) => resolveRecipients(tx, env.ctx.principal.orgId, a.to, env.subject, propertyOf(env)));
  if (!people.length) return { status: "skipped", summary: "Nobody matched the recipients." };
  const propertyId = propertyOf(env);
  const sent: string[] = [];
  const skipped: string[] = [];
  for (const person of people.slice(0, 25)) {
    const principal = await loadPrincipal(person.userId, env.orgSlug);
    if (!principal || !principal.permissions.has("analytics.read")) { skipped.push(person.name); continue; }
    const rctx: TenantCtx = { principal, meta: null };
    const period = resolvePeriod(a.period, env.tz, env.now);
    const lines: string[] = [];
    if (a.report === "health") {
      for (const h of (await propertyHealth(rctx, { propertyId, now: env.now })).slice(0, 10)) lines.push(`${h.name}: ${h.score ?? "—"}${h.grade ? ` (${HEALTH_GRADE[h.grade].label})` : ""}${h.weakest ? ` — weakest: ${h.weakest.label.toLowerCase()} ${h.weakest.valueText}` : ""}`);
    } else {
      const vals = await metricValues(rctx, REPORT_METRICS[a.report] ?? [], period, previousPeriod(period, env.tz), { propertyId });
      for (const v of vals) lines.push(`${v.label}: ${fmtValue(v.value, v.unit)}${!v.snapshot && v.previous !== null ? ` (previous ${period.days} days: ${fmtValue(v.previous, v.unit)})` : v.snapshot ? " (now)" : ""}`);
    }
    if (!lines.length) { skipped.push(person.name); continue; }
    await sendNotice(env, [person.userId], {
      kind: "report.scheduled", title: `${REPORT_LABEL[a.report]} — ${period.label.toLowerCase()}`, body: lines.join("\n"),
      href: `/analytics/reports/${a.report}?period=${a.period}${propertyId ? `&property=${propertyId}` : ""}`, entityType: "workflow", entityId: env.wf.id,
    });
    sent.push(person.name);
  }
  if (!sent.length) return { status: "skipped", summary: `None of the recipients can view reports${skipped.length ? ` (${skipped.join(", ")})` : ""}.` };
  return { status: "done", summary: `Sent to ${sent.join(", ")}${skipped.length ? `; skipped ${skipped.join(", ")} (no access to reports)` : ""}.` };
}

export const stepLabel = (a: WorkflowAction, n: Parameters<typeof describeAction>[1]) => describeAction(a, n);
