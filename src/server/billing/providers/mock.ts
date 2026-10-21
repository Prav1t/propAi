import { createHmac, randomUUID } from "node:crypto";
import { PLANS, isPlanKey, type BillingInterval, type PlanKey } from "@/config/plans";
import { addInterval, prorationCreditCents, quote, type InvoiceLine } from "@/lib/billing";
import { safeEqual } from "../../auth/crypto";
import type { SubscriptionRow } from "../entitlements";
import type { BillingProvider, ChangeArgs, CheckoutArgs, NormalizedBillingEvent } from "./types";

// Development billing provider: a local checkout page, deterministic invoices and the same events a real provider
// would send. Nothing is charged. Every screen that uses it says so.

const CHECKOUT_TTL_MS = 60 * 60_000;

type Token = { o: string; u: string; p: PlanKey; i: BillingInterval; n: number; e: number; c: string };

function sign(body: string, key: string) {
  return createHmac("sha256", Buffer.from(key, "base64")).update(`mock-checkout.${body}`).digest("base64url");
}

export function makeCheckoutToken(t: Omit<Token, "c" | "e">, key: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...t, e: now + CHECKOUT_TTL_MS, c: randomUUID() } satisfies Token)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

export function readCheckoutToken(token: string, key: string, now = Date.now()): Token | null {
  const [body, sig] = token.split(".");
  if (!body || !sig || !safeEqual(sig, sign(body, key))) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Token;
    if (!t || typeof t.o !== "string" || !isPlanKey(t.p) || (t.i !== "month" && t.i !== "year") || typeof t.e !== "number" || t.e < now) return null;
    return t;
  } catch {
    return null;
  }
}

let seq = 0;
const invoiceNumber = (now: Date) => `DEV-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${String(Date.now() % 100000).padStart(5, "0")}${(seq++ % 10)}`;

function invoiceEvent(orgId: string, customerId: string, subscriptionId: string, lines: InvoiceLine[], periodStart: Date, periodEnd: Date, now: Date, eventId: string): NormalizedBillingEvent {
  const total = Math.max(0, lines.reduce((a, l) => a + l.amountCents, 0));
  return {
    kind: "invoice.updated", provider: "mock", eventId, rawType: "mock.invoice.paid", orgId, customerId, subscriptionId,
    invoiceId: `mock_in_${randomUUID()}`, number: invoiceNumber(now), status: "paid", totalCents: total, currency: "CAD", lines, periodStart, periodEnd, hostedUrl: null,
  };
}

export class MockBillingProvider implements BillingProvider {
  readonly key = "mock" as const;
  readonly label = "Development billing (no real payments)";
  readonly development = true;

  constructor(private readonly secret: string) {}

  async checkout(a: CheckoutArgs) {
    const token = makeCheckoutToken({ o: a.orgId, u: a.userId, p: a.planKey, i: a.interval, n: a.units }, this.secret);
    return { url: `/o/${a.orgSlug}/settings/billing/checkout?token=${encodeURIComponent(token)}` };
  }

  // the person confirmed on the local checkout page: what a provider would report after a successful payment
  completeCheckout(t: Token, existing: SubscriptionRow | null, now = new Date()): NormalizedBillingEvent[] {
    const customerId = existing?.provider === "mock" && existing.providerCustomerId ? existing.providerCustomerId : `mock_cus_${t.o.slice(0, 8)}`;
    const subscriptionId = `mock_sub_${t.c}`;
    const periodEnd = addInterval(now, t.i);
    const q = quote(PLANS[t.p], t.i, t.n);
    return [
      { kind: "checkout.completed", provider: "mock", eventId: `mock_checkout_${t.c}`, rawType: "mock.checkout.completed", orgId: t.o, customerId, subscriptionId, planKey: t.p, interval: t.i, periodStart: now, periodEnd },
      invoiceEvent(t.o, customerId, subscriptionId, q.lines, now, periodEnd, now, `mock_checkout_invoice_${t.c}`),
    ];
  }

  async changePlan(a: ChangeArgs): Promise<NormalizedBillingEvent[]> {
    const { sub, now } = a;
    const base = { provider: "mock" as const, orgId: sub.orgId, customerId: sub.providerCustomerId, subscriptionId: sub.providerSubscriptionId };
    if (a.when === "period_end") {
      return [{ ...base, kind: "subscription.updated", eventId: `mock_${randomUUID()}`, rawType: "mock.subscription.scheduled_change", status: sub.status as "active", pending: { planKey: a.planKey, interval: a.interval } }];
    }
    // upgrade now: credit the unused part of what was paid, charge the new plan for a fresh period starting today
    const credit = sub.currentPeriodStart && sub.currentPeriodEnd ? prorationCreditCents(sub.lastPaidCents ?? 0, sub.currentPeriodStart, sub.currentPeriodEnd, now) : 0;
    const periodEnd = addInterval(now, a.interval);
    const q = quote(PLANS[a.planKey], a.interval, a.units);
    const lines: InvoiceLine[] = [...q.lines];
    if (credit > 0) lines.push({ description: `Unused time on ${PLANS[sub.planKey as PlanKey]?.name ?? sub.planKey} plan`, quantity: 1, unitCents: -credit, amountCents: -credit });
    return [
      { ...base, kind: "subscription.updated", eventId: `mock_${randomUUID()}`, rawType: "mock.subscription.updated", status: "active", planKey: a.planKey, interval: a.interval, periodStart: now, periodEnd, pending: null, cancelAtPeriodEnd: false },
      invoiceEvent(sub.orgId, sub.providerCustomerId ?? "", sub.providerSubscriptionId ?? "", lines, now, periodEnd, now, `mock_${randomUUID()}`),
    ];
  }

  async setCancelAtPeriodEnd(sub: SubscriptionRow, cancel: boolean): Promise<NormalizedBillingEvent[]> {
    return [{ kind: "subscription.updated", provider: "mock", eventId: `mock_${randomUUID()}`, rawType: cancel ? "mock.subscription.cancel_scheduled" : "mock.subscription.resumed",
      orgId: sub.orgId, subscriptionId: sub.providerSubscriptionId, status: sub.status as "active", cancelAtPeriodEnd: cancel }];
  }

  // the period ended: cancel, or renew (applying any scheduled downgrade) and charge the next period.
  // Event ids are derived from the period so a renewal is applied once even if the worker runs twice.
  renew(sub: SubscriptionRow, units: number, now: Date): NormalizedBillingEvent[] {
    if (!sub.currentPeriodEnd) return [];
    const slot = sub.currentPeriodEnd.toISOString();
    const base = { provider: "mock" as const, orgId: sub.orgId, customerId: sub.providerCustomerId, subscriptionId: sub.providerSubscriptionId };
    if (sub.cancelAtPeriodEnd) return [{ ...base, kind: "subscription.deleted", eventId: `mock_end_${sub.id}_${slot}`, rawType: "mock.subscription.deleted" }];
    const planKey = (sub.pendingPlanKey && isPlanKey(sub.pendingPlanKey) ? sub.pendingPlanKey : sub.planKey) as PlanKey;
    const interval = (sub.pendingInterval ?? sub.interval) as BillingInterval;
    const start = sub.currentPeriodEnd;
    let end = addInterval(start, interval);
    while (end.getTime() <= now.getTime()) end = addInterval(end, interval); // a long-idle dev database catches up in one step
    const q = quote(PLANS[planKey], interval, units);
    return [
      { ...base, kind: "subscription.updated", eventId: `mock_renew_${sub.id}_${slot}`, rawType: "mock.subscription.renewed", status: "active", planKey, interval, periodStart: start, periodEnd: end, pending: null },
      invoiceEvent(sub.orgId, sub.providerCustomerId ?? "", sub.providerSubscriptionId ?? "", q.lines, start, end, now, `mock_renew_invoice_${sub.id}_${slot}`),
    ];
  }
}
