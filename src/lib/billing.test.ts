import { describe, expect, it } from "vitest";
import { PLANS } from "@/config/plans";
import { accessFor, addInterval, changeKind, effectiveLimits, formatMoney, limitViolations, monthlyEquivalentCents, prorationCreditCents, quote } from "./billing";

const DAY = 86_400_000;

describe("prices", () => {
  it("charges the base price up to the included units, then per extra unit", () => {
    const p = PLANS.professional;
    expect(quote(p, "month", 100)).toMatchObject({ totalCents: 29_900, lines: [{ amountCents: 29_900 }] });
    const q = quote(p, "month", 339); // the demo organization
    expect(q.lines[1]).toMatchObject({ quantity: 89, unitCents: 80, amountCents: 7_120 });
    expect(q.totalCents).toBe(37_020);
    expect(formatMoney(q.totalCents)).toBe("$370.20");
  });
  it("bills a year as ten months, and compares plans per month", () => {
    const p = PLANS.starter;
    expect(quote(p, "year", 50).totalCents).toBe(79_000);
    expect(monthlyEquivalentCents(p, "year", 50)).toBe(Math.round(79_000 / 12));
    expect(quote(p, "year", 60).lines[1]).toMatchObject({ quantity: 10, unitCents: 1_000 });
  });
});

describe("periods and proration", () => {
  it("adds a month without spilling into the next one", () => {
    expect(addInterval(new Date("2026-01-31T10:00:00Z"), "month").toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addInterval(new Date("2028-01-31T10:00:00Z"), "month").toISOString()).toBe("2028-02-29T10:00:00.000Z");
    expect(addInterval(new Date("2026-10-15T08:30:00Z"), "month").toISOString()).toBe("2026-11-15T08:30:00.000Z");
    expect(addInterval(new Date("2028-02-29T00:00:00Z"), "year").toISOString()).toBe("2029-02-28T00:00:00.000Z");
  });
  it("credits the unused share of what was paid", () => {
    const start = new Date("2026-10-01T00:00:00Z");
    const end = new Date("2026-10-31T00:00:00Z");
    expect(prorationCreditCents(30_000, start, end, new Date("2026-10-16T00:00:00Z"))).toBe(15_000);
    expect(prorationCreditCents(30_000, start, end, new Date("2026-11-05T00:00:00Z"))).toBe(0); // period over
    expect(prorationCreditCents(30_000, start, end, new Date("2026-09-01T00:00:00Z"))).toBe(30_000); // never more than paid
    expect(prorationCreditCents(0, start, end, start)).toBe(0);
  });
});

describe("limits", () => {
  it("applies per-organization overrides on top of the plan", () => {
    expect(effectiveLimits(PLANS.starter, {}).units).toBe(300);
    expect(effectiveLimits(PLANS.starter, { units: 1_000, staff_seats: null })).toMatchObject({ units: 1_000, staff_seats: null, properties: 3 });
  });
  it("lists what wouldn't fit after a downgrade", () => {
    const usage = { properties: 4, units: 339, staff_seats: 12, ai_requests: 9_999 };
    expect(limitViolations(effectiveLimits(PLANS.starter), usage).map((v) => v.key)).toEqual(["properties", "units", "staff_seats"]);
    expect(limitViolations(effectiveLimits(PLANS.professional), usage)).toEqual([]);
    expect(limitViolations(effectiveLimits(PLANS.enterprise), { ...usage, units: 1_000_000 })).toEqual([]); // unlimited
  });
  it("classifies plan changes", () => {
    expect(changeKind({ plan: "starter", interval: "month" }, { plan: "professional", interval: "month" })).toBe("upgrade");
    expect(changeKind({ plan: "enterprise", interval: "year" }, { plan: "professional", interval: "year" })).toBe("downgrade");
    expect(changeKind({ plan: "professional", interval: "month" }, { plan: "professional", interval: "year" })).toBe("upgrade");
    expect(changeKind({ plan: "professional", interval: "year" }, { plan: "professional", interval: "month" })).toBe("downgrade");
    expect(changeKind({ plan: "starter", interval: "month" }, { plan: "starter", interval: "month" })).toBe("same");
  });
});

describe("subscription state → access", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const base = { trialEndsAt: null, currentPeriodEnd: null, pastDueSince: null, cancelAtPeriodEnd: false };
  it("keeps a running trial writable and counts the days", () => {
    const a = accessFor({ ...base, status: "trialing", trialEndsAt: new Date(now.getTime() + 2.5 * DAY) }, now);
    expect(a).toMatchObject({ state: "trial", readOnly: false, daysLeft: 3 });
  });
  it("makes an ended trial, a cancelled subscription and a missing one read-only (never deleted)", () => {
    expect(accessFor({ ...base, status: "trialing", trialEndsAt: new Date(now.getTime() - DAY) }, now).readOnly).toBe(true);
    expect(accessFor({ ...base, status: "expired" }, now).readOnly).toBe(true);
    const c = accessFor({ ...base, status: "cancelled" }, now);
    expect(c.readOnly).toBe(true);
    expect(c.reason).toMatch(/nothing has been deleted/);
    expect(accessFor(null, now).readOnly).toBe(true);
  });
  it("gives a failed payment a grace period, then read-only", () => {
    expect(accessFor({ ...base, status: "past_due", pastDueSince: new Date(now.getTime() - 3 * DAY) }, now)).toMatchObject({ state: "grace", readOnly: false, daysLeft: 4 });
    expect(accessFor({ ...base, status: "past_due", pastDueSince: new Date(now.getTime() - 8 * DAY) }, now)).toMatchObject({ state: "read_only", readOnly: true });
  });
  it("tells an active subscription when it is set to end", () => {
    expect(accessFor({ ...base, status: "active" }, now)).toMatchObject({ state: "active", readOnly: false, reason: null });
    expect(accessFor({ ...base, status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: new Date("2026-11-01T00:00:00Z") }, now).reason).toMatch(/ends on/);
  });
});
