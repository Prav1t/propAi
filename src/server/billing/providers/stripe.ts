import { createHmac } from "node:crypto";
import { BILLING_INTERVALS, PLAN_KEYS, PLANS, stripePriceEnvName, type BillingInterval, type PlanKey } from "@/config/plans";
import { addInterval, type InvoiceLine, type SubscriptionStatus } from "@/lib/billing";
import { safeEqual } from "../../auth/crypto";
import type { SubscriptionRow } from "../entitlements";
import { BillingConfigError, type BillingProvider, type ChangeArgs, type CheckoutArgs, type NormalizedBillingEvent } from "./types";

// Stripe adapter (Iteration 10): Checkout for new subscriptions, the Customer Portal for payment methods, subscription
// updates for plan changes, and verified webhooks for every state change. Talks to the REST API with fetch (no SDK).
// Prices are configured in the environment: STRIPE_PRICE_<PLAN>_<INTERVAL> (base) and, optionally,
// STRIPE_PRICE_<PLAN>_<INTERVAL>_UNIT (a per-unit price whose quantity is the number of units above the included amount).

const SIGNATURE_TOLERANCE_S = 300;
type Json = Record<string, unknown>;

export type StripeConfig = { secretKey: string; webhookSecret: string; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch; apiBase?: string };

// Stripe's form encoding for nested params: a[b][0][c]=v
export function formEncode(params: Json, prefix = ""): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => out.push(typeof item === "object" ? formEncode(item as Json, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`));
    else if (typeof v === "object") out.push(formEncode(v as Json, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join("&");
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.body">[,v1=…]
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, now = new Date()): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("=", 2) as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(t)) > SIGNATURE_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return sigs.some((s) => safeEqual(s, expected));
}

export function signStripePayload(rawBody: string, secret: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

const STATUS: Record<string, SubscriptionStatus> = {
  trialing: "active", active: "active", past_due: "past_due", unpaid: "past_due", incomplete: "past_due",
  canceled: "cancelled", incomplete_expired: "cancelled", paused: "past_due",
};

const date = (unix: unknown) => (typeof unix === "number" ? new Date(unix * 1000) : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as Json).id === "string" ? ((v as Json).id as string) : null);

export class StripeBillingProvider implements BillingProvider {
  readonly key = "stripe" as const;
  readonly label = "Stripe";
  readonly development = false;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly cfg: StripeConfig) {
    if (!cfg.secretKey || !cfg.webhookSecret) throw new BillingConfigError("Stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.");
    this.env = cfg.env ?? process.env;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.apiBase = cfg.apiBase ?? "https://api.stripe.com";
  }

  priceFor(plan: PlanKey, interval: BillingInterval, unit = false): string | null {
    return this.env[`${stripePriceEnvName(plan, interval)}${unit ? "_UNIT" : ""}`] || null;
  }

  // reverse lookup: which plan/interval a Stripe price id belongs to
  planForPrice(priceId: string | null): { planKey: PlanKey; interval: BillingInterval } | null {
    if (!priceId) return null;
    for (const p of PLAN_KEYS) for (const i of BILLING_INTERVALS) if (this.priceFor(p, i) === priceId) return { planKey: p, interval: i };
    return null;
  }

  private async call(method: "GET" | "POST", path: string, params: Json = {}, idempotencyKey?: string): Promise<Json> {
    const body = formEncode(params);
    const url = `${this.apiBase}${path}${method === "GET" && body ? `?${body}` : ""}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new Error(`Stripe ${method} ${path} failed (${res.status}): ${String((json.error as Json | undefined)?.message ?? "unknown error")}`);
    return json;
  }

  private requirePrice(plan: PlanKey, interval: BillingInterval): string {
    const id = this.priceFor(plan, interval);
    if (!id) throw new BillingConfigError(`Set ${stripePriceEnvName(plan, interval)} to the Stripe price for this plan.`);
    return id;
  }

  async checkout(a: CheckoutArgs) {
    const lineItems: Json[] = [{ price: this.requirePrice(a.planKey, a.interval), quantity: 1 }];
    const unitPrice = this.priceFor(a.planKey, a.interval, true);
    const extra = Math.max(0, a.units - PLANS[a.planKey].includedUnits);
    if (unitPrice && extra > 0) lineItems.push({ price: unitPrice, quantity: extra });
    const meta = { org_id: a.orgId, plan_key: a.planKey, interval: a.interval };
    const session = await this.call("POST", "/v1/checkout/sessions", {
      mode: "subscription", success_url: a.successUrl, cancel_url: a.cancelUrl, client_reference_id: a.orgId,
      ...(a.customerId ? { customer: a.customerId } : { customer_email: a.email }),
      line_items: lineItems, metadata: meta, subscription_data: { metadata: meta },
    }, `checkout:${a.orgId}:${a.planKey}:${a.interval}:${Math.floor(Date.now() / 60_000)}`);
    if (typeof session.url !== "string") throw new Error("Stripe didn't return a checkout URL.");
    return { url: session.url };
  }

  async changePlan(a: ChangeArgs): Promise<NormalizedBillingEvent[]> {
    if (!a.sub.providerSubscriptionId) throw new BillingConfigError("This subscription isn't linked to Stripe.");
    const sub = await this.call("GET", `/v1/subscriptions/${a.sub.providerSubscriptionId}`);
    const items = ((sub.items as Json)?.data as Json[]) ?? [];
    const baseItem = items.find((it) => this.planForPrice(str((it as Json).price)));
    if (!baseItem) throw new Error("Couldn't find the plan's price on the Stripe subscription.");
    // upgrades are prorated immediately; downgrades switch now and bill the lower price from the next invoice
    await this.call("POST", `/v1/subscriptions/${a.sub.providerSubscriptionId}`, {
      items: [{ id: baseItem.id as string, price: this.requirePrice(a.planKey, a.interval) }],
      proration_behavior: a.when === "now" ? "create_prorations" : "none",
      metadata: { org_id: a.sub.orgId, plan_key: a.planKey, interval: a.interval },
    }, `change:${a.sub.id}:${a.planKey}:${a.interval}:${Math.floor(a.now.getTime() / 60_000)}`);
    return []; // the new state arrives as customer.subscription.updated
  }

  async setCancelAtPeriodEnd(sub: SubscriptionRow, cancel: boolean): Promise<NormalizedBillingEvent[]> {
    if (!sub.providerSubscriptionId) throw new BillingConfigError("This subscription isn't linked to Stripe.");
    await this.call("POST", `/v1/subscriptions/${sub.providerSubscriptionId}`, { cancel_at_period_end: cancel ? "true" : "false" });
    return [];
  }

  async portalUrl(sub: SubscriptionRow, returnUrl: string) {
    if (!sub.providerCustomerId) throw new BillingConfigError("This organization has no Stripe customer yet.");
    const s = await this.call("POST", "/v1/billing_portal/sessions", { customer: sub.providerCustomerId, return_url: returnUrl });
    if (typeof s.url !== "string") throw new Error("Stripe didn't return a portal URL.");
    return s.url;
  }

  async syncUnits(sub: SubscriptionRow, units: number) {
    if (!sub.providerSubscriptionId) return;
    const plan = sub.planKey as PlanKey;
    const unitPrice = this.priceFor(plan, sub.interval as BillingInterval, true);
    if (!unitPrice) return;
    const qty = Math.max(0, units - PLANS[plan].includedUnits);
    const s = await this.call("GET", `/v1/subscriptions/${sub.providerSubscriptionId}`);
    const item = (((s.items as Json)?.data as Json[]) ?? []).find((it) => str(it.price) === unitPrice);
    if (item && item.quantity === qty) return;
    if (item) await this.call("POST", `/v1/subscription_items/${item.id as string}`, { quantity: qty, proration_behavior: "none" });
    else if (qty > 0) await this.call("POST", "/v1/subscription_items", { subscription: sub.providerSubscriptionId, price: unitPrice, quantity: qty, proration_behavior: "none" });
  }

  parseWebhook(rawBody: string, headers: Headers, now = new Date()): NormalizedBillingEvent[] {
    if (!verifyStripeSignature(rawBody, headers.get("stripe-signature"), this.cfg.webhookSecret, now)) throw new WebhookSignatureError();
    const evt = JSON.parse(rawBody) as Json;
    const type = String(evt.type ?? "");
    const obj = ((evt.data as Json)?.object ?? {}) as Json;
    const base = { provider: "stripe" as const, eventId: String(evt.id ?? ""), rawType: type };
    const meta = (obj.metadata ?? {}) as Record<string, string>;
    switch (type) {
      case "checkout.session.completed": {
        if (obj.mode !== "subscription") return [];
        const planKey = meta.plan_key as PlanKey;
        const interval = meta.interval as BillingInterval;
        const orgId = (obj.client_reference_id as string) ?? meta.org_id;
        if (!orgId || !PLAN_KEYS.includes(planKey) || !BILLING_INTERVALS.includes(interval)) return [];
        // the period is confirmed by the subscription events that follow; until then assume one interval from now
        const start = date(obj.created) ?? now;
        const end = addInterval(start, interval);
        return [{ ...base, kind: "checkout.completed", orgId, customerId: str(obj.customer), subscriptionId: str(obj.subscription), planKey, interval, periodStart: start, periodEnd: end }];
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const items = ((obj.items as Json)?.data as Json[]) ?? [];
        const plan = items.map((it) => this.planForPrice(str(it.price))).find(Boolean) ?? null;
        const first = items[0] ?? {};
        return [{
          ...base, kind: "subscription.updated", orgId: meta.org_id ?? null, customerId: str(obj.customer), subscriptionId: str(obj.id),
          status: STATUS[String(obj.status)] ?? "past_due", planKey: plan?.planKey, interval: plan?.interval,
          periodStart: date(obj.current_period_start ?? first.current_period_start), periodEnd: date(obj.current_period_end ?? first.current_period_end),
          cancelAtPeriodEnd: obj.cancel_at_period_end === true,
        }];
      }
      case "customer.subscription.deleted":
        return [{ ...base, kind: "subscription.deleted", orgId: meta.org_id ?? null, customerId: str(obj.customer), subscriptionId: str(obj.id) }];
      case "invoice.finalized":
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.voided":
      case "invoice.marked_uncollectible": {
        const lines: InvoiceLine[] = (((obj.lines as Json)?.data as Json[]) ?? []).map((l) => {
          const qty = typeof l.quantity === "number" ? l.quantity : 1;
          const amount = typeof l.amount === "number" ? l.amount : 0;
          return { description: String(l.description ?? "Subscription"), quantity: qty, unitCents: qty ? Math.round(amount / qty) : amount, amountCents: amount };
        });
        const status = type === "invoice.paid" ? "paid" : type === "invoice.voided" ? "void" : type === "invoice.marked_uncollectible" ? "uncollectible"
          : (obj.status === "paid" ? "paid" : "open");
        const parent = (obj.parent as Json | undefined)?.subscription_details as Json | undefined;
        return [{
          ...base, kind: "invoice.updated", orgId: meta.org_id ?? null, customerId: str(obj.customer), subscriptionId: str(obj.subscription) ?? str(parent?.subscription),
          invoiceId: String(obj.id), number: String(obj.number ?? obj.id), status, totalCents: Number(obj.total ?? obj.amount_due ?? 0),
          currency: String(obj.currency ?? "cad").toUpperCase(), lines, periodStart: date(obj.period_start) ?? null, periodEnd: date(obj.period_end) ?? null,
          hostedUrl: (obj.hosted_invoice_url as string) ?? null, paymentFailed: type === "invoice.payment_failed",
        }];
      }
      default:
        return [];
    }
  }
}

export class WebhookSignatureError extends Error {
  constructor() {
    super("Invalid webhook signature.");
  }
}
