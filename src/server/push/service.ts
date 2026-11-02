import "server-only";
import webpush from "web-push";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { pushSubscriptions } from "@/server/db/schema";
import { withContext } from "@/server/db/client";
import { env } from "@/server/env";
import { log } from "@/server/log";
import { safeRequest, UnsafeTargetError } from "@/server/net/safe-fetch";
import { tenantTx, ValidationError, type TenantCtx } from "@/server/modules/context";
import { recordConsent } from "@/server/privacy/service";
import { loadEntitlements } from "@/server/billing/entitlements";

// Web push (Iteration 12). A browser that agrees to notifications gives us an endpoint at its vendor's push service
// and two keys; payloads are encrypted for that browser (RFC 8291) and signed with our VAPID key (RFC 8292). The
// endpoint comes from the browser, so it's checked like any outgoing URL: https, a known push service, a public
// address, our own HTTP client (no redirects, short timeout).

// push services of the browsers people use; anything else is refused
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
const FAILURES_BEFORE_REMOVAL = 10;
const isProd = () => process.env.NODE_ENV === "production";
const allowPrivate = () => env().PUSH_ALLOW_PRIVATE_TARGETS && !isProd();

export const pushConfigured = () => !!(env().VAPID_PUBLIC_KEY && env().VAPID_PRIVATE_KEY);
export const vapidPublicKey = () => (pushConfigured() ? env().VAPID_PUBLIC_KEY! : null);

// keys in the environment and the rollout flag (platform admins can switch push off per organization)
export async function pushAvailable(orgId: string): Promise<boolean> {
  if (!pushConfigured()) return false;
  return withContext({ orgId, system: true }, async (tx) => (await loadEntitlements(tx, orgId)).flags.web_push);
}

const b64url = /^[A-Za-z0-9_-]+=*$/;
export const subscriptionSchema = z.object({
  endpoint: z.string().max(800),
  keys: z.object({ p256dh: z.string().regex(b64url).min(80).max(100), auth: z.string().regex(b64url).min(16).max(30) }),
});
export type PushSubscriptionInput = z.infer<typeof subscriptionSchema>;

export function checkEndpoint(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ValidationError("That isn't a push subscription this app can use."); }
  if (u.username || u.password) throw new ValidationError("That isn't a push subscription this app can use.");
  if (allowPrivate() && u.protocol === "http:" && u.hostname === "127.0.0.1") return u; // local test receiver
  if (u.protocol !== "https:" || !PUSH_HOSTS.some((h) => h.test(u.hostname))) throw new ValidationError("This browser's push service isn't supported.");
  return u;
}

// one browser endpoint belongs to whoever subscribed last on that device: a shared device stops notifying the
// previous person. Other people's rows are owner-only, so the hand-over runs in the system context.
export async function subscribePush(ctx: TenantCtx, input: PushSubscriptionInput, userAgent: string | null) {
  if (!(await pushAvailable(ctx.principal.orgId))) throw new ValidationError("Push notifications aren't available for this organization.");
  const parsed = subscriptionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("That isn't a push subscription this app can use.");
  const endpoint = checkEndpoint(parsed.data.endpoint).toString();
  const p = ctx.principal;
  await withContext({ orgId: p.orgId, userId: p.userId, system: true }, async (tx) => {
    await tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.orgId, p.orgId), eq(pushSubscriptions.endpoint, endpoint)));
    await tx.insert(pushSubscriptions).values({ orgId: p.orgId, userId: p.userId, endpoint, p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth, userAgent: userAgent?.slice(0, 300) ?? null });
  });
  await tenantTx(ctx, (tx) => recordConsent(tx, { orgId: p.orgId, userId: p.userId, channel: "push", granted: true, source: "preferences", recordedByUserId: p.userId, ip: ctx.meta?.ip ?? null }));
}

export async function unsubscribePush(ctx: TenantCtx, endpoint: string) {
  const p = ctx.principal;
  const removed = await tenantTx(ctx, async (tx) => {
    const gone = await tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.orgId, p.orgId), eq(pushSubscriptions.userId, p.userId), eq(pushSubscriptions.endpoint, endpoint))).returning({ id: pushSubscriptions.id });
    const left = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(and(eq(pushSubscriptions.orgId, p.orgId), eq(pushSubscriptions.userId, p.userId)));
    // consent is withdrawn when the last device goes
    if (gone.length && !left.length) await recordConsent(tx, { orgId: p.orgId, userId: p.userId, channel: "push", granted: false, source: "preferences", recordedByUserId: p.userId, ip: ctx.meta?.ip ?? null });
    return gone.length;
  });
  return removed > 0;
}

export async function myPushDevices(ctx: TenantCtx) {
  const p = ctx.principal;
  return tenantTx(ctx, (tx) => tx.select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, userAgent: pushSubscriptions.userAgent, createdAt: pushSubscriptions.createdAt, lastSuccessAt: pushSubscriptions.lastSuccessAt })
    .from(pushSubscriptions).where(and(eq(pushSubscriptions.orgId, p.orgId), eq(pushSubscriptions.userId, p.userId))));
}

export type PushPayload = { title: string; body?: string | null; href: string; tag?: string };

type Outcome = "sent" | "gone" | "failed";

// delivers one payload to every device of these people in this organization; never throws (notifications still
// arrive in the app and by email if push fails)
export async function sendPushToUsers(orgId: string, userIds: string[], payload: PushPayload): Promise<Record<Outcome, number>> {
  const out: Record<Outcome, number> = { sent: 0, gone: 0, failed: 0 };
  if (!userIds.length || !(await pushAvailable(orgId))) return out;
  const subs = await withContext({ orgId, system: true }, (tx) => tx.select().from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.orgId, orgId), inArray(pushSubscriptions.userId, [...new Set(userIds)]))));
  const body = JSON.stringify({ title: payload.title.slice(0, 120), body: payload.body?.slice(0, 240) ?? "", href: payload.href, tag: payload.tag });
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env();
  const results = await mapLimit(subs, 8, async (s): Promise<[string, Outcome]> => {
    try {
      checkEndpoint(s.endpoint);
      const req = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
        vapidDetails: { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC_KEY!, privateKey: VAPID_PRIVATE_KEY! }, TTL: 6 * 3600, contentEncoding: "aes128gcm",
      });
      const res = await safeRequest(req.endpoint, { method: req.method, headers: req.headers as Record<string, string>, body: req.body ?? undefined }, {
        allowPrivate: allowPrivate(), allowHttp: allowPrivate(), timeoutMs: 10_000, maxResponseBytes: 4_096,
      });
      if (res.status >= 200 && res.status < 300) return [s.id, "sent"];
      if (res.status === 404 || res.status === 410) return [s.id, "gone"]; // the browser unsubscribed or the subscription expired
      log.warn("push.rejected", { status: res.status, host: new URL(s.endpoint).host });
      return [s.id, "failed"];
    } catch (e) {
      log.warn("push.failed", { error: e instanceof UnsafeTargetError || e instanceof ValidationError ? e.message : (e as Error).message, host: safeHost(s.endpoint) });
      return [s.id, "failed"];
    }
  });
  await withContext({ orgId, system: true }, async (tx) => {
    const ids = (o: Outcome) => results.filter(([, r]) => r === o).map(([id]) => id);
    if (ids("sent").length) await tx.update(pushSubscriptions).set({ lastSuccessAt: new Date(), failures: 0 }).where(inArray(pushSubscriptions.id, ids("sent")));
    if (ids("gone").length) await tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, ids("gone")));
    if (ids("failed").length) {
      await tx.update(pushSubscriptions).set({ failures: sql`${pushSubscriptions.failures} + 1` }).where(inArray(pushSubscriptions.id, ids("failed")));
      await tx.delete(pushSubscriptions).where(and(inArray(pushSubscriptions.id, ids("failed")), sql`${pushSubscriptions.failures} >= ${FAILURES_BEFORE_REMOVAL}`));
    }
  });
  for (const [, r] of results) out[r]++;
  return out;
}

const safeHost = (u: string) => { try { return new URL(u).host; } catch { return "invalid"; } };

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
