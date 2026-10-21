import "server-only";
import { and, count, eq, gte, isNull, notInArray, sql } from "drizzle-orm";
import { withContext, type Tx } from "../db/client";
import { aiUsage, featureFlags, invitations, memberships, organizations, properties, roles, subscriptions, units } from "../db/schema";
import { ForbiddenError } from "../authz/authorize";
import { FEATURES, LIMITS, PLANS, isPlanKey, type BillingInterval, type Feature, type LimitKey, type Plan } from "@/config/plans";
import { resolveFlags, type FlagKey } from "@/config/flags";
import { accessFor, effectiveLimits, type Access, type LimitOverrides, type SubscriptionStatus, type Usage } from "@/lib/billing";

// The one place that answers "may this organization do X right now?" (Iteration 10):
// the subscription (plan, status, overrides) and the feature flags, checked together.

export type SubscriptionRow = typeof subscriptions.$inferSelect;

export type Entitlements = {
  orgId: string;
  plan: Plan;
  interval: BillingInterval;
  subscription: SubscriptionRow | null;
  access: Access;
  readOnly: boolean;
  limits: Record<LimitKey, number | null>;
  features: Record<Feature, boolean>; // plan includes it AND its rollout flag is on
  flags: Record<FlagKey, boolean>;
};

// which rollout flag (if any) a plan feature also needs
const FEATURE_FLAG: Partial<Record<Feature, FlagKey>> = { api: "public_api", webhooks: "webhooks", integrations: "integrations", advanced_analytics: "advanced_analytics" };

export class ReadOnlyError extends ForbiddenError {
  readonly code = "subscription_inactive";
}

export class FeatureUnavailableError extends ForbiddenError {
  readonly code = "feature_unavailable";
  constructor(readonly feature: Feature, planName: string) {
    super(`${FEATURES[feature].label} isn't included in your ${planName} plan. An administrator can upgrade in Organization → Billing.`);
  }
}

export class LimitReachedError extends ForbiddenError {
  readonly code = "limit_reached";
  constructor(readonly key: LimitKey, readonly limit: number, planName: string) {
    super(`Your ${planName} plan allows ${limit.toLocaleString("en-CA")} ${LIMITS[key].unit}. An administrator can upgrade in Organization → Billing.`);
  }
}

export function entitlementsFrom(orgId: string, sub: SubscriptionRow | null, flagRows: { key: string; orgId: string | null; enabled: boolean }[], now = new Date()): Entitlements {
  const plan = PLANS[sub && isPlanKey(sub.planKey) ? sub.planKey : "starter"];
  const access = accessFor(sub ? { ...sub, status: sub.status as SubscriptionStatus } : null, now);
  const flags = resolveFlags(flagRows, orgId);
  const features = Object.fromEntries((Object.keys(FEATURES) as Feature[]).map((f) => {
    const flag = FEATURE_FLAG[f];
    return [f, plan.features.includes(f) && (!flag || flags[flag])];
  })) as Record<Feature, boolean>;
  return {
    orgId, plan, interval: (sub?.interval as BillingInterval) ?? "month", subscription: sub, access, readOnly: access.readOnly,
    limits: effectiveLimits(plan, (sub?.limitOverrides ?? {}) as LimitOverrides), features, flags,
  };
}

// inside an existing transaction that already has the org (or system) context
export async function loadEntitlements(tx: Tx, orgId: string, now = new Date()): Promise<Entitlements> {
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
  const flagRows = await tx.select({ key: featureFlags.key, orgId: featureFlags.orgId, enabled: featureFlags.enabled }).from(featureFlags)
    .where(sql`${featureFlags.orgId} is null or ${featureFlags.orgId} = ${orgId}`);
  return entitlementsFrom(orgId, sub ?? null, flagRows, now);
}

export function getEntitlements(orgId: string, now = new Date()): Promise<Entitlements> {
  return withContext({ orgId, system: true }, (tx) => loadEntitlements(tx, orgId, now));
}

export function assertNotReadOnly(e: Entitlements): void {
  if (e.readOnly) throw new ReadOnlyError(e.access.reason ?? "This organization is in read-only mode.");
}

// every change made through the app, the API, the assistant or an automation goes through one of these
export async function assertWritable(orgId: string): Promise<Entitlements> {
  const e = await getEntitlements(orgId);
  assertNotReadOnly(e);
  return e;
}

export function assertFeatureOf(e: Entitlements, feature: Feature): void {
  if (e.features[feature]) return;
  const err = new FeatureUnavailableError(feature, e.plan.name);
  // the plan includes it but the rollout flag is off: don't tell them to upgrade
  if (e.plan.features.includes(feature)) err.message = `${FEATURES[feature].label} isn't available for your organization right now.`;
  throw err;
}

export async function assertFeature(orgId: string, feature: Feature): Promise<Entitlements> {
  const e = await getEntitlements(orgId);
  assertFeatureOf(e, feature);
  return e;
}

/* ───────────── usage ───────────── */

export async function countUsage(tx: Tx, orgId: string, key: LimitKey, tz?: string): Promise<number> {
  switch (key) {
    case "properties":
      return (await tx.select({ n: count() }).from(properties).where(eq(properties.orgId, orgId)))[0].n;
    case "units":
      return (await tx.select({ n: count() }).from(units).where(eq(units.orgId, orgId)))[0].n;
    case "staff_seats": {
      // active staff members plus staff invitations still waiting to be accepted; residents and vendors are free
      const [m] = await tx.select({ n: count() }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
        .where(and(eq(memberships.orgId, orgId), eq(memberships.status, "active"), eq(roles.category, "staff")));
      const [i] = await tx.select({ n: count() }).from(invitations).innerJoin(roles, eq(roles.id, invitations.roleId))
        .where(and(eq(invitations.orgId, orgId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gte(invitations.expiresAt, new Date()), eq(roles.category, "staff"),
          sql`not exists (select 1 from memberships m join users u on u.id = m.user_id where m.org_id = ${orgId} and u.email = ${invitations.email})`));
      return m.n + i.n;
    }
    case "ai_requests": {
      let zone = tz;
      if (!zone) zone = (await tx.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)))[0]?.tz ?? "UTC";
      const [r] = await tx.select({ n: count() }).from(aiUsage).where(and(eq(aiUsage.orgId, orgId),
        gte(aiUsage.createdAt, sql`(date_trunc('month', now() at time zone ${zone}) at time zone ${zone})`), notInArray(aiUsage.outcome, ["cap_reached", "disabled"])));
      return r.n;
    }
  }
}

export async function currentUsage(tx: Tx, orgId: string): Promise<Usage> {
  // sequential: one transaction runs one query at a time
  const out = {} as Usage;
  for (const k of Object.keys(LIMITS) as LimitKey[]) out[k] = await countUsage(tx, orgId, k);
  return out;
}

// throws when adding `adding` more would exceed the plan's limit (checked in the same transaction as the insert)
export async function assertWithinLimit(tx: Tx, orgId: string, key: LimitKey, adding = 1): Promise<void> {
  const e = await loadEntitlements(tx, orgId);
  assertNotReadOnly(e);
  const limit = e.limits[key];
  if (limit === null) return;
  const used = await countUsage(tx, orgId, key);
  if (used + adding > limit) throw new LimitReachedError(key, limit, e.plan.name);
}
