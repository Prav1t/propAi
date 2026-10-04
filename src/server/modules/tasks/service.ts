import "server-only";
import { and, asc, count, eq, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { memberships, properties, roles, taskChecklistItems, tasks, users } from "../../db/schema";
import { authorize, can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, blankToNull, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, type Page } from "../scope";
import { addTimeline, emit, listTimeline } from "../ops/core";

export const TASK_STATUSES = ["open", "in_progress", "blocked", "done", "cancelled"] as const;
export const RECURRENCES = ["none", "daily", "weekly", "monthly"] as const;
type TaskRow = typeof tasks.$inferSelect;

// who can see a task: scoped readers, the assignee, and the creator
export function taskVisibleWhere(p: Principal): SQL {
  const parts: (SQL | undefined)[] = [eq(tasks.assignedMembershipId, p.membershipId), eq(tasks.createdByUserId, p.userId)];
  if (p.permissions.has("task.read") || p.permissions.has("task.manage")) {
    parts.push(p.role.scopeLevel === "org" ? sql`true` : and(sql`${tasks.propertyId} is not null`, scopeCondition(p, { property: tasks.propertyId, building: tasks.buildingId }) ?? sql`true`));
  }
  return or(...parts.filter(Boolean)) ?? sql`false`;
}

function access(p: Principal, t: TaskRow) {
  const res = t.propertyId ? { orgId: t.orgId, propertyId: t.propertyId, buildingId: t.buildingId } : undefined;
  const manage = res ? can(p, "task.manage", res) : p.role.scopeLevel === "org" && can(p, "task.manage");
  const read = manage || (res ? can(p, "task.read", res) : p.role.scopeLevel === "org" && can(p, "task.read"));
  const assignee = !!t.assignedMembershipId && t.assignedMembershipId === p.membershipId;
  const creator = t.createdByUserId === p.userId;
  return { manage: manage || creator, read: read || assignee || creator, work: manage || assignee || creator };
}

export const canUseTasks = (p: Principal) => ["task.read", "task.manage"].some((x) => p.permissions.has(x)) || p.role.category === "staff";

export type TaskListRow = {
  id: string; title: string; status: string; priority: string; dueAt: Date | null; propertyName: string | null; assigneeName: string | null;
  source: string; recurrence: string; checklistDone: number; checklistTotal: number; overdue: boolean;
};

export async function listTasks(ctx: TenantCtx, opts: { view?: "open" | "mine" | "overdue" | "done" | "all"; propertyId?: string; page?: number }): Promise<Page<TaskListRow>> {
  const p = ctx.principal;
  if (!canUseTasks(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page);
  const now = new Date();
  const open = inArray(tasks.status, ["open", "in_progress", "blocked"]);
  const viewCond = { open, mine: and(open, eq(tasks.assignedMembershipId, p.membershipId)), overdue: and(open, lt(tasks.dueAt, now)), done: eq(tasks.status, "done"), all: undefined }[opts.view ?? "open"];
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(tasks.orgId, p.orgId), taskVisibleWhere(p), viewCond, opts.propertyId ? eq(tasks.propertyId, opts.propertyId) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(tasks).where(where);
    const rows = await tx
      .select({
        id: tasks.id, title: tasks.title, status: tasks.status, priority: tasks.priority, dueAt: tasks.dueAt, source: tasks.source, recurrence: tasks.recurrence,
        propertyName: properties.name, assigneeName: users.name,
        checklistDone: sql<number>`(select count(*)::int from task_checklist_items c where c.task_id = tasks.id and c.done)`,
        checklistTotal: sql<number>`(select count(*)::int from task_checklist_items c where c.task_id = tasks.id)`,
      })
      .from(tasks)
      .leftJoin(properties, eq(properties.id, tasks.propertyId))
      .leftJoin(memberships, eq(memberships.id, tasks.assignedMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(where)
      .orderBy(sql`${tasks.dueAt} asc nulls last`, asc(tasks.createdAt))
      .limit(pageSize).offset(offset);
    return toPage(rows.map((r) => ({ ...r, overdue: ["open", "in_progress", "blocked"].includes(r.status) && !!r.dueAt && r.dueAt < now })), n, page, pageSize);
  });
}

async function loadTask(tx: Tx, orgId: string, id: string) {
  const [t] = await tx.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.orgId, orgId)));
  if (!t) throw new NotFoundError();
  return t;
}

export async function getTask(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const t = await loadTask(tx, p.orgId, id);
    const a = access(p, t);
    if (!a.read) throw new NotFoundError();
    const checklist = await tx.select().from(taskChecklistItems).where(eq(taskChecklistItems.taskId, id)).orderBy(asc(taskChecklistItems.position));
    const [assignee] = t.assignedMembershipId ? await tx.select({ name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.id, t.assignedMembershipId)) : [];
    const [property] = t.propertyId ? await tx.select({ name: properties.name }).from(properties).where(eq(properties.id, t.propertyId)) : [];
    const [blockedBy] = t.blockedByTaskId ? await tx.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks).where(eq(tasks.id, t.blockedByTaskId)) : [];
    const timeline = await listTimeline(tx, p.orgId, "task", id, ["public", "vendor", "internal"]);
    return { task: t, checklist, assigneeName: assignee?.name ?? null, propertyName: property?.name ?? null, blockedBy: blockedBy ?? null, timeline, access: a,
      assignees: a.manage ? await taskAssignees(tx, p.orgId, t.propertyId) : [] };
  });
}

// staff who can be given a task at a property (or anyone on staff for org-level tasks)
export async function taskAssignees(tx: Tx, orgId: string, propertyId: string | null) {
  return tx.selectDistinct({ membershipId: memberships.id, name: users.name, role: roles.name }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId)).innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active"), eq(roles.category, "staff"),
      propertyId ? or(eq(roles.scopeLevel, "org"), sql`exists (select 1 from membership_scopes s where s.membership_id = ${memberships.id} and (s.property_id = ${propertyId}
        or s.portfolio_id = (select portfolio_id from properties where id = ${propertyId}) or s.building_id in (select id from buildings where property_id = ${propertyId})))`) : undefined))
    .orderBy(asc(users.name));
}

export async function listTaskAssignees(ctx: TenantCtx, propertyId: string | null) {
  return tenantTx(ctx, (tx) => taskAssignees(tx, ctx.principal.orgId, propertyId));
}

export const taskSchema = z.object({
  title: z.string().trim().min(2, "Give the task a title.").max(200),
  description: z.string().trim().max(5000).optional().transform(blankToNull),
  propertyId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  dueAt: z.string().optional().transform((v) => (v ? v : null)),
  assignedMembershipId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  recurrence: z.enum(RECURRENCES).default("none"),
  checklist: z.string().max(5000).optional().transform((v) => (v ?? "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 50)),
  blockedByTaskId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
});
export type TaskInput = z.infer<typeof taskSchema>;

export async function createTask(ctx: TenantCtx, input: TaskInput, dueUtc: Date | null, link?: { source: TaskRow["source"]; sourceType: string; sourceId: string; buildingId?: string | null }) {
  const p = ctx.principal;
  if (input.propertyId) authorize(p, "task.manage", { orgId: p.orgId, propertyId: input.propertyId });
  else if (p.role.scopeLevel !== "org") throw new ValidationError("Choose a property.", "propertyId");
  else authorize(p, "task.manage");
  return tenantTx(ctx, async (tx) => {
    if (input.assignedMembershipId && !(await taskAssignees(tx, p.orgId, input.propertyId)).some((a) => a.membershipId === input.assignedMembershipId)) {
      throw new ValidationError("That person can't be assigned work at this property.", "assignedMembershipId");
    }
    if (input.blockedByTaskId) await loadTask(tx, p.orgId, input.blockedByTaskId);
    const [t] = await tx.insert(tasks).values({
      orgId: p.orgId, propertyId: input.propertyId, buildingId: link?.buildingId ?? null, title: input.title, description: input.description, priority: input.priority,
      dueAt: dueUtc, assignedMembershipId: input.assignedMembershipId, createdByUserId: p.userId, recurrence: input.recurrence, blockedByTaskId: input.blockedByTaskId,
      status: input.blockedByTaskId ? "blocked" : "open",
      source: link?.source ?? "manual", sourceType: link?.sourceType ?? null, sourceId: link?.sourceId ?? null,
    }).returning();
    if (input.checklist.length) await tx.insert(taskChecklistItems).values(input.checklist.map((label, i) => ({ orgId: p.orgId, taskId: t.id, label, position: i })));
    await addTimeline(tx, ctx, { entityType: "task", entityId: t.id, kind: "created", toStatus: t.status });
    await auditAs(tx, ctx, "task.created", "task", t.id, undefined, t);
    if (t.assignedMembershipId) await emit(tx, ctx, "task.assigned", { taskId: t.id, membershipId: t.assignedMembershipId });
    return t;
  });
}

const NEXT: Record<string, (d: Date) => Date> = {
  daily: (d) => new Date(d.getTime() + 86_400_000),
  weekly: (d) => new Date(d.getTime() + 7 * 86_400_000),
  monthly: (d) => { const n = new Date(d); n.setUTCMonth(n.getUTCMonth() + 1); return n; },
};

// status changes: assignee or manager; dependencies must be done first; recurring tasks spawn their next occurrence
export async function setTaskStatus(ctx: TenantCtx, id: string, status: (typeof TASK_STATUSES)[number], note?: string | null) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const t = await loadTask(tx, p.orgId, id);
    const a = access(p, t);
    if (!a.read) throw new NotFoundError();
    if (!a.work) throw new ForbiddenError();
    if (status === "cancelled" && !a.manage) throw new ForbiddenError("Only a manager can cancel this task.");
    if (["in_progress", "done"].includes(status) && t.blockedByTaskId) {
      const [dep] = await tx.select({ status: tasks.status, title: tasks.title }).from(tasks).where(eq(tasks.id, t.blockedByTaskId));
      if (dep && dep.status !== "done") throw new ValidationError(`Blocked by “${dep.title}”, which isn't done yet.`);
    }
    const [after] = await tx.update(tasks).set({ status, completedAt: status === "done" ? new Date() : null }).where(eq(tasks.id, id)).returning();
    await addTimeline(tx, ctx, { entityType: "task", entityId: id, kind: "status", fromStatus: t.status, toStatus: status, body: note ?? null });
    await auditAs(tx, ctx, "task.status_changed", "task", id, { status: t.status }, { status });
    if (status === "done") {
      // unblock dependants
      await tx.update(tasks).set({ status: "open" }).where(and(eq(tasks.blockedByTaskId, id), eq(tasks.status, "blocked")));
      if (t.recurrence !== "none") {
        const base = t.dueAt ?? new Date();
        const [next] = await tx.insert(tasks).values({
          orgId: t.orgId, propertyId: t.propertyId, buildingId: t.buildingId, title: t.title, description: t.description, priority: t.priority,
          dueAt: NEXT[t.recurrence](base), assignedMembershipId: t.assignedMembershipId, createdByUserId: t.createdByUserId,
          recurrence: t.recurrence, source: "recurring", sourceType: "task", sourceId: t.id,
        }).returning();
        const items = await tx.select().from(taskChecklistItems).where(eq(taskChecklistItems.taskId, id));
        if (items.length) await tx.insert(taskChecklistItems).values(items.map((i) => ({ orgId: t.orgId, taskId: next.id, label: i.label, position: i.position })));
        await addTimeline(tx, ctx, { entityType: "task", entityId: next.id, kind: "created", body: "Next occurrence of a recurring task." });
      }
    }
    return after;
  });
}

export async function toggleChecklistItem(ctx: TenantCtx, itemId: string, done: boolean) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const [item] = await tx.select().from(taskChecklistItems).where(and(eq(taskChecklistItems.id, itemId), eq(taskChecklistItems.orgId, p.orgId)));
    if (!item) throw new NotFoundError();
    const t = await loadTask(tx, p.orgId, item.taskId);
    const a = access(p, t);
    if (!a.read) throw new NotFoundError();
    if (!a.work) throw new ForbiddenError();
    await tx.update(taskChecklistItems).set({ done }).where(eq(taskChecklistItems.id, itemId));
    return t.id;
  });
}

export async function assignTask(ctx: TenantCtx, id: string, membershipId: string | null) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const t = await loadTask(tx, p.orgId, id);
    const a = access(p, t);
    if (!a.read) throw new NotFoundError();
    if (!a.manage) throw new ForbiddenError();
    if (membershipId && !(await taskAssignees(tx, p.orgId, t.propertyId)).some((x) => x.membershipId === membershipId)) throw new ValidationError("That person can't be assigned work at this property.", "membershipId");
    await tx.update(tasks).set({ assignedMembershipId: membershipId }).where(eq(tasks.id, id));
    await addTimeline(tx, ctx, { entityType: "task", entityId: id, kind: "assigned", body: membershipId ? "Reassigned." : "Unassigned." });
    await auditAs(tx, ctx, "task.assigned", "task", id, { membershipId: t.assignedMembershipId }, { membershipId });
    if (membershipId && membershipId !== t.assignedMembershipId) await emit(tx, ctx, "task.assigned", { taskId: id, membershipId });
  });
}

export async function commentOnTask(ctx: TenantCtx, id: string, body: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const t = await loadTask(tx, p.orgId, id);
    if (!access(p, t).read) throw new NotFoundError();
    await addTimeline(tx, ctx, { entityType: "task", entityId: id, kind: "comment", body });
  });
}


