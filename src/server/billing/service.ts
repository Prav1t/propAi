import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { setTxOrg, withContext, type Tx } from "../db/client";
import { billingEvents, invoices, organizations, residents, subscriptions, unitOccupancies, usageRecords, users } from "../db/schema";
import { authorize, ForbiddenError } from "../authz/authorize";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { writeAudit } from "../audit";
import { emitSystem } from "../modules/ops/core";
import { env, isProd } from "../env";
import { log } from "../log";
import { activeOrgs } from "../system-orgs";
import { PLANS, PLAN_KEYS, TRIAL_NOTICE_DAYS, TRIAL_PLAN, isPlanKey, type BillingInterval, type PlanKey } from "@/config/plans";
import {
  addInterval, changeKind, describeViolation, effectiveLimits, limitViolations, quote, type InvoiceLine, type LimitOverrides, type LimitViolation, type Quote, type Usage,
} from "@/lib/billing";
import { MockBillingProvider, readCheckoutToken } from "./providers/mock";
import { StripeBillingProvider } from "./providers/stripe";
import { BillingConfigError, type BillingProvider, type NormalizedBillingEvent } from "./providers/types";
import { countUsage, currentUsage, getEntitlements, loadEntitlements, type Entitlements, type SubscriptionRow } from "./entitlements";

const DAY = 86_400_000;

/* ───────────── providers ───────────── */

export function mockProvider(): MockBillingProvider {
  return new MockBillingProvider(env().APP_ENCRYPTION_KEY);
}

export function stripeProvider(): StripeBillingProvider {
  const e = env();
  return new StripeBillingProvider({ secretKey: e.STRIPE_SECRET_KEY ?? "", webhookSecret: e.STRIPE_WEBHOOK_SECRET ?? "" });
}

// the provider new checkouts go to (BILLING_PROVIDER); the mock is refused in production unless explicitly allowed
export function billingProvider(): BillingProvider {
  if (env().BILLING_PROVIDER === "stripe") return stripeProvider();
  if (isProd() && process.env.BILLING_ALLOW_MOCK !== "true") throw new BillingConfigError("Billing isn't configured for this deployment (set BILLING_PROVIDER=stripe).");
  return mockProvider();
}

// an existing subscription stays with the provider that created it
export const providerFor = (sub: SubscriptionRow): BillingProvider => (sub.provider === "stripe" ? stripeProvider() : mockProvider());

/* ───────────── trials ───────────── */

// every new organization starts a free trial of the trial plan; no payment details needed
export async function startTrial(tx: Tx, orgId: string, now = new Date()): Promise<void> {
  const plan = PLANS[TRIAL_PLAN];
  await tx.insert(subscriptions).values({
    orgId, planKey: plan.key, interval: "month", status: "trialing", provider: "none", trialEndsAt: new Date(now.getTime() + plan.trialDays * DAY),
  }).onConflictDoNothing();
  await tx.update(organizations).set({ planKey: plan.key }).where(eq(organizations.id, orgId));
}

/* ───────────── what the billing page shows ───────────── */

export type InvoiceRow = typeof invoices.$inferSelect;
export type PlanOption = { key: PlanKey; name: string; tagline: string; monthly: Quote; yearly: Quote; violations: LimitViolation[]; current: boolean };

export type BillingOverview = {
  ent: Entitlements;
  provider: { key: string; label: string; development: boolean } | null;
  usage: Usage;
  plans: PlanOption[];
  estimate: Quote | null; // the next period at today's unit count
  invoices: InvoiceRow[];
  history: { day: string; metric: string; quantity: number }[];
  canSelfServe: boolean;
  paidSubscription: boolean;
};

const isPaid = (sub: SubscriptionRow | null): boolean =>
  !!sub && (sub.provider === "mock" || sub.provider === "stripe") && !!sub.providerSubscriptionId && (sub.status === "active" || sub.status === "past_due");

export async function getBillingOverview(ctx: TenantCtx): Promise<BillingOverview> {
  authorize(ctx.principal, "billing.manage");
  const orgId = ctx.principal.orgId;
  return tenantTx(ctx, async (tx) => {
    const ent = await loadEntitlements(tx, orgId);
    const usage = await currentUsage(tx, orgId);
    const inv = await tx.select().from(invoices).where(eq(invoices.orgId, orgId)).orderBy(desc(invoices.issuedAt)).limit(24);
    const history = await tx.select({ day: usageRecords.day, metric: usageRecords.metric, quantity: usageRecords.quantity }).from(usageRecords)
      .where(and(eq(usageRecords.orgId, orgId), gte(usageRecords.day, sql`current_date - 30`))).orderBy(asc(usageRecords.day));
    const sub = ent.subscription;
    const overrides = (sub?.limitOverrides ?? {}) as LimitOverrides;
    const plans: PlanOption[] = PLAN_KEYS.map((k) => ({
      key: k, name: PLANS[k].name, tagline: PLANS[k].tagline, monthly: quote(PLANS[k], "month", usage.units), yearly: quote(PLANS[k], "year", usage.units),
      violations: limitViolations(effectiveLimits(PLANS[k], overrides), usage), current: ent.plan.key === k,
    }));
    let provider: BillingOverview["provider"] = null;
    try {
      const pr = sub && isPaid(sub) ? providerFor(sub) : billingProvider();
      provider = { key: pr.key, label: pr.label, development: pr.development };
    } catch {
      provider = null;
    }
    return {
      ent, provider, usage, plans, invoices: inv, history, canSelfServe: ent.flags.self_serve_billing, paidSubscription: isPaid(sub),
      estimate: sub && isPaid(sub) && !sub.cancelAtPeriodEnd ? quote(PLANS[(sub.pendingPlanKey ?? sub.planKey) as PlanKey], (sub.pendingInterval ?? sub.interval) as BillingInterval, usage.units) : null,
    };
  });
}

// a small read for the app shell: the read-only / trial banner
export async function billingBanner(orgId: string): Promise<{ state: Entitlements["access"]["state"]; readOnly: boolean; reason: string | null; daysLeft: number | null; planName: string }> {
  const e = await getEntitlements(orgId);
  return { state: e.access.state, readOnly: e.readOnly, reason: e.access.reason, daysLeft: e.access.daysLeft, planName: e.plan.name };
}

/* ───────────── changing the plan ───────────── */

export type ChangeResult = { redirectTo?: string; message: string };

function requireSelfServe(ent: Entitlements) {
  if (!ent.flags.self_serve_billing) throw new ForbiddenError("Plan changes for your organization are handled by support. Contact us to change your plan.");
}

export async function changePlan(ctx: TenantCtx, input: { planKey: PlanKey; interval: BillingInterval }, now = new Date()): Promise<ChangeResult> {
  const p = ctx.principal;
  authorize(p, "billing.manage");
  if (!isPlanKey(input.planKey)) throw new ValidationError("Choose a plan.", "planKey");
  const ent = await getEntitlements(p.orgId, now);
  requireSelfServe(ent);
  const sub = ent.subscription;
  const target = PLANS[input.planKey];
  const usage = await tenantTx(ctx, (tx) => currentUsage(tx, p.orgId));
  const violations = limitViolations(effectiveLimits(target, (sub?.limitOverrides ?? {}) as LimitOverrides), usage);
  const tooSmall = () => new ValidationError(`The ${target.name} plan is too small for your organization right now: ${violations.map(describeViolation).join("; ")}. Remove what you no longer need first, or pick a larger plan.`);

  // no paid subscription yet (trial, lapsed, or managed by support): pay through the provider's checkout
  if (!isPaid(sub)) {
    if (violations.length) throw tooSmall();
    const provider = billingProvider();
    const [u] = await withContext({ userId: p.userId }, (tx) => tx.select({ email: users.email }).from(users).where(eq(users.id, p.userId)));
    const base = `${env().APP_URL}/o/${p.orgSlug}/settings/billing`;
    const { url } = await provider.checkout({
      orgId: p.orgId, orgSlug: p.orgSlug, orgName: p.orgSlug, userId: p.userId, email: u?.email ?? "", planKey: input.planKey, interval: input.interval,
      units: usage.units, customerId: sub?.provider === provider.key ? sub.providerCustomerId : null, successUrl: `${base}?checkout=success`, cancelUrl: `${base}?checkout=cancelled`,
    });
    await tenantTx(ctx, (tx) => auditAs(tx, ctx, "billing.checkout_started", "subscription", sub?.id ?? null, undefined, { plan: input.planKey, interval: input.interval, provider: provider.key }));
    return { redirectTo: url, message: "Continue to checkout." };
  }

  const paid = sub!;
  const kind = changeKind({ plan: paid.planKey as PlanKey, interval: paid.interval as BillingInterval }, { plan: input.planKey, interval: input.interval });
  if (kind === "same") {
    if (!paid.pendingPlanKey) return { message: `You're already on the ${target.name} plan.` };
    await tenantTx(ctx, async (tx) => {
      await tx.update(subscriptions).set({ pendingPlanKey: null, pendingInterval: null }).where(eq(subscriptions.id, paid.id));
      await auditAs(tx, ctx, "billing.scheduled_change_cancelled", "subscription", paid.id, { pending: paid.pendingPlanKey }, { pending: null });
    });
    return { message: `The scheduled change was cancelled — you stay on ${target.name}.` };
  }
  if (kind === "downgrade" && violations.length) throw tooSmall();
  const provider = providerFor(paid);
  const events = await provider.changePlan({ sub: paid, planKey: input.planKey, interval: input.interval, units: usage.units, when: kind === "upgrade" ? "now" : "period_end", now });
  await applyBillingEvents(events, now);
  await tenantTx(ctx, (tx) => auditAs(tx, ctx, `billing.${kind}_requested`, "subscription", paid.id, { plan: paid.planKey, interval: paid.interval }, { plan: input.planKey, interval: input.interval, provider: provider.key }));
  if (provider.key === "stripe") {
    return { message: kind === "upgrade" ? `Stripe is moving you to ${target.name}; this page updates when Stripe confirms.` : `Switched to ${target.name} in Stripe; the lower price applies from your next invoice.` };
  }
  const end = paid.currentPeriodEnd?.toLocaleDateString("en-CA", { dateStyle: "medium" });
  return { message: kind === "upgrade" ? `You're now on ${target.name}. The invoice for the new period is below.` : `${target.name} starts on ${end}. Until then you keep everything in ${PLANS[paid.planKey as PlanKey].name}.` };
}

export async function setCancelAtPeriodEnd(ctx: TenantCtx, cancel: boolean): Promise<ChangeResult> {
  authorize(ctx.principal, "billing.manage");
  const ent = await getEntitlements(ctx.principal.orgId);
  requireSelfServe(ent);
  const sub = ent.subscription;
  if (!sub || !isPaid(sub)) throw new ValidationError("There's no paid subscription to change.");
  if (sub.cancelAtPeriodEnd === cancel) return { message: cancel ? "The subscription is already set to end." : "The subscription is already set to renew." };
  const provider = providerFor(sub);
  await applyBillingEvents(await provider.setCancelAtPeriodEnd(sub, cancel));
  await tenantTx(ctx, (tx) => auditAs(tx, ctx, cancel ? "billing.cancel_requested" : "billing.resume_requested", "subscription", sub.id, { cancelAtPeriodEnd: sub.cancelAtPeriodEnd }, { cancelAtPeriodEnd: cancel }));
  const end = sub.currentPeriodEnd?.toLocaleDateString("en-CA", { dateStyle: "medium" });
  if (provider.key === "stripe") return { message: "Sent to Stripe; this page updates when Stripe confirms." };
  return { message: cancel ? `The subscription will end on ${end}. Your data stays; the organization becomes read-only after that date until you choose a plan again.` : "The subscription will renew as usual." };
}

export async function billingPortalUrl(ctx: TenantCtx): Promise<string> {
  authorize(ctx.principal, "billing.manage");
  const ent = await getEntitlements(ctx.principal.orgId);
  const sub = ent.subscription;
  if (!sub || sub.provider !== "stripe") throw new ValidationError("Payment methods are managed in Stripe, which isn't used for this organization.");
  return stripeProvider().portalUrl(sub, `${env().APP_URL}/o/${ctx.principal.orgSlug}/settings/billing`);
}

// the local (development) checkout page: what it shows before the person confirms
export async function previewMockCheckout(ctx: TenantCtx, token: string) {
  authorize(ctx.principal, "billing.manage");
  const t = readCheckoutToken(token, env().APP_ENCRYPTION_KEY);
  if (!t || t.o !== ctx.principal.orgId || t.u !== ctx.principal.userId) return null;
  return { planKey: t.p, interval: t.i, plan: PLANS[t.p], quote: quote(PLANS[t.p], t.i, t.n) };
}

// the person pressed "Pay" on the development checkout page: apply what a real provider would report.
// Event ids come from the token, so pressing twice (or reloading) applies it once.
export async function completeMockCheckout(ctx: TenantCtx, token: string, now = new Date()): Promise<ChangeResult> {
  authorize(ctx.principal, "billing.manage");
  const t = readCheckoutToken(token, env().APP_ENCRYPTION_KEY, now.getTime());
  if (!t || t.o !== ctx.principal.orgId || t.u !== ctx.principal.userId) throw new ValidationError("This checkout link has expired. Choose the plan again.");
  const ent = await getEntitlements(t.o, now);
  const res = await applyBillingEvents(mockProvider().completeCheckout(t, ent.subscription, now), now);
  await tenantTx(ctx, (tx) => auditAs(tx, ctx, "billing.checkout_completed", "subscription", ent.subscription?.id ?? null, undefined, { plan: t.p, interval: t.i, provider: "mock", duplicate: res.duplicates > 0 }));
  return { message: `You're on the ${PLANS[t.p].name} plan (development billing — nothing was charged).` };
}

/* ───────────── provider events → subscription state (idempotent) ───────────── */

const plainEvent = (e: NormalizedBillingEvent) => JSON.parse(JSON.stringify(e)) as Record<string, unknown>;

async function findSubscription(tx: Tx, e: NormalizedBillingEvent): Promise<SubscriptionRow | null> {
  if (e.orgId) {
    const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, e.orgId));
    if (s) return s;
  }
  const conds = [
    e.subscriptionId ? and(eq(subscriptions.provider, e.provider), eq(subscriptions.providerSubscriptionId, e.subscriptionId)) : undefined,
    e.customerId ? and(eq(subscriptions.provider, e.provider), eq(subscriptions.providerCustomerId, e.customerId)) : undefined,
  ].filter(Boolean);
  if (!conds.length) return null;
  const [s] = await tx.select().from(subscriptions).where(or(...conds)).limit(1);
  return s ?? null;
}

async function syncOrgPlan(tx: Tx, orgId: string, planKey: string) {
  await tx.update(organizations).set({ planKey }).where(eq(organizations.id, orgId));
}

const sysAudit = (tx: Tx, orgId: string, action: string, entityId: string | null, before?: unknown, after?: unknown) =>
  writeAudit(tx, { orgId, actorUserId: null, action, entityType: "subscription", entityId, before, after });

async function applyOne(tx: Tx, e: NormalizedBillingEvent, now: Date): Promise<"processed" | "ignored"> {
  if (e.kind === "checkout.completed") {
    await setTxOrg(tx, e.orgId);
    const [before] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, e.orgId));
    const values = {
      planKey: e.planKey, interval: e.interval, status: "active", provider: e.provider, providerCustomerId: e.customerId ?? null, providerSubscriptionId: e.subscriptionId ?? null,
      currentPeriodStart: e.periodStart, currentPeriodEnd: e.periodEnd, cancelAtPeriodEnd: false, pendingPlanKey: null, pendingInterval: null, pastDueSince: null,
    };
    const [after] = before
      ? await tx.update(subscriptions).set(values).where(eq(subscriptions.id, before.id)).returning()
      : await tx.insert(subscriptions).values({ orgId: e.orgId, ...values }).returning();
    await syncOrgPlan(tx, e.orgId, e.planKey);
    await sysAudit(tx, e.orgId, "billing.subscription_started", after.id, before ? { plan: before.planKey, status: before.status } : undefined, { plan: e.planKey, interval: e.interval, provider: e.provider });
    return "processed";
  }

  const sub = await findSubscription(tx, e);
  if (!sub) return "ignored";
  await setTxOrg(tx, sub.orgId);
  // events about an older subscription (after the organization checked out again) don't touch the current one
  if (e.subscriptionId && sub.providerSubscriptionId && e.subscriptionId !== sub.providerSubscriptionId && e.kind !== "invoice.updated") return "ignored";

  if (e.kind === "subscription.updated") {
    const set: Partial<typeof subscriptions.$inferInsert> = { status: e.status };
    if (e.planKey) set.planKey = e.planKey;
    if (e.interval) set.interval = e.interval;
    if (e.periodStart) set.currentPeriodStart = e.periodStart;
    if (e.periodEnd) set.currentPeriodEnd = e.periodEnd;
    if (e.cancelAtPeriodEnd !== undefined) set.cancelAtPeriodEnd = e.cancelAtPeriodEnd;
    if (e.pending !== undefined) { set.pendingPlanKey = e.pending?.planKey ?? null; set.pendingInterval = e.pending?.interval ?? null; }
    if (e.customerId && !sub.providerCustomerId) set.providerCustomerId = e.customerId;
    set.pastDueSince = e.status === "past_due" ? sub.pastDueSince ?? now : null;
    await tx.update(subscriptions).set(set).where(eq(subscriptions.id, sub.id));
    if (e.planKey) await syncOrgPlan(tx, sub.orgId, e.planKey);
    await sysAudit(tx, sub.orgId, "billing.subscription_updated", sub.id,
      { plan: sub.planKey, interval: sub.interval, status: sub.status, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, pending: sub.pendingPlanKey },
      { plan: set.planKey ?? sub.planKey, interval: set.interval ?? sub.interval, status: e.status, cancelAtPeriodEnd: set.cancelAtPeriodEnd ?? sub.cancelAtPeriodEnd, pending: set.pendingPlanKey === undefined ? sub.pendingPlanKey : set.pendingPlanKey, source: e.rawType });
    return "processed";
  }

  if (e.kind === "subscription.deleted") {
    await tx.update(subscriptions).set({ status: "cancelled", cancelAtPeriodEnd: false, pendingPlanKey: null, pendingInterval: null }).where(eq(subscriptions.id, sub.id));
    await sysAudit(tx, sub.orgId, "billing.subscription_ended", sub.id, { status: sub.status }, { status: "cancelled" });
    await emitSystem(tx, sub.orgId, "billing.subscription_ended", { subscriptionId: sub.id });
    return "processed";
  }

  // invoice.updated
  const values = {
    orgId: sub.orgId, number: e.number, provider: e.provider, providerInvoiceId: e.invoiceId, status: e.status, currency: e.currency, totalCents: e.totalCents,
    lines: e.lines, periodStart: e.periodStart ?? null, periodEnd: e.periodEnd ?? null, hostedUrl: e.hostedUrl ?? null, paidAt: e.status === "paid" ? now : null,
    issuedAt: e.periodStart && e.periodStart.getTime() <= now.getTime() ? e.periodStart : now, // a period's invoice is issued when the period starts
  };
  await tx.insert(invoices).values(values).onConflictDoUpdate({
    target: [invoices.provider, invoices.providerInvoiceId],
    set: { status: values.status, totalCents: values.totalCents, lines: values.lines, hostedUrl: values.hostedUrl, paidAt: sql`coalesce(${invoices.paidAt}, ${values.paidAt})` },
  });
  if (e.status === "paid") {
    await tx.update(subscriptions).set({
      lastPaidCents: Math.max(0, e.totalCents),
      ...(sub.status === "past_due" ? { status: "active", pastDueSince: null } : {}),
    }).where(eq(subscriptions.id, sub.id));
  }
  if (e.paymentFailed) {
    await tx.update(subscriptions).set({ status: "past_due", pastDueSince: sub.pastDueSince ?? now }).where(eq(subscriptions.id, sub.id));
    await emitSystem(tx, sub.orgId, "billing.payment_failed", { subscriptionId: sub.id, invoiceNumber: e.number, totalCents: e.totalCents, currency: e.currency });
  }
  await sysAudit(tx, sub.orgId, e.paymentFailed ? "billing.payment_failed" : `billing.invoice_${e.status}`, sub.id, undefined, { invoice: e.number, totalCents: e.totalCents, status: e.status });
  return "processed";
}

// applies provider events once each: a repeated event id is skipped; a failed one is retried when the provider resends it
export async function applyBillingEvents(events: NormalizedBillingEvent[], now = new Date()): Promise<{ applied: number; duplicates: number; ignored: number }> {
  const out = { applied: 0, duplicates: 0, ignored: 0 };
  for (const e of events) {
    try {
      const r = await withContext({ system: true, orgId: e.orgId ?? null }, async (tx) => {
        await tx.insert(billingEvents).values({ provider: e.provider, eventId: e.eventId, type: e.rawType, payload: plainEvent(e), orgId: e.orgId ?? null }).onConflictDoNothing();
        // lock the event row: a concurrent delivery of the same event waits, then sees it processed
        const [row] = await tx.select().from(billingEvents).where(and(eq(billingEvents.provider, e.provider), eq(billingEvents.eventId, e.eventId))).for("update");
        if (row.status === "processed" || row.status === "ignored") return "duplicate" as const;
        const status = await applyOne(tx, e, now);
        const orgId = e.kind === "checkout.completed" ? e.orgId : (await findSubscription(tx, e))?.orgId ?? null;
        await tx.update(billingEvents).set({ status, orgId, processedAt: now, error: status === "ignored" ? "No matching organization or subscription." : null }).where(eq(billingEvents.id, row.id));
        return status;
      });
      if (r === "duplicate") out.duplicates++;
      else if (r === "ignored") out.ignored++;
      else out.applied++;
    } catch (err) {
      log.error("billing.event_failed", { provider: e.provider, eventId: e.eventId, type: e.rawType, err });
      // the transaction rolled back; keep a record of the failure (the provider's retry processes it again)
      await withContext({ system: true }, (tx) => tx.insert(billingEvents).values({ provider: e.provider, eventId: e.eventId, type: e.rawType, payload: plainEvent(e), status: "failed", error: String(err).slice(0, 500) })
        .onConflictDoUpdate({ target: [billingEvents.provider, billingEvents.eventId], set: { status: "failed", error: String(err).slice(0, 500) } })).catch(() => {});
      throw err;
    }
  }
  return out;
}

/* ───────────── usage metering ───────────── */

export const USAGE_METRICS = ["properties", "units", "active_residents", "staff_seats", "ai_requests", "api_requests", "webhook_deliveries"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

// counters that grow during the day (API requests, webhook deliveries)
export async function incrementUsage(orgId: string, metric: UsageMetric, by = 1): Promise<void> {
  await withContext({ orgId, system: true }, (tx) => tx.insert(usageRecords).values({ orgId, metric, day: sql`current_date`, quantity: by })
    .onConflictDoUpdate({ target: [usageRecords.orgId, usageRecords.metric, usageRecords.day], set: { quantity: sql`${usageRecords.quantity} + ${by}` } }));
}

// today's levels (units, residents, seats, month-to-date assistant requests) for every active organization
export async function snapshotUsage(now = new Date()): Promise<number> {
  const orgs = await activeOrgs();
  const day = now.toISOString().slice(0, 10);
  for (const o of orgs) {
    await withContext({ orgId: o.id, system: true }, async (tx) => {
      const set = async (metric: UsageMetric, quantity: number) =>
        tx.insert(usageRecords).values({ orgId: o.id, metric, day, quantity }).onConflictDoUpdate({ target: [usageRecords.orgId, usageRecords.metric, usageRecords.day], set: { quantity } });
      for (const k of ["properties", "units", "staff_seats", "ai_requests"] as const) await set(k, await countUsage(tx, o.id, k));
      const [r] = await tx.select({ n: sql<number>`count(distinct ${residents.id})::int` }).from(residents)
        .innerJoin(unitOccupancies, eq(unitOccupancies.residentId, residents.id))
        .where(and(eq(residents.orgId, o.id), or(isNull(unitOccupancies.endsOn), gte(unitOccupancies.endsOn, sql`current_date`))));
      await set("active_residents", r.n);
    });
  }
  return orgs.length;
}

/* ───────────── scheduled billing work (worker) ───────────── */

export async function billingTick(now = new Date()): Promise<{ notices: number; expired: number; renewed: number }> {
  let notices = 0, expired = 0, renewed = 0;
  // 1. trial ending soon: tell the people who can pay, once
  const soon = await withContext({ system: true }, (tx) => tx.select().from(subscriptions).where(and(eq(subscriptions.status, "trialing"), isNull(subscriptions.trialNoticeSentAt),
    lte(subscriptions.trialEndsAt, new Date(now.getTime() + TRIAL_NOTICE_DAYS * DAY)), gte(subscriptions.trialEndsAt, now))));
  for (const s of soon) {
    await withContext({ orgId: s.orgId, system: true }, async (tx) => {
      const done = await tx.update(subscriptions).set({ trialNoticeSentAt: now }).where(and(eq(subscriptions.id, s.id), isNull(subscriptions.trialNoticeSentAt))).returning({ id: subscriptions.id });
      if (done.length) await emitSystem(tx, s.orgId, "billing.trial_ending", { subscriptionId: s.id, trialEndsAt: s.trialEndsAt?.toISOString() });
    });
    notices++;
  }
  // 2. trials that ended without a plan: read-only (nothing is deleted)
  const ended = await withContext({ system: true }, (tx) => tx.select().from(subscriptions).where(and(eq(subscriptions.status, "trialing"), lte(subscriptions.trialEndsAt, now))));
  for (const s of ended) {
    await withContext({ orgId: s.orgId, system: true }, async (tx) => {
      const done = await tx.update(subscriptions).set({ status: "expired" }).where(and(eq(subscriptions.id, s.id), eq(subscriptions.status, "trialing"))).returning({ id: subscriptions.id });
      if (!done.length) return;
      await sysAudit(tx, s.orgId, "billing.trial_ended", s.id, { status: "trialing" }, { status: "expired" });
      await emitSystem(tx, s.orgId, "billing.trial_ended", { subscriptionId: s.id });
    });
    expired++;
  }
  // 3. periods that ended: the development provider renews (or ends) its subscriptions here; Stripe does it itself and
  //    tells us by webhook; subscriptions managed by support simply roll forward
  const due = await withContext({ system: true }, (tx) => tx.select().from(subscriptions)
    .where(and(inArray(subscriptions.provider, ["mock", "manual"]), inArray(subscriptions.status, ["active", "past_due"]), lte(subscriptions.currentPeriodEnd, now))));
  for (const s of due) {
    try {
      if (s.provider === "manual") {
        await withContext({ orgId: s.orgId, system: true }, async (tx) => {
          if (s.cancelAtPeriodEnd) await tx.update(subscriptions).set({ status: "cancelled", cancelAtPeriodEnd: false }).where(eq(subscriptions.id, s.id));
          else {
            let end = s.currentPeriodEnd!;
            let start = end;
            while (end.getTime() <= now.getTime()) { start = end; end = addInterval(end, s.interval as BillingInterval); }
            await tx.update(subscriptions).set({ currentPeriodStart: start, currentPeriodEnd: end }).where(eq(subscriptions.id, s.id));
          }
        });
      } else {
        const units = await withContext({ orgId: s.orgId, system: true }, (tx) => countUsage(tx, s.orgId, "units"));
        await applyBillingEvents(mockProvider().renew(s, units, now), now);
      }
      renewed++;
    } catch (err) {
      log.error("billing.renewal_failed", { subscriptionId: s.id, err });
    }
  }
  return { notices, expired, renewed };
}

/* ───────────── platform admin ───────────── */

export async function adminSetSubscription(actorUserId: string, orgId: string, input: {
  planKey: PlanKey; status?: "active" | "trialing"; extendTrialDays?: number; limitOverrides?: LimitOverrides;
}, now = new Date()) {
  return withContext({ orgId, platformAdmin: true }, async (tx) => {
    const [before] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
    const trialEndsAt = input.extendTrialDays ? new Date(Math.max(before?.trialEndsAt?.getTime() ?? 0, now.getTime()) + input.extendTrialDays * DAY) : before?.trialEndsAt ?? null;
    const status = input.extendTrialDays ? "trialing" : input.status ?? (before?.status === "expired" || before?.status === "cancelled" ? "active" : before?.status ?? "active");
    const managed = before && isPaid(before) ? {} : { provider: "manual", providerCustomerId: null, providerSubscriptionId: null };
    const values = {
      planKey: input.planKey, status, trialEndsAt, ...(input.extendTrialDays ? { trialNoticeSentAt: null } : {}),
      ...(status === "active" && !(before && isPaid(before)) ? { ...managed, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY), cancelAtPeriodEnd: false } : {}),
      ...(input.limitOverrides !== undefined ? { limitOverrides: input.limitOverrides } : {}),
    };
    const [after] = before
      ? await tx.update(subscriptions).set(values).where(eq(subscriptions.id, before.id)).returning()
      : await tx.insert(subscriptions).values({ orgId, interval: "month", provider: "manual", ...values }).returning();
    await syncOrgPlan(tx, orgId, input.planKey);
    await writeAudit(tx, { orgId, actorUserId, action: "billing.admin_updated", entityType: "subscription", entityId: after.id,
      before: before ? { plan: before.planKey, status: before.status, trialEndsAt: before.trialEndsAt, limitOverrides: before.limitOverrides } : undefined,
      after: { plan: after.planKey, status: after.status, trialEndsAt: after.trialEndsAt, limitOverrides: after.limitOverrides } });
    return after;
  });
}

export type InvoiceLineView = InvoiceLine;
