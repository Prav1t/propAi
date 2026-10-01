import { describe, expect, it } from "vitest";
import { allowedTransitions, canTransition, dueDates, evaluateTriage, isOverdue, ruleMatches, slaFor, type TriageRule } from "./rules";

const rule = (over: Partial<TriageRule>): TriageRule => ({
  id: "r", name: "r", keywords: [], category: null, propertyId: null, setPriority: null, setEmergency: false, setCategory: null,
  assignMembershipId: null, assignVendorId: null, residentInstructions: null, position: 100, active: true, ...over,
});

describe("work order state machine", () => {
  it("lets managers triage, cancel, close and reopen", () => {
    expect(canTransition("new", "assigned", "manager")).toBe(true);
    expect(canTransition("completed", "closed", "manager")).toBe(true);
    expect(canTransition("closed", "in_progress", "manager")).toBe(true);
    expect(canTransition("new", "completed", "manager")).toBe(false);
  });
  it("lets assignees/vendors only progress the work", () => {
    expect(allowedTransitions("assigned", "worker").sort()).toEqual(["awaiting_vendor", "in_progress", "scheduled"]);
    expect(canTransition("in_progress", "completed", "worker")).toBe(true);
    expect(canTransition("assigned", "cancelled", "worker")).toBe(false);
    expect(canTransition("completed", "closed", "worker")).toBe(false);
    expect(allowedTransitions("completed", "worker")).toEqual([]);
  });
  it("lets requesters withdraw only before work starts", () => {
    expect(allowedTransitions("new", "requester")).toEqual(["cancelled"]);
    expect(allowedTransitions("acknowledged", "requester")).toEqual(["cancelled"]);
    expect(allowedTransitions("in_progress", "requester")).toEqual([]);
  });
  it("treats cancelled as terminal", () => {
    expect(allowedTransitions("cancelled", "manager")).toEqual([]);
  });
});

describe("triage rules", () => {
  it("matches whole words and phrases, case- and accent-insensitive", () => {
    const r = rule({ keywords: ["water leak", "flood"] });
    expect(ruleMatches(r, "There is a WATER-LEAK under my sink", "plumbing", "p")).toBe(true);
    expect(ruleMatches(r, "Basement flooding!", "plumbing", "p")).toBe(false); // "flood" ≠ "flooding"
    expect(ruleMatches(r, "Basement flood", "plumbing", "p")).toBe(true);
  });
  it("respects category, property and active flags", () => {
    expect(ruleMatches(rule({ category: "elevator" }), "stuck", "elevator", "p")).toBe(true);
    expect(ruleMatches(rule({ category: "elevator" }), "stuck", "plumbing", "p")).toBe(false);
    expect(ruleMatches(rule({ keywords: ["leak"], propertyId: "other" }), "leak", "plumbing", "p")).toBe(false);
    expect(ruleMatches(rule({ keywords: ["leak"], active: false }), "leak", "plumbing", "p")).toBe(false);
    expect(ruleMatches(rule({}), "anything", "plumbing", "p")).toBe(false); // no criteria never matches
  });
  it("combines matches: highest priority, any emergency, first assignee, all instructions", () => {
    const out = evaluateTriage([
      rule({ id: "a", name: "Leak", keywords: ["leak"], setPriority: "high", assignVendorId: "v1", residentInstructions: "Turn off the valve." }),
      rule({ id: "b", name: "Spreading", keywords: ["spreading"], setEmergency: true, assignVendorId: "v2", residentInstructions: "Call 604-555-0100." }),
    ], "Sink leak, water spreading across the floor", "plumbing", "p");
    expect(out).toMatchObject({ priority: "urgent", isEmergency: true, assignVendorId: "v1", instructions: ["Turn off the valve.", "Call 604-555-0100."] });
    expect(out.matched.map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("evaluates property-specific rules before org-wide ones", () => {
    const out = evaluateTriage([
      rule({ id: "org", keywords: ["elevator"], assignVendorId: "org-vendor", position: 1 }),
      rule({ id: "prop", keywords: ["elevator"], assignVendorId: "prop-vendor", propertyId: "p", position: 50 }),
    ], "elevator stuck", "elevator", "p");
    expect(out.assignVendorId).toBe("prop-vendor");
  });
});

describe("SLA", () => {
  it("prefers property policy, then org policy, then defaults", () => {
    const policies = [
      { propertyId: null, priority: "high", respondMinutes: 120, resolveMinutes: 2000 },
      { propertyId: "p", priority: "high", respondMinutes: 30, resolveMinutes: 600 },
    ];
    expect(slaFor(policies, "p", "high")).toEqual({ respond: 30, resolve: 600 });
    expect(slaFor(policies, "q", "high")).toEqual({ respond: 120, resolve: 2000 });
    expect(slaFor(policies, "q", "low")).toEqual({ respond: 4320, resolve: 20160 });
  });
  it("computes due dates and overdue state", () => {
    const d = dueDates(new Date("2026-01-01T00:00:00Z"), { respond: 60, resolve: 1440 });
    expect(d.resolveDueAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(isOverdue("in_progress", d.resolveDueAt, new Date("2026-01-03T00:00:00Z"))).toBe(true);
    expect(isOverdue("completed", d.resolveDueAt, new Date("2026-01-03T00:00:00Z"))).toBe(false);
  });
});
