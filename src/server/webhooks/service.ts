import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { withContext, type Tx } from "../db/client";
import { amenities, bookings, complaints, incidents, outboxEvents, packages, webhookAttempts, webhookDeliveries, webhookEndpoints, workOrders } from "../db/schema";
import { authorize, NotFoundError } from "../authz/authorize";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { emitSystem } from "../modules/ops/core";
import { seal, unseal } from "../keyring";
import { env, isProd } from "../env";
import { log } from "../log";
import { assertFeature, loadEntitlements } from "../billing/entitlements";
import { incrementUsage } from "../billing/service";
import { checkUrlShape, safePost, UnsafeTargetError } from "../net/safe-fetch";
import { serializeBooking, serializeComplaint, serializeIncident, serializePackage, serializeWorkOrder } from "../api/v1/serializers";
import { PUBLIC_EVENT_TYPES, publicEventFor, TEST_EVENT_TYPE, type PublicEvent } from "./catalog";
import { DISABLE_AFTER_CONSECUTIVE_FAILURES, generateWebhookSecret, nextAttemptDelayMs, signWebhook } from "./signing";
import { BRAND } from "@/config/brand";

// Outgoing webhooks (Iteration 10): the outbox's third consumer. Events are fanned out to subscribed endpoints with
// the payload frozen at that moment; each delivery is signed, retried with backoff, and every attempt is recorded.

export type Endpoint = typeof webhookEndpoints.$inferSelect;
export type Delivery = typeof webhookDeliveries.$inferSelect;

// development and tests may deliver to local receivers; production never does
export const targetOptions = () => {
  const allow = env().WEBHOOK_ALLOW_PRIVATE_TARGETS && !isProd();
  return { allowPrivate: allow, allowHttp: allow };
};

const canManage = (ctx: TenantCtx) => authorize(ctx.principal, "api.manage");
// the encrypted secret never leaves the server
const withoutSecret = (e: Endpoint): Omit<Endpoint, "secretEnc"> => Object.fromEntries(Object.entries(e).filter(([k]) => k !== "secretEnc")) as Omit<Endpoint, "secretEnc">;

export const endpointSchema = z.object({
  url: z.string().trim().min(1, "Enter the URL to send events to.").max(2000),
  description: z.string().trim().max(200).optional().transform((v) => (v ? v : null)),
  events: z.array(z.string()).min(1, "Choose at least one event.").refine((xs) => xs.every((x) => PUBLIC_EVENT_TYPES.includes(x)), "Unknown event type."),
});

function validUrl(url: string): string {
  try {
    return checkUrlShape(url, targetOptions()).toString();
  } catch (e) {
    if (e instanceof UnsafeTargetError) throw new ValidationError(e.message, "url");
    throw e;
  }
}

/* ───────────── endpoints ───────────── */

export type EndpointRow = Omit<Endpoint, "secretEnc"> & { pending: number; failed24h: number };

export async function listEndpoints(ctx: TenantCtx): Promise<EndpointRow[]> {
  canManage(ctx);
  return tenantTx(ctx, async (tx) => {
    const rows = await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.orgId, ctx.principal.orgId)).orderBy(asc(webhookEndpoints.createdAt));
    const out: EndpointRow[] = [];
    for (const row of rows) {
      const r = withoutSecret(row);
      const [{ pending }] = await tx.select({ pending: count() }).from(webhookDeliveries).where(and(eq(webhookDeliveries.endpointId, r.id), eq(webhookDeliveries.status, "pending")));
      const [{ failed }] = await tx.select({ failed: count() }).from(webhookAttempts).innerJoin(webhookDeliveries, eq(webhookDeliveries.id, webhookAttempts.deliveryId))
        .where(and(eq(webhookDeliveries.endpointId, r.id), sql`${webhookAttempts.createdAt} > now() - interval '24 hours'`, sql`coalesce(${webhookAttempts.statusCode}, 0) not between 200 and 299`));
      out.push({ ...r, pending, failed24h: failed });
    }
    return out;
  });
}

export async function getEndpoint(ctx: TenantCtx, id: string, opts: { page?: number } = {}) {
  canManage(ctx);
  const pageSize = 25;
  const page = Math.max(1, opts.page ?? 1);
  return tenantTx(ctx, async (tx) => {
    const [e] = await tx.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, ctx.principal.orgId)));
    if (!e) throw new NotFoundError();
    const endpoint = withoutSecret(e);
    const [{ n }] = await tx.select({ n: count() }).from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, id));
    const deliveries = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, id)).orderBy(desc(webhookDeliveries.createdAt))
      .limit(pageSize).offset((page - 1) * pageSize);
    return { endpoint, deliveries, total: n, page, pageCount: Math.max(1, Math.ceil(n / pageSize)) };
  });
}

export async function getDelivery(ctx: TenantCtx, id: string) {
  canManage(ctx);
  return tenantTx(ctx, async (tx) => {
    const [d] = await tx.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.orgId, ctx.principal.orgId)));
    if (!d) throw new NotFoundError();
    const attempts = await tx.select().from(webhookAttempts).where(eq(webhookAttempts.deliveryId, id)).orderBy(asc(webhookAttempts.attempt));
    return { delivery: d, attempts };
  });
}

// returns the signing secret once
export async function createEndpoint(ctx: TenantCtx, input: z.input<typeof endpointSchema>): Promise<{ id: string; secret: string }> {
  canManage(ctx);
  await assertFeature(ctx.principal.orgId, "webhooks");
  const data = endpointSchema.parse(input);
  const url = validUrl(data.url);
  const secret = generateWebhookSecret();
  return tenantTx(ctx, async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(webhookEndpoints).where(eq(webhookEndpoints.orgId, ctx.principal.orgId));
    if (n >= 20) throw new ValidationError("An organization can have at most 20 webhook endpoints.");
    const [e] = await tx.insert(webhookEndpoints).values({
      orgId: ctx.principal.orgId, url, description: data.description, events: [...new Set(data.events)], secretEnc: seal(secret), createdByUserId: ctx.principal.userId,
    }).returning();
    await auditAs(tx, ctx, "webhook.endpoint_created", "webhook_endpoint", e.id, undefined, { url, events: e.events });
    return { id: e.id, secret };
  });
}

async function loadEndpoint(tx: Tx, ctx: TenantCtx, id: string) {
  const [e] = await tx.select().from(webhookEndpoints).where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.orgId, ctx.principal.orgId))).for("update");
  if (!e) throw new NotFoundError();
  return e;
}

export async function updateEndpoint(ctx: TenantCtx, id: string, input: z.input<typeof endpointSchema>) {
  canManage(ctx);
  const data = endpointSchema.parse(input);
  const url = validUrl(data.url);
  return tenantTx(ctx, async (tx) => {
    const before = await loadEndpoint(tx, ctx, id);
    const [after] = await tx.update(webhookEndpoints).set({ url, description: data.description, events: [...new Set(data.events)] }).where(eq(webhookEndpoints.id, id)).returning();
    await auditAs(tx, ctx, "webhook.endpoint_updated", "webhook_endpoint", id, { url: before.url, events: before.events }, { url: after.url, events: after.events });
  });
}

export async function setEndpointActive(ctx: TenantCtx, id: string, active: boolean) {
  canManage(ctx);
  if (active) await assertFeature(ctx.principal.orgId, "webhooks");
  return tenantTx(ctx, async (tx) => {
    const before = await loadEndpoint(tx, ctx, id);
    await tx.update(webhookEndpoints).set(active ? { status: "active", disabledReason: null, consecutiveFailures: 0 } : { status: "disabled", disabledReason: "Switched off by a person." })
      .where(eq(webhookEndpoints.id, id));
    await auditAs(tx, ctx, active ? "webhook.endpoint_enabled" : "webhook.endpoint_disabled", "webhook_endpoint", id, { status: before.status }, { status: active ? "active" : "disabled" });
  });
}

export async function rotateSecret(ctx: TenantCtx, id: string): Promise<string> {
  canManage(ctx);
  const secret = generateWebhookSecret();
  await tenantTx(ctx, async (tx) => {
    await loadEndpoint(tx, ctx, id);
    await tx.update(webhookEndpoints).set({ secretEnc: seal(secret) }).where(eq(webhookEndpoints.id, id));
    await auditAs(tx, ctx, "webhook.secret_rotated", "webhook_endpoint", id);
  });
  return secret;
}

export async function deleteEndpoint(ctx: TenantCtx, id: string) {
  canManage(ctx);
  await tenantTx(ctx, async (tx) => {
    const e = await loadEndpoint(tx, ctx, id);
    await tx.delete(webhookEndpoints).where(eq(webhookEndpoints.id, id));
    await auditAs(tx, ctx, "webhook.endpoint_deleted", "webhook_endpoint", id, { url: e.url, events: e.events });
  });
}

// a "ping" delivered right away, so the person sees whether their endpoint answers
export async function sendTestEvent(ctx: TenantCtx, id: string): Promise<Delivery> {
  canManage(ctx);
  await assertFeature(ctx.principal.orgId, "webhooks");
  const deliveryId = await tenantTx(ctx, async (tx) => {
    const e = await loadEndpoint(tx, ctx, id);
    const eventId = randomUUID();
    const [d] = await tx.insert(webhookDeliveries).values({
      orgId: e.orgId, endpointId: e.id, eventType: TEST_EVENT_TYPE,
      payload: envelope(eventId, TEST_EVENT_TYPE, new Date(), { object: "ping", message: `Test event from ${BRAND.name}. If you can read this, the endpoint works.` }),
    }).returning();
    await auditAs(tx, ctx, "webhook.test_sent", "webhook_endpoint", id);
    return d.id;
  });
  return (await attemptDelivery(deliveryId, new Date(), { force: true })) ?? (await getDelivery(ctx, deliveryId)).delivery;
}

// sends a delivery's payload again as a new delivery (the event id inside stays the same, so receivers can dedupe)
export async function replayDelivery(ctx: TenantCtx, deliveryId: string): Promise<Delivery> {
  canManage(ctx);
  await assertFeature(ctx.principal.orgId, "webhooks");
  const id = await tenantTx(ctx, async (tx) => {
    const [d] = await tx.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.orgId, ctx.principal.orgId)));
    if (!d) throw new NotFoundError();
    const [n] = await tx.insert(webhookDeliveries).values({ orgId: d.orgId, endpointId: d.endpointId, eventType: d.eventType, payload: d.payload, replayOf: d.id }).returning();
    await auditAs(tx, ctx, "webhook.delivery_replayed", "webhook_delivery", d.id, undefined, { replay: n.id });
    return n.id;
  });
  return (await attemptDelivery(id, new Date(), { force: true })) ?? (await getDelivery(ctx, id)).delivery;
}

/* ───────────── fan-out: outbox → deliveries ───────────── */

const envelope = (id: string, type: string, createdAt: Date, object: unknown) => ({ id, type, created_at: createdAt.toISOString(), api_version: "v1", data: { object } });

async function loadObject(tx: Tx, pe: PublicEvent, id: string | undefined): Promise<unknown | null> {
  if (!id) return null;
  switch (pe.object) {
    case "work_order": { const [r] = await tx.select().from(workOrders).where(eq(workOrders.id, id)); return r ? serializeWorkOrder(r) : null; }
    case "incident": { const [r] = await tx.select().from(incidents).where(eq(incidents.id, id)); return r ? serializeIncident(r) : null; }
    case "complaint": { const [r] = await tx.select().from(complaints).where(eq(complaints.id, id)); return r ? serializeComplaint(r) : null; }
    case "package": { const [r] = await tx.select().from(packages).where(eq(packages.id, id)); return r ? serializePackage(r) : null; }
    case "booking": {
      const [r] = await tx.select({ b: bookings, name: amenities.name }).from(bookings).innerJoin(amenities, eq(amenities.id, bookings.amenityId)).where(eq(bookings.id, id));
      return r ? serializeBooking(r.b, r.name) : null;
    }
  }
}

let fanning: Promise<number> | null = null;

export function fanOutWebhookEvents(limit = 200): Promise<number> {
  fanning ??= (async () => {
    let created = 0;
    try {
      const pending = await withContext({ system: true }, (tx) => tx.select({ id: outboxEvents.id, orgId: outboxEvents.orgId }).from(outboxEvents)
        .where(isNull(outboxEvents.webhooksAt)).orderBy(asc(outboxEvents.createdAt)).limit(limit));
      for (const ev of pending) {
        try {
          created += await withContext({ orgId: ev.orgId, system: true }, async (tx) => {
            const claimed = await tx.execute(sql`select id from outbox_events where id = ${ev.id} and webhooks_at is null for update skip locked`);
            if (!claimed.rows.length) return 0;
            const [e] = await tx.select().from(outboxEvents).where(eq(outboxEvents.id, ev.id));
            await tx.update(outboxEvents).set({ webhooksAt: new Date() }).where(eq(outboxEvents.id, ev.id));
            const pe = publicEventFor(e.type);
            if (!pe) return 0;
            const endpoints = await tx.select({ id: webhookEndpoints.id }).from(webhookEndpoints)
              .where(and(eq(webhookEndpoints.orgId, e.orgId), eq(webhookEndpoints.status, "active"), sql`${pe.type} = any(${webhookEndpoints.events})`));
            if (!endpoints.length) return 0;
            if (!(await loadEntitlements(tx, e.orgId)).features.webhooks) return 0;
            const object = await loadObject(tx, pe, (e.payload as Record<string, string>)[pe.idKey]);
            if (!object) return 0;
            const payload = envelope(e.id, pe.type, e.createdAt, object);
            const rows = await tx.insert(webhookDeliveries).values(endpoints.map((x) => ({ orgId: e.orgId, endpointId: x.id, eventId: e.id, eventType: pe.type, payload })))
              .onConflictDoNothing().returning({ id: webhookDeliveries.id });
            return rows.length;
          });
        } catch (err) {
          log.error("webhooks.fanout_failed", { eventId: ev.id, err });
        }
      }
    } finally {
      fanning = null;
    }
    return created;
  })();
  return fanning;
}

/* ───────────── delivery ───────────── */

const LEASE_MS = 2 * 60_000;

// one attempt; returns the delivery as it stands afterwards (null when another worker holds it)
export async function attemptDelivery(id: string, now = new Date(), opts: { force?: boolean } = {}): Promise<Delivery | null> {
  const [head] = await withContext({ system: true }, (tx) => tx.select({ orgId: webhookDeliveries.orgId }).from(webhookDeliveries).where(eq(webhookDeliveries.id, id)));
  if (!head) return null;
  const orgId = head.orgId;
  // claim: push next_attempt_at forward (a lease) so a concurrent worker skips it
  const claim = await withContext({ orgId, system: true }, async (tx) => {
    const [d] = await tx.update(webhookDeliveries).set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
      .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "pending"), opts.force ? undefined : lte(webhookDeliveries.nextAttemptAt, now))).returning();
    if (!d) return null;
    const [e] = await tx.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, d.endpointId));
    return e ? { d, e } : null;
  });
  if (!claim) return null;
  const { d, e } = claim;
  if (e.status !== "active" && !opts.force) return d;

  const body = JSON.stringify(d.payload);
  const ts = Math.floor(Date.now() / 1000);
  let statusCode: number | null = null;
  let error: string | null = null;
  let snippet: string | null = null;
  const t0 = Date.now();
  try {
    const secret = unseal(e.secretEnc);
    const res = await safePost(e.url, body, {
      "content-type": "application/json", "user-agent": `${BRAND.shortName}-Webhooks/1.0`,
      "webhook-id": d.id, "webhook-timestamp": String(ts), "webhook-signature": signWebhook(secret, ts, body),
    }, targetOptions());
    statusCode = res.status;
    snippet = res.body.slice(0, 1000) || null;
    if (res.status < 200 || res.status >= 300) error = res.status >= 300 && res.status < 400 ? `Redirect (${res.status}) — redirects aren't followed; use the final URL.` : `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof UnsafeTargetError ? `Blocked: ${err.message}` : (err as Error)?.message?.slice(0, 300) || "Request failed";
  }
  const durationMs = Date.now() - t0;
  const ok = !error;
  const attempts = d.attempts + 1;
  const delay = ok ? null : nextAttemptDelayMs(attempts);

  const after = await withContext({ orgId, system: true }, async (tx) => {
    await tx.insert(webhookAttempts).values({ orgId, deliveryId: d.id, attempt: attempts, statusCode, error, responseSnippet: snippet, durationMs });
    const [updated] = await tx.update(webhookDeliveries).set({
      attempts, lastStatusCode: statusCode, lastError: error,
      status: ok ? "succeeded" : delay === null ? "failed" : "pending",
      nextAttemptAt: ok || delay === null ? null : new Date(Date.now() + delay), deliveredAt: ok ? new Date() : null,
    }).where(eq(webhookDeliveries.id, d.id)).returning();
    if (ok) await tx.update(webhookEndpoints).set({ consecutiveFailures: 0, lastSuccessAt: new Date() }).where(eq(webhookEndpoints.id, e.id));
    else {
      const [ep] = await tx.update(webhookEndpoints).set({ consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`, lastFailureAt: new Date() })
        .where(eq(webhookEndpoints.id, e.id)).returning();
      if (ep.status === "active" && ep.consecutiveFailures >= DISABLE_AFTER_CONSECUTIVE_FAILURES) {
        await tx.update(webhookEndpoints).set({ status: "disabled", disabledReason: `Switched off after ${ep.consecutiveFailures} failed attempts in a row.` }).where(eq(webhookEndpoints.id, e.id));
        await emitSystem(tx, orgId, "webhook.endpoint_disabled", { endpointId: e.id, url: e.url });
        log.warn("webhooks.endpoint_disabled", { endpointId: e.id, failures: ep.consecutiveFailures });
      }
    }
    return updated;
  });
  await incrementUsage(orgId, "webhook_deliveries").catch(() => {});
  return after;
}

let delivering: Promise<number> | null = null;

export function deliverDueWebhooks(limit = 50, now = new Date()): Promise<number> {
  delivering ??= (async () => {
    let n = 0;
    try {
      const due = await withContext({ system: true }, (tx) => tx.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
        .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
        .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now), eq(webhookEndpoints.status, "active")))
        .orderBy(asc(webhookDeliveries.nextAttemptAt)).limit(limit));
      for (const d of due) {
        try {
          if (await attemptDelivery(d.id, now)) n++;
        } catch (err) {
          log.error("webhooks.delivery_failed", { deliveryId: d.id, err });
        }
      }
    } finally {
      delivering = null;
    }
    return n;
  })();
  return delivering;
}

