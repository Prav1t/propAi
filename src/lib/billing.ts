// Pure billing maths shared by the server, the billing page and tests (Iteration 10). No I/O here.
import {
  LIMITS, PAST_DUE_GRACE_DAYS, PLANS, YEARLY_MONTHS_CHARGED,
  type BillingInterval, type Feature, type LimitKey, type Plan, type PlanKey,
} from "@/config/plans";

export type InvoiceLine = { description: string; quantity: number; unitCents: number; amountCents: number };
export type Quote = { lines: InvoiceLine[]; totalCents: number; currency: string };

const DAY = 86_400_000;

export const formatMoney = (cents: number, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);

const months = (interval: BillingInterval) => (interval === "year" ? YEARLY_MONTHS_CHARGED : 1);

// the price of one billing period for an organization with `units` units
export function quote(plan: Plan, interval: BillingInterval, units: number): Quote {
  const m = months(interval);
  const per = interval === "year" ? "year" : "month";
  const lines: InvoiceLine[] = [{ description: `${plan.name} plan (${per}, includes ${plan.includedUnits.toLocaleString("en-CA")} units)`, quantity: 1, unitCents: plan.baseMonthlyCents * m, amountCents: plan.baseMonthlyCents * m }];
  const extra = Math.max(0, Math.floor(units) - plan.includedUnits);
  if (extra > 0) lines.push({ description: `Additional units above ${plan.includedUnits.toLocaleString("en-CA")}`, quantity: extra, unitCents: plan.perUnitMonthlyCents * m, amountCents: extra * plan.perUnitMonthlyCents * m });
  return { lines, totalCents: lines.reduce((a, l) => a + l.amountCents, 0), currency: plan.currency };
}

// a monthly-equivalent figure for comparing plans and estimating recurring revenue
export const monthlyEquivalentCents = (plan: Plan, interval: BillingInterval, units: number) =>
  Math.round(quote(plan, interval, units).totalCents / (interval === "year" ? 12 : 1));

// unused share of the current period, credited when a plan changes mid-period (never negative, never above what was paid)
export function prorationCreditCents(paidCents: number, periodStart: Date, periodEnd: Date, now: Date): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0 || paidCents <= 0) return 0;
  const left = Math.min(Math.max(periodEnd.getTime() - now.getTime(), 0), total);
  return Math.round((paidCents * left) / total);
}

// one period from `start`; a period starting on the 31st ends on the last day of a shorter month (never spills over)
export function addInterval(start: Date, interval: BillingInterval): Date {
  const months = interval === "year" ? 12 : 1;
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), lastDay), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
}

export type LimitOverrides = Partial<Record<LimitKey, number | null>>;

export function effectiveLimits(plan: Plan, overrides: LimitOverrides = {}): Record<LimitKey, number | null> {
  const out = { ...plan.limits };
  for (const k of Object.keys(LIMITS) as LimitKey[]) if (k in overrides) out[k] = overrides[k] ?? null;
  return out;
}

export type Usage = Record<LimitKey, number>;
export type LimitViolation = { key: LimitKey; used: number; limit: number };

// what wouldn't fit if the organization moved to these limits (used before a downgrade)
export function limitViolations(limits: Record<LimitKey, number | null>, usage: Usage, keys: LimitKey[] = ["properties", "units", "staff_seats"]): LimitViolation[] {
  return keys.flatMap((key) => {
    const limit = limits[key];
    return limit !== null && usage[key] > limit ? [{ key, used: usage[key], limit }] : [];
  });
}

export function describeViolation(v: LimitViolation): string {
  return `${v.used.toLocaleString("en-CA")} ${LIMITS[v.key].unit} in use; the plan allows ${v.limit.toLocaleString("en-CA")}`;
}

export const planHas = (plan: Plan, f: Feature) => plan.features.includes(f);

// upgrade = more capable plan, or the same plan billed yearly instead of monthly
export function changeKind(from: { plan: PlanKey; interval: BillingInterval }, to: { plan: PlanKey; interval: BillingInterval }): "same" | "upgrade" | "downgrade" {
  if (from.plan === to.plan && from.interval === to.interval) return "same";
  const a = PLANS[from.plan].rank;
  const b = PLANS[to.plan].rank;
  if (b > a) return "upgrade";
  if (b < a) return "downgrade";
  return to.interval === "year" ? "upgrade" : "downgrade";
}

/* ───────────── subscription state → access ───────────── */

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "cancelled", "expired"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type SubscriptionLike = {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  pastDueSince: Date | null;
  cancelAtPeriodEnd: boolean;
};

export type Access = {
  state: "trial" | "active" | "grace" | "read_only";
  readOnly: boolean;
  reason: string | null; // why changes are blocked, or what is about to happen
  daysLeft: number | null; // trial days left, or grace days left
};

const fmtDay = (d: Date) => d.toLocaleDateString("en-CA", { dateStyle: "medium", timeZone: "UTC" });

// Data is never deleted for non-payment: a lapsed organization keeps read access (and billing) until it pays.
export function accessFor(sub: SubscriptionLike | null, now: Date): Access {
  if (!sub) return { state: "read_only", readOnly: true, reason: "This organization has no subscription. Choose a plan in Organization → Billing.", daysLeft: null };
  const days = (d: Date) => Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY));
  switch (sub.status) {
    case "trialing":
      if (sub.trialEndsAt && sub.trialEndsAt.getTime() > now.getTime()) return { state: "trial", readOnly: false, reason: null, daysLeft: days(sub.trialEndsAt) };
      return { state: "read_only", readOnly: true, reason: `The free trial ended${sub.trialEndsAt ? ` on ${fmtDay(sub.trialEndsAt)}` : ""}. Choose a plan in Organization → Billing to keep making changes — nothing has been deleted.`, daysLeft: 0 };
    case "active":
      return { state: "active", readOnly: false, reason: sub.cancelAtPeriodEnd && sub.currentPeriodEnd ? `The subscription ends on ${fmtDay(sub.currentPeriodEnd)}.` : null, daysLeft: null };
    case "past_due": {
      const since = sub.pastDueSince ?? now;
      const graceEnd = new Date(since.getTime() + PAST_DUE_GRACE_DAYS * DAY);
      if (graceEnd.getTime() > now.getTime()) return { state: "grace", readOnly: false, reason: `A payment failed. Update the payment method by ${fmtDay(graceEnd)} to avoid read-only mode.`, daysLeft: days(graceEnd) };
      return { state: "read_only", readOnly: true, reason: "A payment is overdue. Update the payment method in Organization → Billing to keep making changes — nothing has been deleted.", daysLeft: 0 };
    }
    case "cancelled":
      return { state: "read_only", readOnly: true, reason: "The subscription was cancelled. Choose a plan in Organization → Billing to keep making changes — nothing has been deleted.", daysLeft: null };
    case "expired":
      return { state: "read_only", readOnly: true, reason: "The free trial ended. Choose a plan in Organization → Billing to keep making changes — nothing has been deleted.", daysLeft: 0 };
  }
}
