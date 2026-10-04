import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  buildings, memberships, messageReads, messageTemplates, messageThreads, messages, organizations, properties, residents, roles, unitOccupancies, units, users,
  THREAD_CATEGORIES,
} from "../../db/schema";
import { can, ForbiddenError, NotFoundError, type Principal } from "../../authz/authorize";
import type { Tx } from "../../db/client";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../context";
import { pageArgs, scopeCondition, toPage, visiblePropertyIds, type Page } from "../scope";
import { emit } from "../ops/core";
import { renderTemplate, templateVariables, TEMPLATE_VARIABLES } from "@/lib/template";

type ThreadRow = typeof messageThreads.$inferSelect;

/* ───────────── access ───────────── */

// staff handle conversations for properties in scope (message.manage); residents see only their own threads
function access(p: Principal, t: ThreadRow) {
  const staff = t.orgId === p.orgId && can(p, "message.manage", { orgId: t.orgId, propertyId: t.propertyId, buildingId: t.buildingId });
  const resident = t.orgId === p.orgId && !!t.residentUserId && t.residentUserId === p.userId;
  return { staff, resident, read: staff || resident };
}

export const canUseMessages = (p: Principal) => p.permissions.has("message.manage") || (p.role.category === "resident" && p.permissions.has("message.use"));

function visibleWhere(p: Principal): SQL {
  if (p.permissions.has("message.manage")) return scopeCondition(p, { property: messageThreads.propertyId, building: messageThreads.buildingId }) ?? sql`true`;
  if (p.role.category === "resident" && p.permissions.has("message.use")) return eq(messageThreads.residentUserId, p.userId);
  return sql`false`;
}

const unreadSql = (p: Principal) => sql<boolean>`(${messageThreads.lastMessageAt} > coalesce((select r.last_read_at from message_reads r where r.thread_id = message_threads.id and r.user_id = ${p.userId}), 'epoch'::timestamptz))`;

/* ───────────── lists ───────────── */

export type ThreadView = "open" | "unassigned" | "mine" | "awaiting" | "closed" | "all";
export type ThreadListRow = { id: string; subject: string; category: string; status: string; lastMessageAt: Date; lastMessagePreview: string | null; lastFromStaff: boolean; residentName: string | null; unitNumber: string | null; propertyName: string; assigneeName: string | null; unread: boolean };

export async function listThreads(ctx: TenantCtx, opts: { view?: ThreadView; propertyId?: string; page?: number }): Promise<Page<ThreadListRow>> {
  const p = ctx.principal;
  if (!canUseMessages(p)) throw new ForbiddenError();
  const { page, pageSize, offset } = pageArgs(opts.page);
  const view = opts.view ?? "open";
  const cond: Record<ThreadView, SQL | undefined> = {
    open: eq(messageThreads.status, "open"),
    unassigned: and(eq(messageThreads.status, "open"), isNull(messageThreads.assignedMembershipId)),
    mine: and(eq(messageThreads.status, "open"), eq(messageThreads.assignedMembershipId, p.membershipId)),
    awaiting: and(eq(messageThreads.status, "open"), eq(messageThreads.lastFromStaff, false)),
    closed: eq(messageThreads.status, "closed"),
    all: undefined,
  };
  return tenantTx(ctx, async (tx) => {
    const where = and(eq(messageThreads.orgId, p.orgId), visibleWhere(p), cond[view], opts.propertyId ? eq(messageThreads.propertyId, opts.propertyId) : undefined);
    const [{ n }] = await tx.select({ n: count() }).from(messageThreads).where(where);
    const assignee = sql<string | null>`(select u.name from memberships m join users u on u.id = m.user_id where m.id = message_threads.assigned_membership_id)`;
    const rows = await tx.select({
      id: messageThreads.id, subject: messageThreads.subject, category: messageThreads.category, status: messageThreads.status, lastMessageAt: messageThreads.lastMessageAt,
      lastMessagePreview: messageThreads.lastMessagePreview, lastFromStaff: messageThreads.lastFromStaff, residentName: sql<string | null>`${residents.firstName} || ' ' || ${residents.lastName}`,
      unitNumber: units.number, propertyName: properties.name, assigneeName: assignee, unread: unreadSql(p),
    }).from(messageThreads).innerJoin(properties, eq(properties.id, messageThreads.propertyId)).leftJoin(units, eq(units.id, messageThreads.unitId))
      .leftJoin(residents, eq(residents.id, messageThreads.residentId)).where(where).orderBy(desc(messageThreads.lastMessageAt)).limit(pageSize).offset(offset);
    return toPage(rows, n, page, pageSize);
  });
}

// residents: threads with unread replies; staff: open threads waiting on a reply in scope
export async function messageBadgeCount(ctx: TenantCtx): Promise<number> {
  const p = ctx.principal;
  if (!canUseMessages(p)) return 0;
  const [r] = await tenantTx(ctx, (tx) => tx.select({ n: count() }).from(messageThreads).where(and(eq(messageThreads.orgId, p.orgId), visibleWhere(p),
    p.permissions.has("message.manage") ? and(eq(messageThreads.status, "open"), eq(messageThreads.lastFromStaff, false)) : and(eq(messageThreads.lastFromStaff, true), unreadSql(p)))));
  return r.n;
}

/* ───────────── thread ───────────── */

async function loadThread(tx: Tx, orgId: string, id: string) {
  const [t] = await tx.select().from(messageThreads).where(and(eq(messageThreads.id, id), eq(messageThreads.orgId, orgId)));
  if (!t) throw new NotFoundError();
  return t;
}

async function threadVars(tx: Tx, p: Principal, t: ThreadRow, staffName: string) {
  const [ctxRow] = await tx.select({ property: properties.name, org: organizations.name }).from(properties).innerJoin(organizations, eq(organizations.id, properties.orgId)).where(eq(properties.id, t.propertyId));
  const [r] = t.residentId ? await tx.select({ first: residents.firstName, last: residents.lastName }).from(residents).where(eq(residents.id, t.residentId)) : [];
  const [u] = t.unitId ? await tx.select({ number: units.number, building: buildings.name }).from(units).innerJoin(buildings, eq(buildings.id, units.buildingId)).where(eq(units.id, t.unitId)) : [];
  return {
    resident_name: r ? `${r.first} ${r.last}` : null, resident_first_name: r?.first ?? null, unit: u?.number ?? null, building: u?.building ?? null,
    property: ctxRow?.property ?? null, org_name: ctxRow?.org ?? null, staff_name: staffName,
    today: new Date().toLocaleDateString("en-CA", { timeZone: p.orgTimezone ?? "UTC", dateStyle: "long" }),
  };
}

export async function getThread(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const t = await loadThread(tx, p.orgId, id);
    const a = access(p, t);
    if (!a.read) throw new NotFoundError();
    const msgs = await tx.select({ m: messages, authorName: users.name }).from(messages).leftJoin(users, eq(users.id, messages.authorUserId))
      .where(and(eq(messages.threadId, id), a.staff ? undefined : eq(messages.internal, false))).orderBy(asc(messages.createdAt));
    await tx.insert(messageReads).values({ orgId: p.orgId, threadId: id, userId: p.userId, lastReadAt: new Date() })
      .onConflictDoUpdate({ target: [messageReads.threadId, messageReads.userId], set: { lastReadAt: new Date() } });
    const [labels] = await tx.select({ propertyName: properties.name, unitNumber: units.number, buildingName: buildings.name, residentName: sql<string | null>`${residents.firstName} || ' ' || ${residents.lastName}`, residentId: residents.id })
      .from(messageThreads).innerJoin(properties, eq(properties.id, messageThreads.propertyId)).leftJoin(units, eq(units.id, messageThreads.unitId))
      .leftJoin(buildings, eq(buildings.id, units.buildingId)).leftJoin(residents, eq(residents.id, messageThreads.residentId)).where(eq(messageThreads.id, id));
    let templates: { id: string; name: string; text: string; warnings: string[] }[] = [];
    let assignees: { membershipId: string; name: string }[] = [];
    if (a.staff) {
      const [me] = await tx.select({ name: users.name }).from(users).where(eq(users.id, p.userId));
      const vars = await threadVars(tx, p, t, me?.name ?? "");
      const rows = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.orgId, p.orgId), or(isNull(messageTemplates.propertyId), eq(messageTemplates.propertyId, t.propertyId)))).orderBy(asc(messageTemplates.name));
      templates = rows.map((x) => { const r = renderTemplate(x.body, vars); return { id: x.id, name: x.name, text: r.text, warnings: [...r.unknown.map((u) => `Unknown {{${u}}}`), ...r.missing.map((m) => `No value for {{${m}}}`)] }; });
      assignees = await threadAssignees(tx, p.orgId, t.propertyId);
    }
    return { thread: t, messages: msgs, labels, access: a, templates, assignees };
  });
}

// staff who can answer resident messages at the property
async function threadAssignees(tx: Tx, orgId: string, propertyId: string) {
  return tx.selectDistinct({ membershipId: memberships.id, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active"), eq(roles.category, "staff"), sql`${roles.permissions} @> array['message.manage']`,
      or(eq(roles.scopeLevel, "org"), sql`exists (select 1 from membership_scopes s where s.membership_id = ${memberships.id} and (s.property_id = ${propertyId}
        or s.portfolio_id = (select portfolio_id from properties where id = ${propertyId}) or s.building_id in (select id from buildings where property_id = ${propertyId})))`)))
    .orderBy(asc(users.name));
}

export const newThreadSchema = z.object({
  subject: z.string().trim().min(3, "Add a subject.").max(140),
  category: z.enum(THREAD_CATEGORIES).default("general"),
  body: z.string().trim().min(1, "Write a message.").max(5000),
  unitId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  residentId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
});

// residents write to management about one of their units; staff start a conversation with a resident who uses the app
export async function startThread(ctx: TenantCtx, input: z.infer<typeof newThreadSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    let place: { propertyId: string; buildingId: string; unitId: string };
    let residentId: string | null, residentUserId: string | null;
    const staff = p.permissions.has("message.manage");
    if (p.role.category === "resident") {
      if (!p.permissions.has("message.use")) throw new ForbiddenError();
      const unitId = input.unitId && p.unitIds.has(input.unitId) ? input.unitId : [...p.unitIds][0];
      if (!unitId) throw new ValidationError("Your account isn't linked to a unit yet.");
      const [u] = await tx.select().from(units).where(eq(units.id, unitId));
      place = { propertyId: u.propertyId, buildingId: u.buildingId, unitId: u.id };
      residentId = p.residentId; residentUserId = p.userId;
    } else if (staff) {
      if (!input.residentId) throw new ValidationError("Choose a resident.", "residentId");
      const [r] = await tx.select().from(residents).where(and(eq(residents.id, input.residentId), eq(residents.orgId, p.orgId)));
      if (!r) throw new NotFoundError();
      if (!r.userId) throw new ValidationError("This resident hasn't joined the app yet. Invite them first, or contact them by phone or email.", "residentId");
      const occ = await tx.select({ unitId: units.id, propertyId: units.propertyId, buildingId: units.buildingId }).from(unitOccupancies).innerJoin(units, eq(units.id, unitOccupancies.unitId))
        .where(and(eq(unitOccupancies.residentId, r.id), sql`(${unitOccupancies.endsOn} is null or ${unitOccupancies.endsOn} >= current_date)`)).orderBy(desc(unitOccupancies.isPrimary));
      const inScope = occ.find((o) => can(p, "message.manage", { orgId: p.orgId, propertyId: o.propertyId, buildingId: o.buildingId }));
      if (!inScope) throw new ForbiddenError("This resident doesn't live in a property you manage.");
      place = inScope; residentId = r.id; residentUserId = r.userId;
    } else throw new ForbiddenError();
    const now = new Date();
    const [t] = await tx.insert(messageThreads).values({
      orgId: p.orgId, ...place, residentId, residentUserId, subject: input.subject, category: input.category, createdByUserId: p.userId,
      lastMessageAt: now, lastMessagePreview: input.body.slice(0, 140), lastFromStaff: p.role.category !== "resident",
      assignedMembershipId: p.role.category !== "resident" ? p.membershipId : null,
    }).returning();
    const [m] = await tx.insert(messages).values({ orgId: p.orgId, threadId: t.id, authorUserId: p.userId, fromStaff: p.role.category !== "resident", body: input.body, createdAt: now }).returning();
    await tx.insert(messageReads).values({ orgId: p.orgId, threadId: t.id, userId: p.userId, lastReadAt: now });
    await auditAs(tx, ctx, "message_thread.created", "message_thread", t.id, undefined, { subject: t.subject, residentId });
    await emit(tx, ctx, "message.posted", { threadId: t.id, messageId: m.id, fromStaff: m.fromStaff });
    return t;
  });
}

export const postSchema = z.object({
  body: z.string().trim().min(1, "Write a message.").max(5000),
  internal: z.union([z.literal("on"), z.literal("")]).optional().transform((v) => v === "on"),
});

export async function postMessage(ctx: TenantCtx, threadId: string, input: z.infer<typeof postSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const t = await loadThread(tx, p.orgId, threadId);
    const a = access(p, t);
    if (!a.read) throw new NotFoundError();
    if (input.internal && !a.staff) throw new ForbiddenError();
    const fromStaff = a.staff && !a.resident;
    const now = new Date();
    const [m] = await tx.insert(messages).values({ orgId: p.orgId, threadId, authorUserId: p.userId, fromStaff, internal: input.internal, body: input.body, createdAt: now }).returning();
    if (!input.internal) {
      // a resident writing into a closed conversation reopens it
      await tx.update(messageThreads).set({ lastMessageAt: now, lastMessagePreview: input.body.slice(0, 140), lastFromStaff: fromStaff, ...(t.status === "closed" && !fromStaff ? { status: "open" } : {}) })
        .where(eq(messageThreads.id, threadId));
      await emit(tx, ctx, "message.posted", { threadId, messageId: m.id, fromStaff });
    }
    await tx.insert(messageReads).values({ orgId: p.orgId, threadId, userId: p.userId, lastReadAt: now })
      .onConflictDoUpdate({ target: [messageReads.threadId, messageReads.userId], set: { lastReadAt: now } });
    return m;
  });
}

export const threadUpdateSchema = z.object({
  status: z.enum(["open", "closed"]).optional(),
  assignedMembershipId: z.string().optional(),
});

export async function updateThread(ctx: TenantCtx, threadId: string, input: z.infer<typeof threadUpdateSchema>) {
  const p = ctx.principal;
  return tenantTx(ctx, async (tx) => {
    const t = await loadThread(tx, p.orgId, threadId);
    const a = access(p, t);
    if (!a.staff) throw a.read ? new ForbiddenError() : new NotFoundError();
    const patch: Partial<ThreadRow> = {};
    if (input.status && input.status !== t.status) patch.status = input.status;
    if (input.assignedMembershipId !== undefined) {
      const m = input.assignedMembershipId || null;
      if (m && !(await threadAssignees(tx, p.orgId, t.propertyId)).some((x) => x.membershipId === m)) throw new ValidationError("That person can't handle messages for this property.", "assignedMembershipId");
      if (m !== t.assignedMembershipId) patch.assignedMembershipId = m;
    }
    if (!Object.keys(patch).length) return t;
    const [after] = await tx.update(messageThreads).set(patch).where(eq(messageThreads.id, threadId)).returning();
    await auditAs(tx, ctx, "message_thread.updated", "message_thread", threadId, { status: t.status, assignedMembershipId: t.assignedMembershipId }, patch);
    return after;
  });
}

/* ───────────── templates ───────────── */

export async function listMessageTemplates(ctx: TenantCtx) {
  const p = ctx.principal;
  if (!p.permissions.has("message.manage")) throw new ForbiddenError();
  const visible = visiblePropertyIds(p);
  return tenantTx(ctx, (tx) => tx.select({ t: messageTemplates, propertyName: properties.name }).from(messageTemplates).leftJoin(properties, eq(properties.id, messageTemplates.propertyId))
    .where(and(eq(messageTemplates.orgId, p.orgId), or(isNull(messageTemplates.propertyId), visible ? (visible.length ? inArray(messageTemplates.propertyId, visible) : sql`false`) : undefined)))
    .orderBy(asc(messageTemplates.name)));
}

export const templateSchema = z.object({
  name: z.string().trim().min(2, "Name the template.").max(80),
  propertyId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null),
  body: z.string().trim().min(5, "Write the template.").max(5000).refine((b) => templateVariables(b).every((v) => v in TEMPLATE_VARIABLES), {
    message: `Use only ${Object.keys(TEMPLATE_VARIABLES).map((v) => `{{${v}}}`).join(", ")}.`,
  }),
});

const canManageTemplate = (p: Principal, propertyId: string | null) =>
  propertyId ? can(p, "message.manage", { orgId: p.orgId, propertyId }) : p.role.scopeLevel === "org" && can(p, "message.manage");

export async function createMessageTemplate(ctx: TenantCtx, input: z.infer<typeof templateSchema>) {
  const p = ctx.principal;
  if (!canManageTemplate(p, input.propertyId)) throw new ForbiddenError(input.propertyId ? undefined : "Organization-wide templates need an organization-wide role. Choose one of your properties.");
  return tenantTx(ctx, async (tx) => {
    const [t] = await tx.insert(messageTemplates).values({ orgId: p.orgId, ...input, createdByUserId: p.userId }).returning();
    await auditAs(tx, ctx, "message_template.created", "message_template", t.id, undefined, t);
    return t;
  });
}

export async function deleteMessageTemplate(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  await tenantTx(ctx, async (tx) => {
    const [t] = await tx.select().from(messageTemplates).where(and(eq(messageTemplates.id, id), eq(messageTemplates.orgId, p.orgId)));
    if (!t) throw new NotFoundError();
    if (!canManageTemplate(p, t.propertyId)) throw new ForbiddenError();
    await tx.delete(messageTemplates).where(eq(messageTemplates.id, id));
    await auditAs(tx, ctx, "message_template.deleted", "message_template", id, t);
  });
}

// residents staff may start a conversation with: app users currently living in scope
export async function messageableResidents(ctx: TenantCtx, q?: string) {
  const p = ctx.principal;
  if (!p.permissions.has("message.manage")) return [];
  const like = q?.trim() ? `%${q.trim().replace(/[%_\\]/g, "\\$&")}%` : null;
  return tenantTx(ctx, (tx) => tx.selectDistinct({ id: residents.id, first: residents.firstName, last: residents.lastName, unit: units.number, building: buildings.name })
    .from(residents).innerJoin(unitOccupancies, eq(unitOccupancies.residentId, residents.id)).innerJoin(units, eq(units.id, unitOccupancies.unitId)).innerJoin(buildings, eq(buildings.id, units.buildingId))
    .where(and(eq(residents.orgId, p.orgId), sql`${residents.userId} is not null`, sql`(${unitOccupancies.endsOn} is null or ${unitOccupancies.endsOn} >= current_date)`,
      scopeCondition(p, { property: units.propertyId, building: units.buildingId }),
      like ? or(sql`${residents.firstName} || ' ' || ${residents.lastName} ilike ${like}`, sql`${units.number} ilike ${like}`) : undefined))
    .orderBy(asc(residents.lastName)).limit(50));
}


