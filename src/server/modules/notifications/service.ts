import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { withContext, type Tx } from "../../db/client";
import {
  complaints, incidents, inspections, memberships, notificationPreferences, notifications, organizations, outboxEvents, roles,
  tasks, timelineEvents, users, workOrders,
} from "../../db/schema";
import type { TenantCtx } from "../context";
import { tenantTx } from "../context";
import { sendEmail } from "../../mail/mailer";
import { notificationTemplate } from "../../mail/templates";
import { env } from "../../env";
import { log } from "../../log";
import { addTimeline } from "../ops/core";

/* ───── catalogue ───── */

// every notification kind with its default email behaviour (users can override per kind)
export const NOTIFICATION_KINDS = {
  "workorder.created": { label: "New maintenance requests at my properties", emailDefault: false },
  "workorder.emergency": { label: "Emergency maintenance requests", emailDefault: true },
  "workorder.assigned": { label: "Work assigned to me or my company", emailDefault: true },
  "workorder.updated": { label: "Updates on my requests", emailDefault: true },
  "workorder.comment": { label: "New messages on requests I'm involved in", emailDefault: true },
  "workorder.sla_breached": { label: "Requests that miss their SLA", emailDefault: true },
  "task.assigned": { label: "Tasks assigned to me", emailDefault: false },
  "incident.reported": { label: "New incidents at my properties", emailDefault: false },
  "incident.escalated": { label: "Incidents escalated to high or critical", emailDefault: true },
  "complaint.received": { label: "New complaints at my properties", emailDefault: false },
  "complaint.updated": { label: "Updates on my complaints", emailDefault: true },
  "inspection.failed": { label: "Failed inspections", emailDefault: true },
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

/* ───── recipients ───── */

// active users whose role grants `perm` and whose scope covers the property (or building)
async function usersWithPermAt(tx: Tx, orgId: string, perm: string, propertyId: string, buildingId: string | null): Promise<string[]> {
  const rows = await tx.selectDistinct({ userId: memberships.userId }).from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(
      eq(memberships.orgId, orgId), eq(memberships.status, "active"), sql`${perm} = any(${roles.permissions})`,
      or(eq(roles.scopeLevel, "org"), sql`exists (select 1 from membership_scopes s where s.membership_id = ${memberships.id} and (
        s.property_id = ${propertyId}
        or s.portfolio_id = (select portfolio_id from properties where id = ${propertyId})
        or ${buildingId ? sql`s.building_id = ${buildingId}` : sql`s.building_id in (select id from buildings where property_id = ${propertyId})`}))`),
    ));
  return rows.map((r) => r.userId);
}

async function membershipUser(tx: Tx, membershipId: string | null): Promise<string[]> {
  if (!membershipId) return [];
  const [m] = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.id, membershipId), eq(memberships.status, "active")));
  return m ? [m.userId] : [];
}

async function vendorUsers(tx: Tx, vendorId: string | null): Promise<string[]> {
  if (!vendorId) return [];
  const rows = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.vendorId, vendorId), eq(memberships.status, "active")));
  return rows.map((r) => r.userId);
}

type Delivery = { userIds: string[]; kind: NotificationKind; title: string; body?: string | null; href: string; entityType: string; entityId: string };

/* ───── event handlers: event → deliveries ───── */

type Event = typeof outboxEvents.$inferSelect;
const STATUS_WORDS: Record<string, string> = {
  acknowledged: "was acknowledged", assigned: "was assigned", scheduled: "was scheduled", in_progress: "is in progress",
  awaiting_vendor: "is waiting on a vendor", awaiting_resident: "needs your input", completed: "was completed", closed: "was closed", cancelled: "was cancelled",
};

async function deliveriesFor(tx: Tx, e: Event, base: string): Promise<Delivery[]> {
  const p = e.payload as Record<string, string | null | undefined>;
  switch (e.type) {
    case "workorder.created": {
      const [wo] = await tx.select().from(workOrders).where(eq(workOrders.id, p.workOrderId!));
      if (!wo) return [];
      const managers = await usersWithPermAt(tx, e.orgId, "workorder.manage", wo.propertyId, wo.buildingId);
      return [{ userIds: managers, kind: wo.isEmergency ? "workorder.emergency" : "workorder.created", title: `${wo.isEmergency ? "Emergency: " : ""}#${wo.number} ${wo.title}`, body: wo.description.slice(0, 280), href: `${base}/maintenance/${wo.id}`, entityType: "work_order", entityId: wo.id }];
    }
    case "workorder.assigned": {
      const [wo] = await tx.select().from(workOrders).where(eq(workOrders.id, p.workOrderId!));
      if (!wo) return [];
      const ids = [...(await membershipUser(tx, p.membershipId ?? null)), ...(await vendorUsers(tx, p.vendorId ?? null))];
      return [{ userIds: ids, kind: "workorder.assigned", title: `Assigned: #${wo.number} ${wo.title}`, body: wo.isEmergency ? "Emergency — respond as soon as possible." : null, href: `${base}/maintenance/${wo.id}`, entityType: "work_order", entityId: wo.id }];
    }
    case "workorder.status_changed": {
      const [wo] = await tx.select().from(workOrders).where(eq(workOrders.id, p.workOrderId!));
      if (!wo) return [];
      const out: Delivery[] = [];
      const words = STATUS_WORDS[p.to ?? ""] ?? "was updated";
      if (wo.submittedByUserId) out.push({ userIds: [wo.submittedByUserId], kind: "workorder.updated", title: `Your request #${wo.number} ${words}`, body: wo.title, href: `${base}/maintenance/${wo.id}`, entityType: "work_order", entityId: wo.id });
      // managers hear about progress made by staff/vendors in the field
      if (["completed", "awaiting_resident", "awaiting_vendor"].includes(p.to ?? "")) {
        out.push({ userIds: await usersWithPermAt(tx, e.orgId, "workorder.manage", wo.propertyId, wo.buildingId), kind: "workorder.updated", title: `#${wo.number} ${words}`, body: wo.title, href: `${base}/maintenance/${wo.id}`, entityType: "work_order", entityId: wo.id });
      }
      return out;
    }
    case "workorder.commented": {
      const [wo] = await tx.select().from(workOrders).where(eq(workOrders.id, p.workOrderId!));
      const [ev] = await tx.select().from(timelineEvents).where(eq(timelineEvents.id, p.eventId!));
      if (!wo || !ev) return [];
      // only people allowed to see the comment's visibility level get it
      const ids = new Set<string>([...(await membershipUser(tx, wo.assignedMembershipId)), ...(await vendorUsers(tx, wo.vendorId))]);
      if (ev.visibility === "public" && wo.submittedByUserId) ids.add(wo.submittedByUserId);
      for (const m of await usersWithPermAt(tx, e.orgId, "workorder.manage", wo.propertyId, wo.buildingId)) ids.add(m);
      return [{ userIds: [...ids], kind: "workorder.comment", title: `New message on #${wo.number}`, body: ev.body?.slice(0, 280), href: `${base}/maintenance/${wo.id}`, entityType: "work_order", entityId: wo.id }];
    }
    case "workorder.sla_breached": {
      const [wo] = await tx.select().from(workOrders).where(eq(workOrders.id, p.workOrderId!));
      if (!wo) return [];
      const ids = [...(await usersWithPermAt(tx, e.orgId, "workorder.manage", wo.propertyId, wo.buildingId)), ...(await membershipUser(tx, wo.assignedMembershipId))];
      return [{ userIds: ids, kind: "workorder.sla_breached", title: `Overdue: #${wo.number} ${wo.title}`, body: "This request has passed its resolution target.", href: `${base}/maintenance/${wo.id}`, entityType: "work_order", entityId: wo.id }];
    }
    case "task.assigned": {
      const [t] = await tx.select().from(tasks).where(eq(tasks.id, p.taskId!));
      if (!t) return [];
      return [{ userIds: await membershipUser(tx, p.membershipId ?? t.assignedMembershipId), kind: "task.assigned", title: `Task: ${t.title}`, body: t.description?.slice(0, 280), href: `${base}/tasks/${t.id}`, entityType: "task", entityId: t.id }];
    }
    case "incident.created":
    case "incident.escalated": {
      const [i] = await tx.select().from(incidents).where(eq(incidents.id, p.incidentId!));
      if (!i) return [];
      const ids = await usersWithPermAt(tx, e.orgId, "incident.manage", i.propertyId, i.buildingId);
      // severity as it was when the event happened, not as it is now
      const sev = typeof p.severity === "string" ? p.severity : i.severity;
      const escalated = e.type === "incident.escalated" || (e.type === "incident.created" && ["high", "critical"].includes(sev));
      return [{ userIds: ids, kind: escalated ? "incident.escalated" : "incident.reported", title: `${escalated ? `${sev.toUpperCase()} incident` : "Incident"} #${i.number}: ${i.title}`, body: i.description.slice(0, 280), href: `${base}/incidents/${i.id}`, entityType: "incident", entityId: i.id }];
    }
    case "complaint.created": {
      const [c] = await tx.select().from(complaints).where(eq(complaints.id, p.complaintId!));
      if (!c) return [];
      return [{ userIds: await usersWithPermAt(tx, e.orgId, "complaint.manage", c.propertyId, c.buildingId), kind: "complaint.received", title: `Complaint #${c.number}: ${c.subject}`, href: `${base}/complaints/${c.id}`, entityType: "complaint", entityId: c.id }];
    }
    case "complaint.status_changed":
    case "complaint.commented": {
      const [c] = await tx.select().from(complaints).where(eq(complaints.id, p.complaintId!));
      if (!c) return [];
      if (e.type === "complaint.commented" && !p.byStaff) {
        const ids = [...(await membershipUser(tx, c.assignedMembershipId)), ...(await usersWithPermAt(tx, e.orgId, "complaint.manage", c.propertyId, c.buildingId))];
        return [{ userIds: ids, kind: "complaint.received", title: `New message on complaint #${c.number}`, href: `${base}/complaints/${c.id}`, entityType: "complaint", entityId: c.id }];
      }
      if (!c.submittedByUserId) return [];
      return [{ userIds: [c.submittedByUserId], kind: "complaint.updated", title: e.type === "complaint.commented" ? `Reply on your complaint #${c.number}` : `Your complaint #${c.number} is now ${p.to}`, body: c.subject, href: `${base}/complaints/${c.id}`, entityType: "complaint", entityId: c.id }];
    }
    case "inspection.failed": {
      const [i] = await tx.select().from(inspections).where(eq(inspections.id, p.inspectionId!));
      if (!i) return [];
      return [{ userIds: await usersWithPermAt(tx, e.orgId, "inspection.manage", i.propertyId, i.buildingId), kind: "inspection.failed", title: `Inspection failed: ${i.title}`, body: `${p.failed} item(s) failed.`, href: `${base}/inspections/${i.id}`, entityType: "inspection", entityId: i.id }];
    }
    default:
      return [];
  }
}

/* ───── worker ───── */

// delivers one event: idempotent per (event, user); the actor never notifies themselves
async function processEvent(e: Event): Promise<void> {
  const emails = await withContext({ orgId: e.orgId, system: true }, async (tx) => {
    // claim the event: another worker instance processing it concurrently skips it (no double emails)
    const claimed = await tx.execute(sql`select id from outbox_events where id = ${e.id} and processed_at is null for update skip locked`);
    if (!claimed.rows.length) return [];
    const [org] = await tx.select({ slug: organizations.slug, status: organizations.status }).from(organizations).where(eq(organizations.id, e.orgId));
    if (!org || org.status !== "active") {
      await tx.update(outboxEvents).set({ processedAt: new Date(), lastError: "org inactive" }).where(eq(outboxEvents.id, e.id));
      return [];
    }
    const deliveries = await deliveriesFor(tx, e, `/o/${org.slug}`);
    const emails: { to: string; title: string; body: string | null; href: string }[] = [];
    for (const d of deliveries) {
      const ids = [...new Set(d.userIds)].filter((u) => u !== e.actorUserId);
      if (!ids.length) continue;
      const prefs = await tx.select().from(notificationPreferences).where(and(eq(notificationPreferences.orgId, e.orgId), eq(notificationPreferences.kind, d.kind), inArray(notificationPreferences.userId, ids)));
      const inserted = await tx.insert(notifications)
        .values(ids.filter((u) => prefs.find((x) => x.userId === u)?.inApp !== false).map((userId) => ({
          orgId: e.orgId, userId, kind: d.kind, title: d.title.slice(0, 200), body: d.body ?? null, href: d.href, entityType: d.entityType, entityId: d.entityId, eventId: e.id,
        })))
        .onConflictDoNothing()
        .returning({ id: notifications.id, userId: notifications.userId });
      const wantEmail = ids.filter((u) => prefs.find((x) => x.userId === u)?.email ?? NOTIFICATION_KINDS[d.kind].emailDefault);
      if (wantEmail.length) {
        const recips = await tx.select({ id: users.id, email: users.email }).from(users).where(and(inArray(users.id, wantEmail), eq(users.status, "active")));
        for (const r of recips) emails.push({ to: r.email, title: d.title, body: d.body ?? null, href: d.href });
        const emailedIds = inserted.filter((n) => wantEmail.includes(n.userId)).map((n) => n.id);
        if (emailedIds.length) await tx.update(notifications).set({ emailedAt: new Date() }).where(inArray(notifications.id, emailedIds));
      }
    }
    await tx.update(outboxEvents).set({ processedAt: new Date(), attempts: e.attempts + 1, lastError: null }).where(eq(outboxEvents.id, e.id));
    return emails;
  });
  // send only after the transaction commits; failures are recorded in email_outbox
  for (const m of emails) await sendEmail(m.to, notificationTemplate(m.title, m.body, `${env().APP_URL}${m.href}`));
}

let draining: Promise<number> | null = null;

// processes pending events (oldest first); safe to call concurrently — runs are coalesced
export function drainOutbox(limit = 200): Promise<number> {
  draining ??= (async () => {
    let done = 0;
    try {
      const pending = await withContext({ system: true }, (tx) =>
        tx.select().from(outboxEvents).where(and(isNull(outboxEvents.processedAt), lt(outboxEvents.attempts, 5))).orderBy(asc(outboxEvents.createdAt)).limit(limit));
      for (const e of pending) {
        try {
          await processEvent(e);
          done++;
        } catch (err) {
          log.error("outbox.event_failed", { eventId: e.id, type: e.type, err });
          await withContext({ orgId: e.orgId, system: true }, (tx) =>
            tx.update(outboxEvents).set({ attempts: e.attempts + 1, lastError: String(err).slice(0, 500) }).where(eq(outboxEvents.id, e.id)));
        }
      }
    } finally {
      draining = null;
    }
    return done;
  })();
  return draining;
}

// flags open work orders past their resolution target exactly once and emits an event
export async function checkSlaBreaches(): Promise<number> {
  const due = await withContext({ system: true }, (tx) =>
    tx.select({ id: workOrders.id, orgId: workOrders.orgId }).from(workOrders)
      .where(and(isNull(workOrders.slaBreachedAt), lt(workOrders.resolveDueAt, new Date()),
        inArray(workOrders.status, ["new", "acknowledged", "assigned", "scheduled", "in_progress", "awaiting_vendor", "awaiting_resident"])))
      .limit(500));
  for (const w of due) {
    await withContext({ orgId: w.orgId, system: true }, async (tx) => {
      const updated = await tx.update(workOrders).set({ slaBreachedAt: new Date() }).where(and(eq(workOrders.id, w.id), isNull(workOrders.slaBreachedAt))).returning({ id: workOrders.id });
      if (!updated.length) return;
      await addTimeline(tx, { orgId: w.orgId, userId: null }, { entityType: "work_order", entityId: w.id, kind: "sla", body: "Resolution target missed.", visibility: "internal" });
      await tx.insert(outboxEvents).values({ orgId: w.orgId, type: "workorder.sla_breached", payload: { workOrderId: w.id } });
    });
  }
  return due.length;
}

/* ───── inbox & preferences (user-facing) ───── */

export async function unreadCount(ctx: TenantCtx): Promise<number> {
  const [r] = await tenantTx(ctx, (tx) => tx.select({ n: count() }).from(notifications)
    .where(and(eq(notifications.orgId, ctx.principal.orgId), eq(notifications.userId, ctx.principal.userId), isNull(notifications.readAt))));
  return r.n;
}

export async function listNotifications(ctx: TenantCtx, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  return tenantTx(ctx, (tx) => tx.select().from(notifications)
    .where(and(eq(notifications.orgId, ctx.principal.orgId), eq(notifications.userId, ctx.principal.userId), opts.unreadOnly ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.createdAt)).limit(Math.min(opts.limit ?? 50, 200)));
}

export async function markRead(ctx: TenantCtx, id: string | "all") {
  await tenantTx(ctx, (tx) => tx.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.orgId, ctx.principal.orgId), eq(notifications.userId, ctx.principal.userId), isNull(notifications.readAt), id === "all" ? undefined : eq(notifications.id, id))));
}

export async function getPreferences(ctx: TenantCtx) {
  const rows = await tenantTx(ctx, (tx) => tx.select().from(notificationPreferences).where(and(eq(notificationPreferences.orgId, ctx.principal.orgId), eq(notificationPreferences.userId, ctx.principal.userId))));
  return (Object.keys(NOTIFICATION_KINDS) as NotificationKind[]).map((kind) => {
    const r = rows.find((x) => x.kind === kind);
    return { kind, label: NOTIFICATION_KINDS[kind].label, email: r?.email ?? NOTIFICATION_KINDS[kind].emailDefault, inApp: r?.inApp ?? true };
  });
}

export async function savePreferences(ctx: TenantCtx, prefs: { kind: string; email: boolean; inApp: boolean }[]) {
  const valid = prefs.filter((p) => p.kind in NOTIFICATION_KINDS);
  await tenantTx(ctx, async (tx) => {
    for (const p of valid) {
      await tx.insert(notificationPreferences).values({ orgId: ctx.principal.orgId, userId: ctx.principal.userId, kind: p.kind, email: p.email, inApp: p.inApp })
        .onConflictDoUpdate({ target: [notificationPreferences.orgId, notificationPreferences.userId, notificationPreferences.kind], set: { email: p.email, inApp: p.inApp } });
    }
  });
}

