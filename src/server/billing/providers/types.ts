import type { BillingInterval, PlanKey } from "@/config/plans";
import type { InvoiceLine, SubscriptionStatus } from "@/lib/billing";
import type { SubscriptionRow } from "../entitlements";

// Billing providers translate their own events into these. The billing service applies them idempotently
// (billing_events is keyed by provider + event id), so a provider may deliver the same event any number of times.
type Base = { provider: "mock" | "stripe"; eventId: string; rawType: string; orgId?: string | null; customerId?: string | null; subscriptionId?: string | null };

export type NormalizedBillingEvent =
  | (Base & { kind: "checkout.completed"; orgId: string; planKey: PlanKey; interval: BillingInterval; periodStart: Date; periodEnd: Date })
  | (Base & {
      kind: "subscription.updated"; status: SubscriptionStatus; planKey?: PlanKey; interval?: BillingInterval; periodStart?: Date; periodEnd?: Date;
      cancelAtPeriodEnd?: boolean; pending?: { planKey: PlanKey; interval: BillingInterval } | null;
    })
  | (Base & { kind: "subscription.deleted" })
  | (Base & {
      kind: "invoice.updated"; invoiceId: string; number: string; status: "open" | "paid" | "void" | "uncollectible"; totalCents: number; currency: string;
      lines: InvoiceLine[]; periodStart?: Date | null; periodEnd?: Date | null; hostedUrl?: string | null; paymentFailed?: boolean;
    });

export type CheckoutArgs = {
  orgId: string; orgSlug: string; orgName: string; userId: string; email: string;
  planKey: PlanKey; interval: BillingInterval; units: number; customerId: string | null; successUrl: string; cancelUrl: string;
};

export type ChangeArgs = { sub: SubscriptionRow; planKey: PlanKey; interval: BillingInterval; units: number; when: "now" | "period_end"; now: Date };

export interface BillingProvider {
  readonly key: "mock" | "stripe";
  readonly label: string;
  readonly development: boolean; // shown on every billing screen when true
  // where to send the person to pay; state changes arrive as events
  checkout(args: CheckoutArgs): Promise<{ url: string }>;
  // returns events to apply right away (mock), or [] when the provider will send them by webhook (Stripe)
  changePlan(args: ChangeArgs): Promise<NormalizedBillingEvent[]>;
  setCancelAtPeriodEnd(sub: SubscriptionRow, cancel: boolean): Promise<NormalizedBillingEvent[]>;
  // a hosted page to manage payment methods and download receipts (Stripe only)
  portalUrl?(sub: SubscriptionRow, returnUrl: string): Promise<string>;
  // keep per-unit charges in step with the unit count (metered prices)
  syncUnits?(sub: SubscriptionRow, units: number): Promise<void>;
  // verify and translate an incoming provider webhook (throws on a bad signature)
  parseWebhook?(rawBody: string, headers: Headers, now?: Date): NormalizedBillingEvent[];
}

export class BillingConfigError extends Error {}
