import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { formEncode, signStripePayload, StripeBillingProvider, verifyStripeSignature, WebhookSignatureError } from "./stripe";
import { makeCheckoutToken, MockBillingProvider, readCheckoutToken } from "./mock";
import type { SubscriptionRow } from "../entitlements";

const KEY = randomBytes(32).toString("base64");
const ORG = "0b9d6a3e-5f43-4a52-9f0e-8f6d2c1a7e11";
const now = new Date("2026-10-18T12:00:00Z");

const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: "c9b1b5f2-6a0b-4c55-9c69-0e8cc2a1d001", orgId: ORG, planKey: "starter", interval: "month", status: "active", provider: "mock",
  providerCustomerId: "mock_cus_1", providerSubscriptionId: "mock_sub_1", trialEndsAt: null, trialNoticeSentAt: null,
  currentPeriodStart: new Date("2026-10-01T12:00:00Z"), currentPeriodEnd: new Date("2026-11-01T12:00:00Z"), cancelAtPeriodEnd: false,
  pendingPlanKey: null, pendingInterval: null, pastDueSince: null, limitOverrides: {}, lastPaidCents: 7_900, createdAt: now, updatedAt: now, ...over,
});

describe("development provider", () => {
  it("signs checkout tokens and rejects tampered or expired ones", () => {
    const t = makeCheckoutToken({ o: ORG, u: "u1", p: "professional", i: "month", n: 120 }, KEY, now.getTime());
    expect(readCheckoutToken(t, KEY, now.getTime())).toMatchObject({ o: ORG, p: "professional", i: "month", n: 120 });
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), p: "enterprise" })).toString("base64url");
    expect(readCheckoutToken(`${forged}.${sig}`, KEY, now.getTime())).toBeNull();
    expect(readCheckoutToken(t, randomBytes(32).toString("base64"), now.getTime())).toBeNull();
    expect(readCheckoutToken(t, KEY, now.getTime() + 2 * 3600_000)).toBeNull();
  });
  it("reports a completed checkout as a subscription plus a paid invoice, with stable event ids", () => {
    const m = new MockBillingProvider(KEY);
    const t = readCheckoutToken(makeCheckoutToken({ o: ORG, u: "u1", p: "professional", i: "month", n: 339 }, KEY, now.getTime()), KEY, now.getTime())!;
    const [a, b] = m.completeCheckout(t, null, now);
    expect(a).toMatchObject({ kind: "checkout.completed", orgId: ORG, planKey: "professional", periodStart: now });
    expect(b).toMatchObject({ kind: "invoice.updated", status: "paid", totalCents: 37_020 });
    expect(m.completeCheckout(t, null, now).map((e) => e.eventId)).toEqual([a.eventId, b.eventId]); // same token, same events
  });
  it("upgrades now with a credit for unused time; schedules downgrades for the period end", async () => {
    const m = new MockBillingProvider(KEY);
    const half = new Date("2026-10-16T12:00:00Z");
    const [u, inv] = await m.changePlan({ sub: sub(), planKey: "professional", interval: "month", units: 100, when: "now", now: half });
    expect(u).toMatchObject({ kind: "subscription.updated", planKey: "professional", status: "active", periodStart: half });
    if (inv.kind !== "invoice.updated") throw new Error("expected an invoice");
    const credit = inv.lines.find((l) => l.amountCents < 0)!;
    expect(credit.amountCents).toBe(-4_077); // 16 of 31 days unused of $79
    expect(inv.totalCents).toBe(29_900 - 4_077);
    const [d] = await m.changePlan({ sub: sub({ planKey: "professional" }), planKey: "starter", interval: "month", units: 100, when: "period_end", now: half });
    expect(d).toMatchObject({ kind: "subscription.updated", pending: { planKey: "starter", interval: "month" } });
  });
  it("renews into the scheduled plan, or ends a cancelled subscription", () => {
    const m = new MockBillingProvider(KEY);
    const due = new Date("2026-11-01T12:01:00Z");
    const [r, inv] = m.renew(sub({ pendingPlanKey: "professional", pendingInterval: "year" }), 80, due);
    expect(r).toMatchObject({ kind: "subscription.updated", planKey: "professional", interval: "year", pending: null, periodEnd: new Date("2027-11-01T12:00:00Z") });
    expect(inv).toMatchObject({ kind: "invoice.updated", totalCents: 299_000 });
    expect(m.renew(sub({ cancelAtPeriodEnd: true }), 80, due)).toMatchObject([{ kind: "subscription.deleted" }]);
    // renewing the same period twice yields the same event ids (applied once)
    expect(m.renew(sub(), 80, due)[0].eventId).toBe(m.renew(sub(), 80, due)[0].eventId);
  });
});

describe("Stripe adapter", () => {
  const env = { STRIPE_PRICE_STARTER_MONTH: "price_s_m", STRIPE_PRICE_PROFESSIONAL_MONTH: "price_p_m", STRIPE_PRICE_PROFESSIONAL_YEAR: "price_p_y" };
  const secret = "whsec_test_secret";
  const stripe = (fetchImpl?: typeof fetch) => new StripeBillingProvider({ secretKey: "sk_test_x", webhookSecret: secret, env, fetchImpl });
  const signed = (payload: unknown, at = now) => {
    const raw = JSON.stringify(payload);
    return { raw, headers: new Headers({ "stripe-signature": signStripePayload(raw, secret, at) }) };
  };

  it("encodes nested parameters the way Stripe expects", () => {
    expect(decodeURIComponent(formEncode({ mode: "subscription", line_items: [{ price: "p1", quantity: 1 }], metadata: { org_id: "o" } })))
      .toBe("mode=subscription&line_items[0][price]=p1&line_items[0][quantity]=1&metadata[org_id]=o");
  });
  it("verifies signatures with a five-minute tolerance", () => {
    const { raw, headers } = signed({ id: "evt_1" });
    expect(verifyStripeSignature(raw, headers.get("stripe-signature"), secret, now)).toBe(true);
    expect(verifyStripeSignature(raw + " ", headers.get("stripe-signature"), secret, now)).toBe(false);
    expect(verifyStripeSignature(raw, headers.get("stripe-signature"), secret, new Date(now.getTime() + 6 * 60_000))).toBe(false);
    expect(() => stripe().parseWebhook(raw, new Headers({ "stripe-signature": "t=1,v1=00" }), now)).toThrow(WebhookSignatureError);
  });
  it("translates checkout, subscription and invoice events", () => {
    const s = stripe();
    const co = signed({ id: "evt_co", type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: ORG, customer: "cus_1", subscription: "sub_1", created: Math.floor(now.getTime() / 1000), metadata: { org_id: ORG, plan_key: "professional", interval: "month" } } } });
    expect(s.parseWebhook(co.raw, co.headers, now)).toMatchObject([{ kind: "checkout.completed", orgId: ORG, customerId: "cus_1", subscriptionId: "sub_1", planKey: "professional", interval: "month" }]);
    const up = signed({ id: "evt_up", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "past_due", cancel_at_period_end: true, metadata: {},
      items: { data: [{ price: { id: "price_p_y" }, current_period_start: 1_790_000_000, current_period_end: 1_821_536_000 }] } } } });
    expect(s.parseWebhook(up.raw, up.headers, now)).toMatchObject([{ kind: "subscription.updated", status: "past_due", planKey: "professional", interval: "year", cancelAtPeriodEnd: true, periodStart: new Date(1_790_000_000_000) }]);
    const inv = signed({ id: "evt_in", type: "invoice.payment_failed", data: { object: { id: "in_1", number: "A-001", customer: "cus_1", subscription: "sub_1", status: "open", total: 29_900, currency: "cad",
      lines: { data: [{ description: "Professional", amount: 29_900, quantity: 1 }] } } } });
    expect(s.parseWebhook(inv.raw, inv.headers, now)).toMatchObject([{ kind: "invoice.updated", invoiceId: "in_1", status: "open", paymentFailed: true, totalCents: 29_900, currency: "CAD" }]);
    const other = signed({ id: "evt_x", type: "customer.created", data: { object: {} } });
    expect(s.parseWebhook(other.raw, other.headers, now)).toEqual([]);
  });
  it("creates checkout sessions and plan changes with the configured prices", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as string | undefined });
      if (String(url).includes("/v1/subscriptions/sub_1") && init?.method === "GET") return new Response(JSON.stringify({ items: { data: [{ id: "si_1", price: { id: "price_s_m" } }] } }));
      return new Response(JSON.stringify({ url: "https://checkout.stripe.test/c/1", id: "x" }));
    }) as unknown as typeof fetch;
    const s = stripe(fetchImpl);
    const r = await s.checkout({ orgId: ORG, orgSlug: "o", orgName: "O", userId: "u", email: "a@b.test", planKey: "professional", interval: "month", units: 10, customerId: null, successUrl: "https://app/s", cancelUrl: "https://app/c" });
    expect(r.url).toBe("https://checkout.stripe.test/c/1");
    expect(decodeURIComponent(calls[0].body!)).toContain("line_items[0][price]=price_p_m");
    expect(decodeURIComponent(calls[0].body!)).toContain("client_reference_id=" + ORG);
    await expect(s.changePlan({ sub: sub({ provider: "stripe", providerSubscriptionId: "sub_1" }), planKey: "professional", interval: "month", units: 10, when: "now", now })).resolves.toEqual([]);
    expect(decodeURIComponent(calls.at(-1)!.body!)).toContain("items[0][id]=si_1&items[0][price]=price_p_m&proration_behavior=create_prorations");
    await expect(s.checkout({ orgId: ORG, orgSlug: "o", orgName: "O", userId: "u", email: "", planKey: "enterprise", interval: "year", units: 1, customerId: null, successUrl: "", cancelUrl: "" })).rejects.toThrow(/STRIPE_PRICE_ENTERPRISE_YEAR/);
  });
});
