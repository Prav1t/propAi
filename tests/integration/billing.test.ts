import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganization } from "@/server/modules/organizations/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { createProperty, generateUnits, propertySchema } from "@/server/modules/portfolio/service";
import { inviteMember } from "@/server/modules/members/service";
import { saveRule } from "@/server/automation/service";
import {
  applyBillingEvents, billingTick, changePlan, completeMockCheckout, getBillingOverview, setCancelAtPeriodEnd, snapshotUsage, startTrial,
} from "@/server/billing/service";
import { assertWritable, FeatureUnavailableError, getEntitlements, LimitReachedError, ReadOnlyError } from "@/server/billing/entitlements";
import { adminSetFlag, adminUpdateSubscription } from "@/server/billing/admin";
import { ForbiddenError } from "@/server/authz/authorize";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import { ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.70", userAgent: "vitest", requestId: "billing" };
const DAY = 86_400_000;
const q = async (sql: string, params: unknown[] = []) => (await ownerPool.query(sql, params)).rows;
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function newOrg(): Promise<{ ctx: TenantCtx; orgId: string; userId: string }> {
  const email = `billing-${uniq()}@test.example`;
  const [u] = await q("insert into users (email, name, email_verified_at) values ($1, 'Billing Tester', now()) returning id", [email]);
  const org = await createOrganization(u.id, { name: `Billing Co ${uniq()}`, kind: "property_management", timezone: "America/Vancouver" }, meta);
  const p = await loadPrincipal(u.id, org.slug);
  return { ctx: { principal: p!, meta }, orgId: org.id, userId: u.id };
}
const sub = async (orgId: string) => (await q("select * from subscriptions where org_id = $1", [orgId]))[0];
const prop = (n: number) => propertySchema.parse({ name: `Property ${n} ${uniq()}`, code: `P${n}${uniq().slice(-4)}`.toUpperCase().slice(0, 10), type: "residential", city: "Vancouver" });

// starts a mock checkout and confirms it, as the billing page does
async function checkout(ctx: TenantCtx, planKey: "starter" | "professional" | "enterprise", interval: "month" | "year" = "month") {
  const r = await changePlan(ctx, { planKey, interval });
  expect(r.redirectTo).toMatch(/\/settings\/billing\/checkout\?token=/);
  const token = decodeURIComponent(r.redirectTo!.split("token=")[1]);
  await completeMockCheckout(ctx, token);
  return token;
}

let adminId: string; // the seeded platform administrator
beforeAll(async () => {
  adminId = (await q("select id from users where is_platform_admin limit 1"))[0].id;
});
afterAll(async () => {
  await q("delete from feature_flags");
  await closeDb();
  await ownerPool.end();
});

describe("trials", () => {
  it("a new organization starts a 14-day Professional trial with everything included", async () => {
    const { orgId } = await newOrg();
    const s = await sub(orgId);
    expect(s).toMatchObject({ plan_key: "professional", status: "trialing", provider: "none" });
    expect(Math.round((new Date(s.trial_ends_at).getTime() - Date.now()) / DAY)).toBe(14);
    const e = await getEntitlements(orgId);
    expect(e.readOnly).toBe(false);
    expect(e.features).toMatchObject({ automation: true, api: true, webhooks: true, integrations: true, advanced_analytics: true });
    expect((await q("select plan_key from organizations where id = $1", [orgId]))[0].plan_key).toBe("professional");
  });
  it("warns once before the trial ends, then makes the organization read-only (data kept)", async () => {
    const { orgId } = await newOrg();
    await q("update subscriptions set trial_ends_at = now() + interval '2 days' where org_id = $1", [orgId]);
    await billingTick();
    await billingTick();
    expect((await q("select count(*)::int n from outbox_events where org_id = $1 and type = 'billing.trial_ending'", [orgId]))[0].n).toBe(1);
    await q("update subscriptions set trial_ends_at = now() - interval '1 minute' where org_id = $1", [orgId]);
    await billingTick();
    expect((await sub(orgId)).status).toBe("expired");
    expect((await q("select count(*)::int n from outbox_events where org_id = $1 and type = 'billing.trial_ended'", [orgId]))[0].n).toBe(1);
    await expect(assertWritable(orgId)).rejects.toBeInstanceOf(ReadOnlyError);
    expect((await q("select count(*)::int n from organizations where id = $1", [orgId]))[0].n).toBe(1);
  });
  it("startTrial never replaces an existing subscription", async () => {
    const { orgId } = await newOrg();
    await q("update subscriptions set plan_key = 'enterprise' where org_id = $1", [orgId]);
    const { withContext } = await import("@/server/db/client");
    await withContext({ orgId, system: true }, (tx) => startTrial(tx, orgId));
    expect((await sub(orgId)).plan_key).toBe("enterprise");
  });
});

describe("checkout and plan changes (development provider)", () => {
  it("checkout makes the subscription active, records a paid invoice and is applied once", async () => {
    const { ctx, orgId } = await newOrg();
    const token = await checkout(ctx, "starter");
    expect(await sub(orgId)).toMatchObject({ plan_key: "starter", status: "active", provider: "mock", cancel_at_period_end: false });
    const inv = await q("select * from invoices where org_id = $1", [orgId]);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ status: "paid", total_cents: 7_900 });
    await completeMockCheckout(ctx, token); // pressing "Pay" again
    expect(await q("select id from invoices where org_id = $1", [orgId])).toHaveLength(1);
    expect((await q("select count(*)::int n from billing_events where org_id = $1", [orgId]))[0].n).toBe(2);
    expect((await q("select count(*)::int n from audit_logs where org_id = $1 and action = 'billing.subscription_started'", [orgId]))[0].n).toBe(1);
  });
  it("refuses another organization's or an altered checkout token", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const r = await changePlan(a.ctx, { planKey: "starter", interval: "month" });
    const token = decodeURIComponent(r.redirectTo!.split("token=")[1]);
    await expect(completeMockCheckout(b.ctx, token)).rejects.toBeInstanceOf(ValidationError);
    await expect(completeMockCheckout(a.ctx, token.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).rejects.toBeInstanceOf(ValidationError);
    expect((await sub(a.orgId)).status).toBe("trialing");
  });
  it("upgrades right away with a credit for the unused period", async () => {
    const { ctx, orgId } = await newOrg();
    await checkout(ctx, "starter");
    await q("update subscriptions set current_period_start = now() - interval '15 days', current_period_end = now() + interval '15 days' where org_id = $1", [orgId]);
    const r = await changePlan(ctx, { planKey: "professional", interval: "month" });
    expect(r.redirectTo).toBeUndefined();
    expect((await sub(orgId)).plan_key).toBe("professional");
    const [last] = await q("select * from invoices where org_id = $1 order by issued_at desc, created_at desc limit 1", [orgId]);
    const credit = (last.lines as { amountCents: number }[]).find((l) => l.amountCents < 0)!;
    expect(credit.amountCents).toBeGreaterThan(-4_000);
    expect(credit.amountCents).toBeLessThan(-3_900); // about half of $79
    expect((await getEntitlements(orgId)).features.automation).toBe(true);
  });
  it("schedules a downgrade for the period end, applies it on renewal, and refuses one that doesn't fit", async () => {
    const { ctx, orgId } = await newOrg();
    await checkout(ctx, "professional");
    const r = await changePlan(ctx, { planKey: "starter", interval: "month" });
    expect(r.message).toMatch(/starts on/);
    expect(await sub(orgId)).toMatchObject({ plan_key: "professional", pending_plan_key: "starter" });
    const end = new Date((await sub(orgId)).current_period_end);
    await billingTick(new Date(end.getTime() + 60_000));
    expect(await sub(orgId)).toMatchObject({ plan_key: "starter", pending_plan_key: null, status: "active" });
    expect(await q("select id from invoices where org_id = $1", [orgId])).toHaveLength(2);
    await billingTick(new Date(end.getTime() + 120_000)); // the worker running again changes nothing
    expect(await q("select id from invoices where org_id = $1", [orgId])).toHaveLength(2);

    const big = await newOrg();
    await checkout(big.ctx, "professional");
    for (let i = 0; i < 4; i++) await createProperty(big.ctx, prop(i));
    await expect(changePlan(big.ctx, { planKey: "starter", interval: "month" })).rejects.toThrow(/too small.*4 properties in use; the plan allows 3/);
  });
  it("cancellation keeps access until the period ends, then read-only until a plan is chosen again", async () => {
    const { ctx, orgId } = await newOrg();
    await checkout(ctx, "starter");
    await setCancelAtPeriodEnd(ctx, true);
    expect((await sub(orgId)).cancel_at_period_end).toBe(true);
    expect((await getEntitlements(orgId)).readOnly).toBe(false);
    await setCancelAtPeriodEnd(ctx, false); // changed their mind
    await setCancelAtPeriodEnd(ctx, true);
    const end = new Date((await sub(orgId)).current_period_end);
    await billingTick(new Date(end.getTime() + 60_000));
    expect((await sub(orgId)).status).toBe("cancelled");
    await expect(assertWritable(orgId)).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(createProperty(ctx, prop(9))).rejects.toBeInstanceOf(ReadOnlyError);
    // the billing page still works, and checking out again restores everything
    expect((await getBillingOverview(ctx)).ent.readOnly).toBe(true);
    await checkout(ctx, "starter");
    await expect(assertWritable(orgId)).resolves.toBeTruthy();
  });
  it("only billing managers can see or change billing", async () => {
    const pm = await loadPrincipal(await userIdByEmail("pm@demo.test"), "pacific-properties");
    const ctx: TenantCtx = { principal: pm!, meta };
    await expect(getBillingOverview(ctx)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(changePlan(ctx, { planKey: "enterprise", interval: "year" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("plan limits and features", () => {
  it("enforces property, unit and staff-seat limits", async () => {
    const { ctx, orgId } = await newOrg();
    await checkout(ctx, "starter");
    const props = [];
    for (let i = 0; i < 3; i++) props.push(await createProperty(ctx, prop(i)));
    await expect(createProperty(ctx, prop(3))).rejects.toBeInstanceOf(LimitReachedError);
    const { createBuilding, buildingSchema } = await import("@/server/modules/portfolio/service");
    const b = await createBuilding(ctx, props[0].id, buildingSchema.parse({ name: "Tower", code: "T" }));
    await expect(generateUnits(ctx, b.id, { fromLevel: 1, toLevel: 31, perFloor: 10, type: "residential" })).rejects.toThrow(/allows 300 units/);
    await generateUnits(ctx, b.id, { fromLevel: 1, toLevel: 2, perFloor: 10, type: "residential" });
    expect((await q("select count(*)::int n from units where org_id = $1", [orgId]))[0].n).toBe(20);

    await adminUpdateSubscription(adminId, orgId, { planKey: "starter", limitOverrides: { staff_seats: 1 } }); // a custom deal
    const [staffRole] = await q("select id from roles where org_id is null and key = 'building_manager'");
    await expect(inviteMember(ctx, { email: `seat-${uniq()}@test.example`, roleId: staffRole.id, propertyId: props[0].id })).rejects.toThrow(/allows 1 seats/);
    await adminUpdateSubscription(adminId, orgId, { planKey: "starter", limitOverrides: {} });
    await inviteMember(ctx, { email: `seat-${uniq()}@test.example`, roleId: staffRole.id, propertyId: props[0].id });
  });
  it("keeps automation out of plans that don't include it", async () => {
    const { ctx } = await newOrg();
    await checkout(ctx, "starter");
    await expect(saveRule(ctx, null, { name: "x", description: "", propertyId: null, trigger: "complaint.created", schedule: null, conditions: [],
      actions: [{ type: "notify", to: { roles: ["org_admin"], members: [], onCall: false, submitter: false, assignee: false }, title: "t", message: "" }] }, true)).rejects.toBeInstanceOf(FeatureUnavailableError);
  });
  it("feature flags switch a plan feature off globally or for one organization", async () => {
    const { orgId } = await newOrg();
    await adminSetFlag(adminId, "public_api", null, false);
    expect((await getEntitlements(orgId)).features.api).toBe(false);
    await adminSetFlag(adminId, "public_api", orgId, true);
    expect((await getEntitlements(orgId)).features.api).toBe(true);
    await adminSetFlag(adminId, "public_api", orgId, null);
    await adminSetFlag(adminId, "public_api", null, null);
    expect((await getEntitlements(orgId)).features.api).toBe(true);
    await expect(adminSetFlag(await userIdByEmail("pm@demo.test"), "public_api", null, false)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("provider events", () => {
  it("are applied once each; failed payments give a grace period, then read-only", async () => {
    const { ctx, orgId } = await newOrg();
    await checkout(ctx, "professional");
    const s = await sub(orgId);
    const failed = { kind: "invoice.updated" as const, provider: "mock" as const, eventId: `evt_${uniq()}`, rawType: "invoice.payment_failed", subscriptionId: s.provider_subscription_id,
      invoiceId: `in_${uniq()}`, number: "F-1", status: "open" as const, totalCents: 29_900, currency: "CAD", lines: [], paymentFailed: true };
    expect(await applyBillingEvents([failed])).toMatchObject({ applied: 1 });
    expect(await applyBillingEvents([failed])).toMatchObject({ duplicates: 1 });
    expect((await sub(orgId)).status).toBe("past_due");
    const e = await getEntitlements(orgId);
    expect(e.access.state).toBe("grace");
    expect((await q("select count(*)::int n from outbox_events where org_id = $1 and type = 'billing.payment_failed'", [orgId]))[0].n).toBe(1);
    await q("update subscriptions set past_due_since = now() - interval '8 days' where org_id = $1", [orgId]);
    expect((await getEntitlements(orgId)).readOnly).toBe(true);
    await applyBillingEvents([{ ...failed, eventId: `evt_${uniq()}`, status: "paid", paymentFailed: false }]);
    expect(await sub(orgId)).toMatchObject({ status: "active", past_due_since: null });
  });
  it("ignores events for unknown subscriptions and never touches another organization", async () => {
    const r = await applyBillingEvents([{ kind: "subscription.deleted", provider: "stripe", eventId: `evt_${uniq()}`, rawType: "customer.subscription.deleted", subscriptionId: "sub_unknown" }]);
    expect(r).toMatchObject({ ignored: 1 });
    const pac = (await q("select s.status from subscriptions s join organizations o on o.id = s.org_id where o.slug = 'pacific-properties'"))[0];
    expect(pac.status).toBe("active");
  });
});

describe("usage metering", () => {
  it("records today's levels for every organization", async () => {
    await snapshotUsage();
    const rows = await q(`select metric, quantity from usage_records u join organizations o on o.id = u.org_id where o.slug = 'pacific-properties' and day = current_date`);
    const m = Object.fromEntries(rows.map((r) => [r.metric, r.quantity]));
    const units = (await q("select count(*)::int n from units u join organizations o on o.id = u.org_id where o.slug = 'pacific-properties'"))[0].n;
    expect(m.units).toBe(units);
    expect(m.properties).toBe(4);
    expect(m.active_residents).toBeGreaterThan(0);
  });
});
