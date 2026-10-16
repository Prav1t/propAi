import "server-only";
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../db/client";
import { buildings, memberships, organizations, outboxEvents, properties, roles, users, vendorProperties, vendors, workflowRuns, workflows } from "../db/schema";
import { can, ForbiddenError, NotFoundError, type Principal } from "../authz/authorize";
import type { Permission } from "../authz/permissions";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { pageArgs, toPage, visiblePropertyIds, type Page } from "../modules/scope";
import { loadSubject, subjectLabel } from "./subjects";
import { dryRunRule, EVENTS_FOR_TRIGGER, isApprover, loadNameBook, parseRule, type DryRun } from "./engine";
import type { RunStep } from "./actions";
import { describeWorkflow, nextOccurrence, subjectOf, workflowSchema, type NameBook, type TriggerType, type WorkflowInput, type WorkflowAction } from "@/lib/automation";

// Automation rules (Iteration 9): who can see and change them, and the queries behind the pages.

export const canManageAutomations = (p: Principal) => p.permissions.has("automation.manage");

type Wf = typeof workflows.$inferSelect;
type Run = typeof workflowRuns.$inferSelect;

// a scoped manager sees rules for their properties (and organization-wide rules, read-only)
function ruleVisibleWhere(p: Principal): SQL | undefined {
  const visible = visiblePropertyIds(p);
  if (visible === null) return undefined;
  return or(isNull(workflows.propertyId), visible.length ? inArray(workflows.propertyId, visible) : sql`false`);
}

export function canEditRule(p: Principal, wf: Pick<Wf, "orgId" | "propertyId">): boolean {
  if (!canManageAutomations(p) || wf.orgId !== p.orgId) return false;
  if (!wf.propertyId) return p.role.scopeLevel === "org";
  return can(p, "automation.manage", { orgId: p.orgId, propertyId: wf.propertyId });
}

const requireManage = (p: Principal) => { if (!canManageAutomations(p)) throw new ForbiddenError(); };

export type RuleListRow = Pick<Wf, "id" | "name" | "triggerType" | "enabled" | "propertyId" | "lastRunAt" | "runCount" | "pausedReason" | "nextRunAt"> & {
  propertyName: string | null; ownerName: string | null; summary: ReturnType<typeof describeWorkflow> | null; editable: boolean; waiting: number; failed7d: number;
};

export async function listRules(ctx: TenantCtx): Promise<RuleListRow[]> {
  const p = ctx.principal;
  requireManage(p);
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({ wf: workflows, propertyName: properties.name, ownerName: users.name }).from(workflows)
      .leftJoin(properties, eq(properties.id, workflows.propertyId)).leftJoin(users, eq(users.id, workflows.ownerUserId))
      .where(and(eq(workflows.orgId, p.orgId), ruleVisibleWhere(p))).orderBy(desc(workflows.enabled), asc(workflows.name));
    const ids = rows.map((r) => r.wf.id);
    const stats = ids.length ? await tx.select({
      id: workflowRuns.workflowId,
      waiting: sql<number>`count(*) filter (where ${workflowRuns.status} = 'waiting_approval')::int`,
      failed: sql<number>`count(*) filter (where ${workflowRuns.status} = 'failed' and ${workflowRuns.createdAt} >= now() - interval '7 days')::int`,
    }).from(workflowRuns).where(inArray(workflowRuns.workflowId, ids)).groupBy(workflowRuns.workflowId) : [];
    const n = await loadNameBook(tx, p.orgId);
    return rows.map(({ wf, propertyName, ownerName }) => {
      const rule = parseRule(wf);
      const s = stats.find((x) => x.id === wf.id);
      return {
        id: wf.id, name: wf.name, triggerType: wf.triggerType, enabled: wf.enabled, propertyId: wf.propertyId, lastRunAt: wf.lastRunAt, runCount: wf.runCount, pausedReason: wf.pausedReason, nextRunAt: wf.nextRunAt,
        propertyName, ownerName, editable: canEditRule(p, wf), waiting: s?.waiting ?? 0, failed7d: s?.failed ?? 0,
        summary: rule ? describeWorkflow({ trigger: wf.triggerType as TriggerType, schedule: rule.schedule, propertyId: wf.propertyId, conditions: rule.conditions, actions: rule.actions }, n) : null,
      };
    });
  });
}

async function loadRule(tx: Tx, p: Principal, id: string): Promise<Wf> {
  const [wf] = await tx.select().from(workflows).where(and(eq(workflows.id, id), eq(workflows.orgId, p.orgId)));
  if (!wf) throw new NotFoundError();
  const visible = visiblePropertyIds(p);
  if (wf.propertyId && visible !== null && !visible.includes(wf.propertyId)) throw new NotFoundError();
  return wf;
}

export async function getRule(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  requireManage(p);
  return tenantTx(ctx, async (tx) => {
    const wf = await loadRule(tx, p, id);
    const rule = parseRule(wf);
    const n = await loadNameBook(tx, p.orgId);
    const [owner] = wf.ownerUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, wf.ownerUserId)) : [];
    const runs = await tx.select().from(workflowRuns).where(eq(workflowRuns.workflowId, id)).orderBy(desc(workflowRuns.createdAt)).limit(15);
    return {
      wf, rule, names: n, ownerName: owner?.name ?? null, editable: canEditRule(p, wf), runs,
      summary: rule ? describeWorkflow({ trigger: wf.triggerType as TriggerType, schedule: rule.schedule, propertyId: wf.propertyId, conditions: rule.conditions, actions: rule.actions }, n) : null,
      input: rule ? ({ name: wf.name, description: wf.description ?? "", propertyId: wf.propertyId, trigger: wf.triggerType as TriggerType, schedule: rule.schedule, conditions: rule.conditions, actions: rule.actions } satisfies WorkflowInput) : null,
    };
  });
}

/* ───────────── builder options ───────────── */

export type BuilderOptions = {
  properties: { id: string; name: string }[]; orgWide: boolean;
  buildings: { id: string; name: string; propertyId: string }[];
  members: { id: string; name: string; role: string; propertyIds: string[] | null }[]; // null = every property
  vendors: { id: string; name: string; propertyIds: string[] }[];
  roles: { key: string; name: string }[];
};

export async function builderOptions(ctx: TenantCtx): Promise<BuilderOptions> {
  const p = ctx.principal;
  requireManage(p);
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, async (tx) => {
    const props = await tx.select({ id: properties.id, name: properties.name }).from(properties)
      .where(and(eq(properties.orgId, p.orgId), visible === null ? undefined : visible.length ? inArray(properties.id, visible) : sql`false`)).orderBy(asc(properties.name));
    const manageable = props.filter((x) => can(p, "automation.manage", { orgId: p.orgId, propertyId: x.id }));
    const ids = manageable.map((x) => x.id);
    const blds = ids.length ? await tx.select({ id: buildings.id, name: buildings.name, propertyId: buildings.propertyId }).from(buildings).where(and(eq(buildings.orgId, p.orgId), inArray(buildings.propertyId, ids))).orderBy(asc(buildings.name)) : [];
    const staff = await tx.select({ id: memberships.id, name: users.name, role: roles.name, scope: roles.scopeLevel }).from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId)).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.orgId, p.orgId), eq(memberships.status, "active"), eq(roles.category, "staff"))).orderBy(asc(users.name));
    const scopes = await tx.execute<{ membership_id: string; property_id: string }>(sql`
      select s.membership_id, coalesce(s.property_id, b.property_id, pp.id) as property_id from membership_scopes s
      left join buildings b on b.id = s.building_id left join properties pp on pp.portfolio_id = s.portfolio_id where s.org_id = ${p.orgId}`);
    const vs = await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(and(eq(vendors.orgId, p.orgId), eq(vendors.status, "active"))).orderBy(asc(vendors.name));
    const vp = vs.length ? await tx.select({ vendorId: vendorProperties.vendorId, propertyId: vendorProperties.propertyId }).from(vendorProperties).where(inArray(vendorProperties.vendorId, vs.map((v) => v.id))) : [];
    const rs = await tx.select({ key: roles.key, name: roles.name }).from(roles).where(and(sql`(${roles.orgId} is null or ${roles.orgId} = ${p.orgId})`, eq(roles.category, "staff"))).orderBy(asc(roles.name));
    return {
      properties: manageable, orgWide: p.role.scopeLevel === "org", buildings: blds,
      members: staff.map((s) => ({ id: s.id, name: s.name, role: s.role, propertyIds: s.scope === "org" ? null : [...new Set(scopes.rows.filter((x) => x.membership_id === s.id && x.property_id).map((x) => x.property_id))] })),
      vendors: vs.map((v) => ({ ...v, propertyIds: vp.filter((x) => x.vendorId === v.id).map((x) => x.propertyId) })),
      roles: [...new Map(rs.map((r) => [r.key, r])).values()],
    };
  });
}

/* ───────────── save / enable / delete ───────────── */

// what the saver must be allowed to do for each action, at the rule's property (the rule runs with their permissions)
const ACTION_PERMS: Partial<Record<WorkflowAction["type"], Permission>> = {
  set_priority: "workorder.manage", set_status: "workorder.manage", assign: "workorder.manage", escalate: "workorder.manage",
  create_task: "task.manage", draft_announcement: "announcement.manage", send_report: "analytics.read",
};

async function validateReferences(tx: Tx, p: Principal, input: WorkflowInput) {
  const opts = { orgId: p.orgId, propertyId: input.propertyId };
  if (input.propertyId) {
    const [prop] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.id, input.propertyId), eq(properties.orgId, p.orgId)));
    if (!prop || !can(p, "automation.manage", opts)) throw new ValidationError("Choose one of your properties.", "propertyId");
  } else if (p.role.scopeLevel !== "org") throw new ValidationError("Choose a property — only organization-wide managers can make rules for every property.", "propertyId");

  for (const a of input.actions) {
    const perm = ACTION_PERMS[a.type];
    if (perm && !(input.propertyId ? can(p, perm, opts) : p.permissions.has(perm))) throw new ValidationError(`You can't “${a.type.replace(/_/g, " ")}” here, so a rule you own can't either.`, "actions");
    if (a.type === "assistant_draft" && !p.permissions.has("ai.use")) throw new ValidationError("You need access to the assistant to add an assistant step.", "actions");
  }
  const buildingIds = input.conditions.filter((c) => c.field === "building").flatMap((c) => (Array.isArray(c.value) ? c.value : [String(c.value)]));
  if (buildingIds.length) {
    if (!input.propertyId) throw new ValidationError("Pick a property before choosing buildings.", "conditions");
    const ok = await tx.select({ id: buildings.id }).from(buildings).where(and(eq(buildings.propertyId, input.propertyId), inArray(buildings.id, buildingIds)));
    if (ok.length !== new Set(buildingIds).size) throw new ValidationError("Those buildings aren't all in the property.", "conditions");
  }
  const memberIds = input.actions.flatMap((a) => [
    ...(a.type === "assign" && a.target === "member" ? [a.membershipId!] : []), ...(a.type === "create_task" && a.assignTo === "member" ? [a.membershipId!] : []),
    ...(a.type === "notify" || a.type === "send_report" ? a.to.members : []),
  ]);
  if (memberIds.length) {
    const ok = await tx.select({ id: memberships.id }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.orgId, p.orgId), eq(memberships.status, "active"), eq(roles.category, "staff"), inArray(memberships.id, memberIds)));
    if (ok.length !== new Set(memberIds).size) throw new ValidationError("Choose active staff members of your organization.", "actions");
  }
  const vendorIds = input.actions.flatMap((a) => (a.type === "assign" && a.target === "vendor" ? [a.vendorId!] : []));
  if (vendorIds.length) {
    const ok = await tx.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.orgId, p.orgId), eq(vendors.status, "active"), inArray(vendors.id, vendorIds),
      input.propertyId ? sql`exists (select 1 from vendor_properties vp where vp.vendor_id = ${vendors.id} and vp.property_id = ${input.propertyId})` : undefined));
    if (ok.length !== new Set(vendorIds).size) throw new ValidationError("Choose an active vendor approved for the property.", "actions");
  }
  const roleKeys = input.actions.flatMap((a) => (a.type === "request_approval" ? [a.role] : a.type === "notify" || a.type === "send_report" ? a.to.roles : []));
  if (roleKeys.length) {
    const ok = await tx.select({ key: roles.key }).from(roles).where(and(sql`(${roles.orgId} is null or ${roles.orgId} = ${p.orgId})`, eq(roles.category, "staff"), inArray(roles.key, roleKeys)));
    if (new Set(ok.map((r) => r.key)).size !== new Set(roleKeys).size) throw new ValidationError("Choose staff roles only.", "actions");
  }
  if (input.trigger === "schedule" && input.actions.some((a) => ["set_priority", "set_status", "assign", "escalate", "assistant_draft"].includes(a.type))) {
    throw new ValidationError("Scheduled rules don't have a request to act on.", "actions");
  }
}

export async function saveRule(ctx: TenantCtx, id: string | null, raw: unknown, enable: boolean) {
  const p = ctx.principal;
  requireManage(p);
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue?.message ?? "Check the rule.", String(issue?.path[0] ?? "name"));
  }
  const input = parsed.data;
  return tenantTx(ctx, async (tx) => {
    const before = id ? await loadRule(tx, p, id) : null;
    if (before && !canEditRule(p, before)) throw new ForbiddenError("You can't change this rule.");
    await validateReferences(tx, p, input);
    const [org] = await tx.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, p.orgId));
    const values = {
      name: input.name, description: input.description || null, propertyId: input.propertyId, triggerType: input.trigger, schedule: input.schedule,
      conditions: input.conditions, actions: input.actions, enabled: enable, ownerUserId: p.userId, pausedReason: null,
      nextRunAt: enable && input.schedule ? nextOccurrence(input.schedule, org.tz, new Date()) : null,
    };
    const [after] = before
      ? await tx.update(workflows).set({ ...values, version: before.version + 1 }).where(eq(workflows.id, before.id)).returning()
      : await tx.insert(workflows).values({ ...values, orgId: p.orgId, createdByUserId: p.userId }).returning();
    await auditAs(tx, ctx, before ? "automation.updated" : "automation.created", "workflow", after.id,
      before ? { name: before.name, enabled: before.enabled, version: before.version } : undefined, { name: after.name, trigger: after.triggerType, enabled: after.enabled, version: after.version, propertyId: after.propertyId });
    return after;
  });
}

// turning a rule on makes you its owner: it will act with your permissions
export async function setRuleEnabled(ctx: TenantCtx, id: string, enabled: boolean) {
  const p = ctx.principal;
  requireManage(p);
  return tenantTx(ctx, async (tx) => {
    const wf = await loadRule(tx, p, id);
    if (!canEditRule(p, wf)) throw new ForbiddenError("You can't change this rule.");
    const rule = parseRule(wf);
    if (enabled && !rule) throw new ValidationError("This rule needs fixing before it can run. Open it and save it again.");
    const [org] = await tx.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, p.orgId));
    const [after] = await tx.update(workflows).set({
      enabled, pausedReason: null, ...(enabled ? { ownerUserId: p.userId } : {}),
      nextRunAt: enabled && rule?.schedule ? nextOccurrence(rule.schedule, org.tz, new Date()) : null,
    }).where(eq(workflows.id, id)).returning();
    await auditAs(tx, ctx, enabled ? "automation.enabled" : "automation.disabled", "workflow", id, { enabled: wf.enabled }, { enabled });
    return after;
  });
}

export async function deleteRule(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  requireManage(p);
  return tenantTx(ctx, async (tx) => {
    const wf = await loadRule(tx, p, id);
    if (!canEditRule(p, wf)) throw new ForbiddenError("You can't delete this rule.");
    await tx.delete(workflows).where(eq(workflows.id, id));
    await auditAs(tx, ctx, "automation.deleted", "workflow", id, { name: wf.name, trigger: wf.triggerType, runCount: wf.runCount }, undefined);
  });
}

/* ───────────── runs ───────────── */

export type RunListRow = Pick<Run, "id" | "workflowId" | "status" | "triggerType" | "entityType" | "entityId" | "entityLabel" | "createdAt" | "finishedAt" | "error" | "approvalRole"> & { workflowName: string; propertyName: string | null };

export async function listRuns(ctx: TenantCtx, opts: { status?: string; workflowId?: string; page?: number } = {}): Promise<Page<RunListRow>> {
  const p = ctx.principal;
  requireManage(p);
  const { page, pageSize, offset } = pageArgs(opts.page, 25);
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(workflowRuns.orgId, p.orgId), ruleVisibleWhere(p), opts.status ? eq(workflowRuns.status, opts.status) : undefined, opts.workflowId ? eq(workflowRuns.workflowId, opts.workflowId) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(workflowRuns).innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId)).where(where);
    const rows = await tx.select({
      id: workflowRuns.id, workflowId: workflowRuns.workflowId, status: workflowRuns.status, triggerType: workflowRuns.triggerType, entityType: workflowRuns.entityType, entityId: workflowRuns.entityId,
      entityLabel: workflowRuns.entityLabel, createdAt: workflowRuns.createdAt, finishedAt: workflowRuns.finishedAt, error: workflowRuns.error, approvalRole: workflowRuns.approvalRole,
      workflowName: workflows.name, propertyName: properties.name,
    }).from(workflowRuns).innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId)).leftJoin(properties, eq(properties.id, workflowRuns.propertyId))
      .where(where).orderBy(desc(workflowRuns.createdAt)).limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

// visible to automation managers in scope, and to the people asked to approve it
export async function getRun(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [row] = await tx.select({ run: workflowRuns, wf: workflows, propertyName: properties.name, decidedBy: users.name }).from(workflowRuns)
      .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId)).leftJoin(properties, eq(properties.id, workflowRuns.propertyId)).leftJoin(users, eq(users.id, workflowRuns.decidedByUserId))
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.orgId, p.orgId)));
    if (!row) throw new NotFoundError();
    const visible = visiblePropertyIds(p);
    const manager = canManageAutomations(p) && (!row.wf.propertyId || visible === null || visible.includes(row.wf.propertyId));
    const approver = await isApprover(tx, p, row.run);
    const decidedBefore = row.run.decidedByUserId === p.userId;
    if (!manager && !approver && !decidedBefore) throw new NotFoundError();
    return { run: row.run, steps: row.run.steps as RunStep[], workflow: { id: row.wf.id, name: row.wf.name }, propertyName: row.propertyName, decidedBy: row.decidedBy, canDecide: approver, canOpenRule: manager };
  });
}

// waiting runs this person can approve (their role, their properties)
export async function pendingApprovalsFor(ctx: TenantCtx): Promise<{ id: string; workflowName: string; entityLabel: string | null; requestedAt: Date | null; propertyName: string | null }[]> {
  const p = ctx.principal;
  if (p.role.category !== "staff") return [];
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select({ run: workflowRuns, name: workflows.name, propertyName: properties.name }).from(workflowRuns)
      .innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId)).leftJoin(properties, eq(properties.id, workflowRuns.propertyId))
      .where(and(eq(workflowRuns.orgId, p.orgId), eq(workflowRuns.status, "waiting_approval"), eq(workflowRuns.approvalRole, p.role.key)))
      .orderBy(asc(workflowRuns.approvalRequestedAt)).limit(50);
    const out = [];
    for (const r of rows) if (await isApprover(tx, p, r.run)) out.push({ id: r.run.id, workflowName: r.name, entityLabel: r.run.entityLabel, requestedAt: r.run.approvalRequestedAt, propertyName: r.propertyName });
    return out;
  });
}

/* ───────────── dry runs ───────────── */

// recent events a rule with this trigger would have seen, limited to records the tester can open
export async function candidateEvents(ctx: TenantCtx, trigger: TriggerType, propertyId: string | null, limit = 15) {
  const p = ctx.principal;
  requireManage(p);
  if (trigger === "schedule") return [];
  return tenantTx(ctx, async (tx) => {
    const evs = await tx.select().from(outboxEvents).where(and(eq(outboxEvents.orgId, p.orgId), inArray(outboxEvents.type, EVENTS_FOR_TRIGGER(trigger)), gte(outboxEvents.createdAt, new Date(Date.now() - 60 * 86_400_000))))
      .orderBy(desc(outboxEvents.createdAt)).limit(limit * 4);
    const out: { id: string; label: string; at: Date }[] = [];
    const seen = new Set<string>();
    const visible = visiblePropertyIds(p);
    for (const e of evs) {
      if (out.length >= limit) break;
      const s = await loadSubject(tx, trigger, e.payload as Record<string, unknown>);
      if (!s || seen.has(`${s.id}:${e.type}`)) continue;
      if (propertyId && s.propertyId !== propertyId) continue;
      if (visible !== null && s.propertyId && !visible.includes(s.propertyId)) continue;
      seen.add(`${s.id}:${e.type}`);
      out.push({ id: e.id, label: `${subjectLabel(s)}${s.propertyName ? ` · ${s.propertyName}` : ""}${e.type === "workorder.status_changed" && typeof (e.payload as { to?: string }).to === "string" ? ` → ${(e.payload as { to: string }).to.replace(/_/g, " ")}` : ""}`, at: e.createdAt });
    }
    return out;
  });
}

export async function dryRun(ctx: TenantCtx, raw: unknown, eventId: string | null): Promise<DryRun> {
  requireManage(ctx.principal);
  const parsed = workflowSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Finish the rule first.");
  const input = parsed.data;
  if (input.propertyId && !can(ctx.principal, "automation.manage", { orgId: ctx.principal.orgId, propertyId: input.propertyId })) throw new ForbiddenError();
  return dryRunRule(ctx, { name: input.name, propertyId: input.propertyId, trigger: input.trigger, conditions: input.conditions, actions: input.actions }, eventId);
}

/* ───────────── stats (analytics page, assistant) ───────────── */

export async function automationStats(ctx: TenantCtx, from: Date, to: Date) {
  const p = ctx.principal;
  if (!canManageAutomations(p) && !p.permissions.has("analytics.read")) return null;
  return tenantTx(ctx, async (tx) => {
    const [r] = await tx.select({
      runs: sql<number>`count(*)::int`,
      completed: sql<number>`count(*) filter (where ${workflowRuns.status} = 'completed')::int`,
      failed: sql<number>`count(*) filter (where ${workflowRuns.status} = 'failed')::int`,
      waiting: sql<number>`count(*) filter (where ${workflowRuns.status} = 'waiting_approval')::int`,
      rejected: sql<number>`count(*) filter (where ${workflowRuns.status} = 'rejected')::int`,
    }).from(workflowRuns).innerJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
      .where(and(eq(workflowRuns.orgId, p.orgId), ruleVisibleWhere(p), gte(workflowRuns.createdAt, from), lt(workflowRuns.createdAt, to)));
    const [{ active }] = await tx.select({ active: sql<number>`count(*)::int` }).from(workflows).where(and(eq(workflows.orgId, p.orgId), eq(workflows.enabled, true), ruleVisibleWhere(p)));
    return { ...r, activeRules: active };
  });
}

export const triggerSubject = (t: TriggerType) => subjectOf(t);
export type { NameBook };
