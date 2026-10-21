// Subscription plans as configuration (Iteration 10). Pages and services never hard-code prices, limits or features:
// they read this file through src/lib/billing.ts (maths) and src/server/billing/entitlements.ts (enforcement).
// To change pricing, edit this file (and the matching Stripe price ids in the environment). Per-organization deals
// are set by a platform administrator as limit overrides on the subscription, not by editing a plan.

export const PLAN_KEYS = ["starter", "professional", "enterprise"] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

// features a plan can include; each is checked in one place (entitlements) together with its feature flag
export const FEATURES = {
  ai_assistant: { label: "AI assistant", description: "Questions, actions with approvals and cited answers from your documents." },
  automation: { label: "Automation rules", description: "When-this-then-that rules, schedules, approvals and reports." },
  advanced_analytics: { label: "Property health & insights", description: "Explainable health scores and proactive insights." },
  api: { label: "REST API", description: "Versioned API with scoped keys." },
  webhooks: { label: "Webhooks", description: "Signed event delivery to your systems, with retries." },
  integrations: { label: "Integrations", description: "Slack, Microsoft Teams and Twilio SMS." },
} as const;
export type Feature = keyof typeof FEATURES;

// limits are per organization; null = unlimited. ai_requests is per calendar month.
export const LIMITS = {
  properties: { label: "Properties", unit: "properties" },
  units: { label: "Units", unit: "units" },
  staff_seats: { label: "Staff seats", unit: "seats" },
  ai_requests: { label: "Assistant requests / month", unit: "requests" },
} as const;
export type LimitKey = keyof typeof LIMITS;

export type Plan = {
  key: PlanKey;
  name: string;
  tagline: string;
  rank: number; // higher = more capable; decides upgrade vs downgrade
  currency: "CAD";
  // price = base + (units above includedUnits) × perUnit, per interval; yearly = 10 × monthly (two months free)
  baseMonthlyCents: number;
  includedUnits: number;
  perUnitMonthlyCents: number;
  limits: Record<LimitKey, number | null>;
  features: Feature[];
  trialDays: number;
};

export const YEARLY_MONTHS_CHARGED = 10;
export const TRIAL_PLAN: PlanKey = "professional";
export const PAST_DUE_GRACE_DAYS = 7;
export const TRIAL_NOTICE_DAYS = 3;

export const PLANS: Record<PlanKey, Plan> = {
  starter: {
    key: "starter", name: "Starter", tagline: "Small buildings and self-managed strata corporations.", rank: 1, currency: "CAD",
    baseMonthlyCents: 7_900, includedUnits: 50, perUnitMonthlyCents: 100,
    limits: { properties: 3, units: 300, staff_seats: 10, ai_requests: 500 },
    features: ["ai_assistant"],
    trialDays: 14,
  },
  professional: {
    key: "professional", name: "Professional", tagline: "Growing property-management companies.", rank: 2, currency: "CAD",
    baseMonthlyCents: 29_900, includedUnits: 250, perUnitMonthlyCents: 80,
    limits: { properties: 50, units: 5_000, staff_seats: 100, ai_requests: 10_000 },
    features: ["ai_assistant", "automation", "advanced_analytics", "api", "webhooks", "integrations"],
    trialDays: 14,
  },
  enterprise: {
    key: "enterprise", name: "Enterprise", tagline: "Large portfolios with custom limits.", rank: 3, currency: "CAD",
    baseMonthlyCents: 120_000, includedUnits: 2_000, perUnitMonthlyCents: 50,
    limits: { properties: null, units: null, staff_seats: null, ai_requests: 100_000 },
    features: ["ai_assistant", "automation", "advanced_analytics", "api", "webhooks", "integrations"],
    trialDays: 14,
  },
};

export const isPlanKey = (v: unknown): v is PlanKey => typeof v === "string" && (PLAN_KEYS as readonly string[]).includes(v);

// Stripe price ids come from the environment: STRIPE_PRICE_<PLAN>_<INTERVAL>, e.g. STRIPE_PRICE_PROFESSIONAL_MONTH
export const stripePriceEnvName = (plan: PlanKey, interval: BillingInterval) => `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`;
