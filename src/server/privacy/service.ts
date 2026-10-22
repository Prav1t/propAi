import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withContext, type Tx } from "../db/client";
import {
  aiConversations, aiMessages, auditLogs, bookings, complaints, consents, files, legalHolds, memberships, messages, messageThreads,
  notificationPreferences, notifications, packages, parkingPermits, parkingViolations, privacyRequests, residents, retentionPolicies,
  roles, sessions, unitOccupancies, units, users, vehicles, visitors, workOrders,
} from "../db/schema";
import { authorize, NotFoundError } from "../authz/authorize";
import { writeAudit } from "../audit";
import { blobStore } from "../files/storage";
import { log } from "../log";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";

// Personal data requests (Iteration 11), built around principles found in PIPEDA and the GDPR — access/portability,
// erasure, retention, consent records. These are mechanisms an organization can use; they don't by themselves make
// anyone compliant with a particular law.

const EXPORT_DAYS = 7;

/* ───────────── people and overview ───────────── */

export async function findPeople(ctx: TenantCtx, q: string) {
  authorize(ctx.principal, "privacy.manage");
  const term = q.trim().slice(0, 100);
  if (term.length < 2) return [];
  return tenantTx(ctx, (tx) => tx.select({ id: residents.id, firstName: residents.firstName, lastName: residents.lastName, email: residents.email, userId: residents.userId })
    .from(residents).where(and(eq(residents.orgId, ctx.principal.orgId), or(ilike(residents.firstName, `%${term}%`), ilike(residents.lastName, `%${term}%`), ilike(residents.email, `%${term}%`))))
    .orderBy(residents.lastName).limit(20));
}

export async function getPrivacyOverview(ctx: TenantCtx) {
  authorize(ctx.principal, "privacy.manage");
  return tenantTx(ctx, async (tx) => {
    const requests = await tx.select({ r: privacyRequests, by: users.name }).from(privacyRequests).leftJoin(users, eq(users.id, privacyRequests.requestedByUserId))
      .where(eq(privacyRequests.orgId, ctx.principal.orgId)).orderBy(desc(privacyRequests.createdAt)).limit(50);
    const holds = await tx.select({ h: legalHolds, first: residents.firstName, last: residents.lastName }).from(legalHolds).leftJoin(residents, eq(residents.id, legalHolds.residentId))
      .where(and(eq(legalHolds.orgId, ctx.principal.orgId), isNull(legalHolds.releasedAt))).orderBy(desc(legalHolds.createdAt));
    const [retention] = await tx.select().from(retentionPolicies).where(eq(retentionPolicies.orgId, ctx.principal.orgId));
    return {
      requests: requests.map(({ r, by }) => ({ ...r, requestedBy: by, downloadable: r.kind === "export" && r.status === "completed" && !!(r.result as { storageKey?: string }).storageKey && exportLive(r.createdAt) })),
      holds: holds.map(({ h, first, last }) => ({ ...h, subject: first ? `${first} ${last}` : "Account" })),
      retention: retention ?? null,
    };
  });
}

const exportLive = (createdAt: Date) => Date.now() - createdAt.getTime() < EXPORT_DAYS * 86_400_000;

async function loadResident(tx: Tx, orgId: string, residentId: string) {
  const [r] = await tx.select().from(residents).where(and(eq(residents.id, residentId), eq(residents.orgId, orgId)));
  if (!r) throw new NotFoundError();
  return r;
}

async function activeHold(tx: Tx, orgId: string, residentId: string, userId: string | null) {
  const [h] = await tx.select().from(legalHolds).where(and(eq(legalHolds.orgId, orgId), isNull(legalHolds.releasedAt),
    or(eq(legalHolds.residentId, residentId), userId ? eq(legalHolds.userId, userId) : sql`false`)));
  return h ?? null;
}

/* ───────────── export (access and portability) ───────────── */

// everything this organization holds about one resident (and their app account here), as JSON
export async function exportPerson(ctx: TenantCtx, residentId: string): Promise<{ requestId: string; counts: Record<string, number> }> {
  authorize(ctx.principal, "privacy.manage");
  const orgId = ctx.principal.orgId;
  const data = await tenantTx(ctx, async (tx) => {
    const r = await loadResident(tx, orgId, residentId);
    const uid = r.userId;
    const vehicleRows = await tx.select().from(vehicles).where(and(eq(vehicles.orgId, orgId), eq(vehicles.residentId, residentId)));
    const vehicleIds = vehicleRows.map((v) => v.id);
    const threads = await tx.select().from(messageThreads).where(and(eq(messageThreads.orgId, orgId), or(eq(messageThreads.residentId, residentId), uid ? eq(messageThreads.residentUserId, uid) : sql`false`)));
    // owner-only tables (assistant chats, notifications) are read in the system context, after the permission check above
    const personal = uid ? await withContext({ orgId, system: true }, async (stx) => {
      const convs = await stx.select().from(aiConversations).where(and(eq(aiConversations.orgId, orgId), eq(aiConversations.userId, uid)));
      return {
        assistantConversations: await Promise.all(convs.map(async (c) => ({
          title: c.title, createdAt: c.createdAt,
          messages: await stx.select({ role: aiMessages.role, content: aiMessages.content, createdAt: aiMessages.createdAt }).from(aiMessages).where(and(eq(aiMessages.conversationId, c.id), inArray(aiMessages.role, ["user", "assistant"]))).orderBy(aiMessages.seq),
        }))),
        notifications: await stx.select({ title: notifications.title, body: notifications.body, createdAt: notifications.createdAt, readAt: notifications.readAt }).from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.userId, uid))),
        notificationPreferences: await stx.select({ kind: notificationPreferences.kind, email: notificationPreferences.email, inApp: notificationPreferences.inApp }).from(notificationPreferences).where(and(eq(notificationPreferences.orgId, orgId), eq(notificationPreferences.userId, uid))),
      };
    }) : { assistantConversations: [], notifications: [], notificationPreferences: [] };
    const profile = r;
    return {
      generatedAt: new Date().toISOString(),
      note: "Personal data this organization holds about this person. Internal staff notes are marked internal; review before sending.",
      profile,
      account: uid ? (await tx.select({ email: users.email, name: users.name, createdAt: users.createdAt, lastLoginAt: users.lastLoginAt, mfaEnabled: users.mfaEnabled }).from(users).where(eq(users.id, uid)))[0] ?? null : null,
      occupancies: await tx.select({ unit: units.number, relationship: unitOccupancies.relationship, isPrimary: unitOccupancies.isPrimary, startsOn: unitOccupancies.startsOn, endsOn: unitOccupancies.endsOn })
        .from(unitOccupancies).innerJoin(units, eq(units.id, unitOccupancies.unitId)).where(eq(unitOccupancies.residentId, residentId)),
      workOrders: await tx.select({ number: workOrders.number, title: workOrders.title, description: workOrders.description, status: workOrders.status, entryNotes: workOrders.entryNotes, createdAt: workOrders.createdAt, completedAt: workOrders.completedAt })
        .from(workOrders).where(and(eq(workOrders.orgId, orgId), or(eq(workOrders.residentId, residentId), uid ? eq(workOrders.submittedByUserId, uid) : sql`false`))),
      complaints: await tx.select({ number: complaints.number, subject: complaints.subject, description: complaints.description, status: complaints.status, resolution: complaints.resolution, createdAt: complaints.createdAt })
        .from(complaints).where(and(eq(complaints.orgId, orgId), or(eq(complaints.residentId, residentId), uid ? eq(complaints.submittedByUserId, uid) : sql`false`))),
      bookings: await tx.select({ number: bookings.number, startsAt: bookings.startsAt, endsAt: bookings.endsAt, status: bookings.status, purpose: bookings.purpose, guests: bookings.guests })
        .from(bookings).where(and(eq(bookings.orgId, orgId), or(eq(bookings.residentId, residentId), uid ? eq(bookings.bookedByUserId, uid) : sql`false`))),
      packages: await tx.select({ carrier: packages.carrier, trackingNumber: packages.trackingNumber, status: packages.status, receivedAt: packages.receivedAt, pickedUpAt: packages.pickedUpAt })
        .from(packages).where(and(eq(packages.orgId, orgId), eq(packages.residentId, residentId))),
      visitors: await tx.select({ name: visitors.name, kind: visitors.kind, status: visitors.status, expectedFrom: visitors.expectedFrom, checkedInAt: visitors.checkedInAt })
        .from(visitors).where(and(eq(visitors.orgId, orgId), or(eq(visitors.hostResidentId, residentId), uid ? eq(visitors.invitedByUserId, uid) : sql`false`))),
      vehicles: vehicleRows.map(({ plate, region, make, model, color, active }) => ({ plate, region, make, model, color, active })),
      parkingPermits: vehicleIds.length ? await tx.select({ number: parkingPermits.number, plate: parkingPermits.plate, status: parkingPermits.status, validFrom: parkingPermits.validFrom, validUntil: parkingPermits.validUntil }).from(parkingPermits).where(inArray(parkingPermits.vehicleId, vehicleIds)) : [],
      parkingViolations: vehicleIds.length ? await tx.select({ number: parkingViolations.number, plate: parkingViolations.plate, kind: parkingViolations.kind, status: parkingViolations.status, observedAt: parkingViolations.observedAt }).from(parkingViolations).where(inArray(parkingViolations.vehicleId, vehicleIds)) : [],
      messageThreads: await Promise.all(threads.map(async (t) => ({
        subject: t.subject, status: t.status, createdAt: t.createdAt,
        messages: await tx.select({ fromStaff: messages.fromStaff, internal: messages.internal, body: messages.body, createdAt: messages.createdAt }).from(messages).where(eq(messages.threadId, t.id)).orderBy(messages.createdAt),
      }))),
      notifications: personal.notifications,
      notificationPreferences: personal.notificationPreferences,
      consents: await tx.select({ channel: consents.channel, purpose: consents.purpose, granted: consents.granted, source: consents.source, createdAt: consents.createdAt }).from(consents)
        .where(and(eq(consents.orgId, orgId), or(eq(consents.residentId, residentId), uid ? eq(consents.userId, uid) : sql`false`))).orderBy(consents.createdAt),
      assistantConversations: personal.assistantConversations,
      filesUploaded: uid ? await tx.select({ filename: files.filename, contentType: files.contentType, sizeBytes: files.sizeBytes, sha256: files.sha256, attachedTo: files.entityType, createdAt: files.createdAt }).from(files).where(and(eq(files.orgId, orgId), eq(files.uploadedByUserId, uid))) : [],
      activity: uid ? await tx.select({ action: auditLogs.action, entityType: auditLogs.entityType, createdAt: auditLogs.createdAt }).from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.actorUserId, uid))).orderBy(auditLogs.createdAt) : [],
      label: `${r.firstName} ${r.lastName}`,
      subjectUserId: uid,
    };
  });
  const { label, subjectUserId, ...doc } = data;
  const counts = Object.fromEntries(Object.entries(doc).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).length]));
  const storageKey = `${orgId}/privacy/${randomUUID()}`;
  await blobStore().put(storageKey, new TextEncoder().encode(JSON.stringify(doc, null, 2)), "application/json");
  const id = await tenantTx(ctx, async (tx) => {
    const [row] = await tx.insert(privacyRequests).values({
      orgId, kind: "export", residentId, userId: subjectUserId, subjectLabel: label,
      status: "completed", result: { storageKey, counts }, requestedByUserId: ctx.principal.userId,
    }).returning();
    await auditAs(tx, ctx, "privacy.exported", "resident", residentId, undefined, { requestId: row.id, counts });
    return row.id;
  });
  return { requestId: id, counts };
}

// the export file, for privacy managers, for EXPORT_DAYS days
export async function openExport(ctx: TenantCtx, requestId: string): Promise<{ bytes: Uint8Array; filename: string }> {
  authorize(ctx.principal, "privacy.manage");
  const r = await tenantTx(ctx, async (tx) => {
    const [r] = await tx.select().from(privacyRequests).where(and(eq(privacyRequests.id, requestId), eq(privacyRequests.orgId, ctx.principal.orgId), eq(privacyRequests.kind, "export")));
    if (!r || !(r.result as { storageKey?: string }).storageKey || !exportLive(r.createdAt)) throw new NotFoundError();
    await auditAs(tx, ctx, "privacy.export_downloaded", "privacy_request", requestId);
    return r;
  });
  const bytes = await blobStore().get((r.result as { storageKey: string }).storageKey);
  return { bytes, filename: `personal-data-${r.subjectLabel.replace(/[^\w.-]+/g, "-").toLowerCase()}-${r.createdAt.toISOString().slice(0, 10)}.json` };
}

/* ───────────── erasure ───────────── */

export const eraseSchema = z.object({ reason: z.string().trim().min(3, "Say why (for the record).").max(500), confirm: z.string() });

// removes or anonymizes the person's data here; refuses while a legal hold is in place
export async function erasePerson(ctx: TenantCtx, residentId: string, input: { reason: string }): Promise<{ status: "completed" | "blocked"; requestId: string; result: Record<string, number> }> {
  authorize(ctx.principal, "privacy.manage");
  const orgId = ctx.principal.orgId;
  // the system context (pinned to this organization) also reaches owner-only tables: assistant chats, notifications
  const out = await withContext({ orgId, userId: ctx.principal.userId, system: true }, async (tx) => {
    const r = await loadResident(tx, orgId, residentId);
    const label = `${r.firstName} ${r.lastName}`;
    const hold = await activeHold(tx, orgId, residentId, r.userId);
    if (hold) {
      const [row] = await tx.insert(privacyRequests).values({ orgId, kind: "erasure", residentId, userId: r.userId, subjectLabel: label, status: "blocked", reason: `Legal hold: ${hold.reason}`, requestedByUserId: ctx.principal.userId }).returning();
      await auditAs(tx, ctx, "privacy.erasure_blocked", "resident", residentId, undefined, { holdId: hold.id });
      return { status: "blocked" as const, requestId: row.id, result: {}, userId: null as string | null };
    }
    const uid = r.userId;
    const n = (x: { length: number }) => x.length;
    const result: Record<string, number> = {};
    const vs = await tx.update(vehicles).set({ plate: "ERASED", make: null, model: null, color: null, active: false }).where(and(eq(vehicles.orgId, orgId), eq(vehicles.residentId, residentId))).returning({ id: vehicles.id });
    result.vehicles = n(vs);
    if (vs.length) {
      const ids = vs.map((v) => v.id);
      result.parkingPermits = n(await tx.update(parkingPermits).set({ plate: "ERASED", status: sql`case when ${parkingPermits.status} = 'active' then 'revoked' else ${parkingPermits.status} end` }).where(inArray(parkingPermits.vehicleId, ids)).returning({ id: parkingPermits.id }));
      result.parkingViolations = n(await tx.update(parkingViolations).set({ plate: "ERASED" }).where(inArray(parkingViolations.vehicleId, ids)).returning({ id: parkingViolations.id }));
    }
    result.packages = n(await tx.update(packages).set({ recipientName: "Former resident", pickedUpByName: null, notes: null }).where(and(eq(packages.orgId, orgId), eq(packages.residentId, residentId))).returning({ id: packages.id }));
    if (uid) {
      result.messages = n(await tx.update(messages).set({ body: "[erased]" }).where(and(eq(messages.orgId, orgId), eq(messages.authorUserId, uid))).returning({ id: messages.id }));
      await tx.update(messageThreads).set({ residentUserId: null, lastMessagePreview: sql`case when ${messageThreads.lastFromStaff} then ${messageThreads.lastMessagePreview} else '[erased]' end` })
        .where(and(eq(messageThreads.orgId, orgId), eq(messageThreads.residentUserId, uid)));
      result.workOrderEntryNotes = n(await tx.update(workOrders).set({ entryNotes: null }).where(and(eq(workOrders.orgId, orgId), eq(workOrders.submittedByUserId, uid), sql`${workOrders.entryNotes} is not null`)).returning({ id: workOrders.id }));
      result.assistantConversations = n(await tx.delete(aiConversations).where(and(eq(aiConversations.orgId, orgId), eq(aiConversations.userId, uid))).returning({ id: aiConversations.id }));
      result.notifications = n(await tx.delete(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.userId, uid))).returning({ id: notifications.id }));
      await tx.delete(notificationPreferences).where(and(eq(notificationPreferences.orgId, orgId), eq(notificationPreferences.userId, uid)));
      // their resident access here ends; staff or admin memberships the same person may hold aren't touched
      result.memberships = n(await tx.update(memberships).set({ status: "deactivated" }).where(and(
        eq(memberships.orgId, orgId), eq(memberships.userId, uid),
        inArray(memberships.roleId, tx.select({ id: roles.id }).from(roles).where(eq(roles.category, "resident"))),
      )).returning({ id: memberships.id }));
    }
    result.consents = n(await tx.delete(consents).where(and(eq(consents.orgId, orgId), or(eq(consents.residentId, residentId), uid ? eq(consents.userId, uid) : sql`false`))).returning({ id: consents.id }));
    await tx.update(residents).set({ firstName: "Former", lastName: "resident", email: null, phone: null, notes: null, userId: null }).where(eq(residents.id, residentId));
    const [row] = await tx.insert(privacyRequests).values({ orgId, kind: "erasure", residentId, userId: uid, subjectLabel: "Former resident", status: "completed", reason: input.reason, result, requestedByUserId: ctx.principal.userId }).returning();
    // the audit entry records that an erasure happened, not who it was about
    await auditAs(tx, ctx, "privacy.erased", "resident", residentId, undefined, { requestId: row.id, result });
    return { status: "completed" as const, requestId: row.id, result, userId: uid };
  });
  // the account itself is shared across organizations: it's anonymized only if this was its last membership
  if (out.status === "completed" && out.userId) await anonymizeAccountIfOrphaned(out.userId, orgId);
  return { status: out.status, requestId: out.requestId, result: out.result };
}

async function anonymizeAccountIfOrphaned(userId: string, orgId: string) {
  // memberships in other organizations are only visible to the platform context
  const others = await withContext({ platformAdmin: true }, (tx) => tx.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, "active"), ne(memberships.orgId, orgId))).limit(1));
  if (others.length) return;
  const [u] = await db().select({ admin: users.isPlatformAdmin }).from(users).where(eq(users.id, userId));
  if (!u || u.admin) return;
  await db().update(users).set({ email: `erased-${userId}@invalid`, name: "Erased user", passwordHash: null, mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null, status: "deactivated" }).where(eq(users.id, userId));
  await db().delete(sessions).where(eq(sessions.userId, userId));
  log.info("privacy.account_anonymized", { userId });
}

/* ───────────── legal holds ───────────── */

export async function placeLegalHold(ctx: TenantCtx, residentId: string, reason: string) {
  authorize(ctx.principal, "privacy.manage");
  if (reason.trim().length < 3) throw new ValidationError("Say why (for example, the claim or request it's for).", "reason");
  return tenantTx(ctx, async (tx) => {
    const r = await loadResident(tx, ctx.principal.orgId, residentId);
    if (await activeHold(tx, ctx.principal.orgId, residentId, r.userId)) throw new ValidationError("This person is already on hold.", "reason");
    const [h] = await tx.insert(legalHolds).values({ orgId: ctx.principal.orgId, residentId, userId: r.userId, reason: reason.trim().slice(0, 500), createdByUserId: ctx.principal.userId }).returning();
    await auditAs(tx, ctx, "privacy.hold_placed", "legal_hold", h.id, undefined, { residentId, reason: h.reason });
    return h;
  });
}

export async function releaseLegalHold(ctx: TenantCtx, holdId: string) {
  authorize(ctx.principal, "privacy.manage");
  return tenantTx(ctx, async (tx) => {
    const [h] = await tx.update(legalHolds).set({ releasedAt: new Date(), releasedByUserId: ctx.principal.userId })
      .where(and(eq(legalHolds.id, holdId), eq(legalHolds.orgId, ctx.principal.orgId), isNull(legalHolds.releasedAt))).returning();
    if (!h) throw new NotFoundError();
    await auditAs(tx, ctx, "privacy.hold_released", "legal_hold", holdId);
  });
}

/* ───────────── retention ───────────── */

const days = (min: number, label: string) => z.string().trim().transform((v, c) => {
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > 3650) {
    c.addIssue({ code: "custom", message: `${label}: a whole number of days from ${min} to 3650, or blank to keep.` });
    return z.NEVER;
  }
  return n;
});
export const retentionSchema = z.object({
  messagesDays: days(30, "Messages"), visitorsDays: days(30, "Visitor log"), parkingEvidenceDays: days(30, "Parking evidence"),
  assistantDays: days(7, "Assistant conversations"), auditDays: days(365, "Audit log"),
});

export async function saveRetention(ctx: TenantCtx, input: z.output<typeof retentionSchema>) {
  authorize(ctx.principal, "privacy.manage");
  return tenantTx(ctx, async (tx) => {
    const [before] = await tx.select().from(retentionPolicies).where(eq(retentionPolicies.orgId, ctx.principal.orgId));
    await tx.insert(retentionPolicies).values({ orgId: ctx.principal.orgId, ...input, updatedByUserId: ctx.principal.userId })
      .onConflictDoUpdate({ target: retentionPolicies.orgId, set: { ...input, updatedByUserId: ctx.principal.userId } });
    await auditAs(tx, ctx, "privacy.retention_changed", "organization", ctx.principal.orgId, before ?? undefined, input);
  });
}

// worker, daily: deletes what each organization's retention settings say is too old, except people on legal hold
export async function applyRetention(now = new Date()): Promise<Record<string, number>> {
  const total: Record<string, number> = {};
  const policies = await withContext({ system: true }, (tx) => tx.select().from(retentionPolicies));
  for (const p of policies) {
    const cutoff = (d: number | null) => (d ? new Date(now.getTime() - d * 86_400_000) : null);
    const result = await withContext({ orgId: p.orgId, system: true }, async (tx) => {
      const held = await tx.select({ residentId: legalHolds.residentId, userId: legalHolds.userId }).from(legalHolds).where(and(eq(legalHolds.orgId, p.orgId), isNull(legalHolds.releasedAt)));
      const heldResidents = held.map((h) => h.residentId).filter(Boolean) as string[];
      const heldUsers = held.map((h) => h.userId).filter(Boolean) as string[];
      const r: Record<string, number> = {};
      const m = cutoff(p.messagesDays);
      if (m) {
        const keep = heldResidents.length ? sql`and ${messageThreads.residentId} not in (${sql.join(heldResidents.map((x) => sql`${x}::uuid`), sql`, `)})` : sql``;
        r.messages = (await tx.execute(sql`delete from messages where org_id = ${p.orgId} and created_at < ${m} and thread_id in (select id from message_threads where org_id = ${p.orgId} ${keep})`)).rowCount ?? 0;
        r.threads = (await tx.delete(messageThreads).where(and(eq(messageThreads.orgId, p.orgId), lt(messageThreads.lastMessageAt, m), sql`not exists (select 1 from messages where thread_id = ${messageThreads.id})`)).returning({ id: messageThreads.id })).length;
      }
      const v = cutoff(p.visitorsDays);
      if (v) {
        // finished visits (anyone still checked in stays)
        r.visitors = (await tx.delete(visitors).where(and(eq(visitors.orgId, p.orgId), ne(visitors.status, "checked_in"),
          lt(sql`coalesce(${visitors.checkedOutAt}, ${visitors.cancelledAt}, ${visitors.expectedUntil}, ${visitors.createdAt})`, v),
          heldResidents.length ? sql`(${visitors.hostResidentId} is null or ${visitors.hostResidentId} not in (${sql.join(heldResidents.map((x) => sql`${x}::uuid`), sql`, `)}))` : sql`true`))
          .returning({ id: visitors.id })).length;
      }
      const e = cutoff(p.parkingEvidenceDays);
      let evidenceKeys: string[] = [];
      if (e) {
        const gone = await tx.delete(files).where(and(eq(files.orgId, p.orgId), eq(files.entityType, "parking_violation"), lt(files.createdAt, e))).returning({ key: files.storageKey });
        evidenceKeys = gone.map((g) => g.key);
        r.parkingEvidence = gone.length;
      }
      const a = cutoff(p.assistantDays);
      if (a) {
        r.assistantConversations = (await tx.delete(aiConversations).where(and(eq(aiConversations.orgId, p.orgId), lt(sql`coalesce(${aiConversations.lastMessageAt}, ${aiConversations.createdAt})`, a),
          heldUsers.length ? sql`${aiConversations.userId} not in (${sql.join(heldUsers.map((x) => sql`${x}::uuid`), sql`, `)})` : sql`true`)).returning({ id: aiConversations.id })).length;
      }
      const au = cutoff(p.auditDays);
      if (au) r.auditEntries = Number((await tx.execute<{ n: string }>(sql`select audit_prune(${p.orgId}::uuid, ${au}) as n`)).rows[0].n);
      if (Object.values(r).some((x) => x > 0)) await writeAudit(tx, { orgId: p.orgId, actorUserId: null, action: "privacy.retention_applied", entityType: "organization", entityId: p.orgId, after: r });
      return { r, evidenceKeys };
    });
    for (const k of result.evidenceKeys) await blobStore().delete(k).catch(() => {});
    for (const [k, n] of Object.entries(result.r)) total[k] = (total[k] ?? 0) + n;
  }
  return total;
}

// expired export files are deleted; the request record stays
export async function purgeExpiredExports(now = new Date()): Promise<number> {
  const old = await withContext({ system: true }, (tx) => tx.select().from(privacyRequests)
    .where(and(eq(privacyRequests.kind, "export"), lt(privacyRequests.createdAt, new Date(now.getTime() - EXPORT_DAYS * 86_400_000)), sql`${privacyRequests.result} ? 'storageKey'`)));
  for (const r of old) {
    await blobStore().delete((r.result as { storageKey: string }).storageKey).catch(() => {});
    await withContext({ orgId: r.orgId, system: true }, (tx) => tx.update(privacyRequests).set({ result: sql`${privacyRequests.result} - 'storageKey'` }).where(eq(privacyRequests.id, r.id)));
  }
  return old.length;
}

/* ───────────── consent ───────────── */

// append-only record of a change in someone's email/SMS choices
export async function recordConsent(tx: Tx, c: { orgId: string; userId?: string | null; residentId?: string | null; channel: "email" | "sms"; granted: boolean; source: "preferences" | "admin" | "signup"; recordedByUserId?: string | null; ip?: string | null }) {
  await tx.insert(consents).values({ orgId: c.orgId, userId: c.userId ?? null, residentId: c.residentId ?? null, channel: c.channel, granted: c.granted, source: c.source, recordedByUserId: c.recordedByUserId ?? null, ip: c.ip ?? null });
}
