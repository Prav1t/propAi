import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withContext } from "../src/server/db/client";
import { apiKeys, organizations, subscriptions, users } from "../src/server/db/schema";
import { applyBillingEvents, billingTick, mockProvider, snapshotUsage } from "../src/server/billing/service";
import { countUsage } from "../src/server/billing/entitlements";
import { hashToken } from "../src/server/auth/crypto";
import { writeAudit } from "../src/server/audit";
import { API_SCOPE_PERMS } from "../src/lib/api-scopes";
import type { BillingInterval, PlanKey } from "../src/config/plans";

// Billing for the demo organizations (Iteration 10), produced by the development billing provider exactly as a person
// checking out would: Pacific Properties subscribed to Professional about three months ago (so it has monthly
// invoices from real renewals), Northshore Strata to Starter last month. Plus a development-only API key.

export const DEMO_API_KEY = "ak_demokey1_DEVELOPMENT-ONLY-demo-api-key-do-not-use-00";

const DAY = 86_400_000;

async function subscribe(slug: string, email: string, planKey: PlanKey, interval: BillingInterval, startedDaysAgo: number) {
  const [org] = await withContext({ platformAdmin: true }, (tx) => tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)));
  const [u] = await withContext({ system: true }, (tx) => tx.select({ id: users.id }).from(users).where(eq(users.email, email)));
  const units = await withContext({ orgId: org.id, system: true }, (tx) => countUsage(tx, org.id, "units"));
  const start = new Date(Date.now() - startedDaysAgo * DAY);
  const mock = mockProvider();
  await applyBillingEvents(mock.completeCheckout({ o: org.id, u: u.id, p: planKey, i: interval, n: units, e: Date.now() + DAY, c: randomUUID() }, null, start), start);
  // each period end the worker renews and invoices; replay those renewals up to today
  for (let i = 0; i < 24; i++) {
    const [s] = await withContext({ orgId: org.id, system: true }, (tx) => tx.select().from(subscriptions).where(eq(subscriptions.orgId, org.id)));
    if (!s.currentPeriodEnd || s.currentPeriodEnd.getTime() > Date.now()) break;
    await billingTick(new Date(s.currentPeriodEnd.getTime() + 60_000));
  }
  return org.id;
}

export async function seedBilling(): Promise<{ subscriptions: number; apiKeys: number }> {
  const pac = await subscribe("pacific-properties", "admin@demo.test", "professional", "month", 75);
  await subscribe("northshore-strata", "admin@northshore.test", "starter", "month", 20);
  await snapshotUsage();

  let keys = 0;
  if (process.env.NODE_ENV !== "production") {
    // a documented key for trying the API against demo data (README); never seeded in production
    const [admin] = await withContext({ system: true }, (tx) => tx.select({ id: users.id }).from(users).where(eq(users.email, "admin@demo.test")));
    await withContext({ orgId: pac, system: true }, async (tx) => {
      const [k] = await tx.insert(apiKeys).values({
        orgId: pac, name: "Demo integration (development only)", prefix: DEMO_API_KEY.split("_")[1], keyHash: hashToken(DEMO_API_KEY),
        createdByUserId: admin.id, permissions: [...API_SCOPE_PERMS], propertyIds: [],
      }).returning();
      await writeAudit(tx, { orgId: pac, actorUserId: admin.id, action: "api_key.created", entityType: "api_key", entityId: k.id, after: { name: k.name, prefix: k.prefix, seeded: true } });
    });
    keys = 1;
  }
  return { subscriptions: 2, apiKeys: keys };
}
