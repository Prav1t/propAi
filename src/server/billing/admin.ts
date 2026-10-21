import "server-only";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { db, withContext } from "../db/client";
import { aiUsage, billingEvents, featureFlags, organizations, subscriptions, units, usageRecords, users, webhookAttempts } from "../db/schema";
import { ForbiddenError, NotFoundError } from "../authz/authorize";
import { writeAudit } from "../audit";
import { isFlagKey, resolveFlags, type FlagKey } from "@/config/flags";
import { PLANS, isPlanKey, type BillingInterval } from "@/config/plans";
import { monthlyEquivalentCents } from "@/lib/billing";
import { adminListOrganizations } from "../modules/organizations/service";
import { adminSetSubscription } from "./service";

// Platform console (Iteration 10): plans and subscriptions across organizations, platform metrics, feature flags.
// Every function here re-checks that the caller is a platform administrator.

async function requirePlatformAdmin(userId: string) {
  const u = await db().query.users.findFirst({ where: eq(users.id, userId), columns: { isPlatformAdmin: true, status: true } });
  if (!u?.isPlatformAdmin || u.status !== "active") throw new ForbiddenError();
}

export async function adminPlatformOverview(actorUserId: string, now = new Date()) {
  await requirePlatformAdmin(actorUserId);
  const orgs = await adminListOrganizations();
  return withContext({ platformAdmin: true }, async (tx) => {
    const subs = await tx.select().from(subscriptions);
    const since30 = new Date(now.getTime() - 30 * 86_400_000);
    const [ai] = await tx.select({ n: count() }).from(aiUsage).where(gte(aiUsage.createdAt, since30));
    const [api] = await tx.select({ n: sql<number>`coalesce(sum(${usageRecords.quantity}), 0)::int` }).from(usageRecords).where(and(eq(usageRecords.metric, "api_requests"), gte(usageRecords.day, sql`current_date - 30`)));
    const [hookFails] = await tx.select({ n: count() }).from(webhookAttempts).where(and(gte(webhookAttempts.createdAt, new Date(now.getTime() - 86_400_000)), sql`coalesce(${webhookAttempts.statusCode}, 0) not between 200 and 299`));
    const [failedEvents] = await tx.select({ n: count() }).from(billingEvents).where(eq(billingEvents.status, "failed"));
    const rows = orgs.map((o) => {
      const s = subs.find((x) => x.orgId === o.id) ?? null;
      const paying = !!s && s.status === "active" && (s.provider === "mock" || s.provider === "stripe" || s.provider === "manual");
      return {
        ...o, subscription: s,
        mrrCents: paying && isPlanKey(s!.planKey) ? monthlyEquivalentCents(PLANS[s!.planKey], s!.interval as BillingInterval, o.unitCount) : 0,
      };
    });
    const by = (st: string) => rows.filter((r) => r.subscription?.status === st).length;
    return {
      rows,
      metrics: {
        orgs: rows.length, active: by("active"), trialing: by("trialing"), pastDue: by("past_due"), lapsed: by("expired") + by("cancelled"),
        trialsEndingSoon: rows.filter((r) => r.subscription?.status === "trialing" && r.subscription.trialEndsAt && r.subscription.trialEndsAt.getTime() - now.getTime() < 7 * 86_400_000).length,
        mrrCents: rows.reduce((a, r) => a + r.mrrCents, 0), aiRequests30d: ai.n, apiRequests30d: api.n, webhookFailures24h: hookFails.n, failedBillingEvents: failedEvents.n,
        units: rows.reduce((a, r) => a + r.unitCount, 0),
      },
    };
  });
}

export async function adminOrgDetail(actorUserId: string, orgId: string) {
  await requirePlatformAdmin(actorUserId);
  return withContext({ platformAdmin: true }, async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw new NotFoundError();
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId));
    const flags = await tx.select().from(featureFlags).where(sql`${featureFlags.orgId} is null or ${featureFlags.orgId} = ${orgId}`);
    const events = await tx.select().from(billingEvents).where(eq(billingEvents.orgId, orgId)).orderBy(desc(billingEvents.createdAt)).limit(20);
    const [u] = await tx.select({ n: count() }).from(units).where(eq(units.orgId, orgId));
    return {
      org, subscription: sub ?? null, events, unitCount: u.n,
      flagOverrides: Object.fromEntries(flags.filter((f) => f.orgId === orgId).map((f) => [f.key, f.enabled])) as Partial<Record<FlagKey, boolean>>,
      effectiveFlags: resolveFlags(flags, orgId),
    };
  });
}

export async function adminFlags(actorUserId: string) {
  await requirePlatformAdmin(actorUserId);
  const rows = await withContext({ platformAdmin: true }, (tx) => tx.select().from(featureFlags));
  return {
    global: Object.fromEntries(rows.filter((r) => r.orgId === null).map((r) => [r.key, r.enabled])) as Partial<Record<FlagKey, boolean>>,
    orgOverrides: rows.filter((r) => r.orgId !== null).length,
    effective: resolveFlags(rows.filter((r) => r.orgId === null), null),
  };
}

// value null removes the override (back to the next level down)
export async function adminSetFlag(actorUserId: string, key: string, orgId: string | null, value: boolean | null) {
  await requirePlatformAdmin(actorUserId);
  if (!isFlagKey(key)) throw new NotFoundError();
  await withContext({ platformAdmin: true, orgId, userId: actorUserId }, async (tx) => {
    const where = and(eq(featureFlags.key, key), orgId ? eq(featureFlags.orgId, orgId) : sql`${featureFlags.orgId} is null`);
    const [before] = await tx.select().from(featureFlags).where(where);
    if (value === null) await tx.delete(featureFlags).where(where);
    else if (before) await tx.update(featureFlags).set({ enabled: value, updatedByUserId: actorUserId }).where(eq(featureFlags.id, before.id));
    else await tx.insert(featureFlags).values({ key, orgId, enabled: value, updatedByUserId: actorUserId });
    await writeAudit(tx, { orgId, actorUserId, action: "feature_flag.set", entityType: "feature_flag", entityId: key, before: before ? { enabled: before.enabled } : null, after: value === null ? null : { enabled: value } });
  });
}

export async function adminUpdateSubscription(actorUserId: string, orgId: string, input: Parameters<typeof adminSetSubscription>[2]) {
  await requirePlatformAdmin(actorUserId);
  return adminSetSubscription(actorUserId, orgId, input);
}
