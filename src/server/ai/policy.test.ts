import { describe, expect, it } from "vitest";
import { confirmFor, decide, POLICY_ACTIONS, POLICY_KEYS, validateMode, type PolicyRule } from "./policy";
import { toolsForPrincipal } from "./tools";
import { isAction } from "./tools/registry";
import { MODES } from "./modes";
import { ACTION_TOOL_NAMES } from "./tools/names";
import type { Principal } from "../authz/authorize";
import { SYSTEM_ROLES } from "../authz/system-roles";

const principal = (roleKey: string): Principal => {
  const r = SYSTEM_ROLES.find((x) => x.key === roleKey)!;
  return {
    userId: "u1", orgId: "o1", orgSlug: "acme", membershipId: "m1",
    role: { id: "r", key: r.key, name: r.name, scopeLevel: r.scopeLevel, category: r.category }, permissions: new Set(r.permissions),
    portfolioIds: new Set(), propertyIds: new Set(["p1"]), buildingIds: new Set(), partialPropertyIds: new Set(),
    unitIds: new Set(), occupantBuildingIds: new Set(), occupantPropertyIds: new Set(), residentId: null, vendorId: null,
  };
};

describe("AI policy engine", () => {
  const rules: PolicyRule[] = [
    { action: "task.create", propertyId: null, mode: "auto" },
    { action: "task.create", propertyId: "p2", mode: "deny" },
    { action: "workorder.assign", propertyId: null, mode: "deny" },
    { action: "booking.manage", propertyId: "p1", mode: "auto" },
  ];
  it("asks first by default", () => {
    expect(decide({ riskClass: 2, keys: ["workorder.create"], propertyId: "p1", rules: [] })).toMatchObject({ mode: "confirm", confirm: "click" });
  });
  it("uses the organization rule, and a property rule over it", () => {
    expect(decide({ riskClass: 2, keys: ["task.create"], propertyId: "p1", rules }).mode).toBe("auto");
    expect(decide({ riskClass: 2, keys: ["task.create"], propertyId: "p2", rules }).mode).toBe("deny");
    expect(decide({ riskClass: 2, keys: ["task.create"], propertyId: null, rules }).mode).toBe("auto");
    expect(decide({ riskClass: 2, keys: ["booking.manage"], propertyId: "p1", rules }).mode).toBe("auto");
    expect(decide({ riskClass: 2, keys: ["booking.manage"], propertyId: "p9", rules }).mode).toBe("confirm");
  });
  it("the strictest of several actions wins (create + assign → assign is denied)", () => {
    const d = decide({ riskClass: 2, keys: ["workorder.create", "workorder.assign"], propertyId: "p1", rules });
    expect(d.mode).toBe("deny");
    expect(d.reason).toMatch(/Assign work orders: not allowed for the assistant \(organization rule\)/);
  });
  it("no rule can let a class 3+ action run on its own", () => {
    const loose: PolicyRule[] = [{ action: "communication.send", propertyId: null, mode: "auto" }, { action: "workorder.update", propertyId: null, mode: "auto" }];
    expect(decide({ riskClass: 3, keys: ["communication.send"], propertyId: null, rules: loose }).mode).toBe("confirm");
    const cancel = decide({ riskClass: 4, keys: ["workorder.update"], propertyId: null, rules: loose });
    expect(cancel).toMatchObject({ mode: "confirm", confirm: "acknowledge" });
    expect(validateMode("communication.send", "auto")).toMatch(/always needs someone to confirm/);
    expect(validateMode("communication.send", "deny")).toBeNull();
    expect(validateMode("task.create", "auto")).toBeNull();
  });
  it("confirmation grows with risk", () => {
    expect([2, 3, 4, 5].map((r) => confirmFor(r as 2 | 3 | 4 | 5))).toEqual(["click", "click", "acknowledge", "typed"]);
  });
  it("labels every action an admin can configure", () => {
    expect(POLICY_KEYS.length).toBeGreaterThanOrEqual(10);
    for (const k of POLICY_KEYS) expect(POLICY_ACTIONS[k].label).toBeTruthy();
  });
});

describe("action tools offered per role", () => {
  const names = (role: string, mode?: keyof typeof MODES) => toolsForPrincipal(principal(role), mode ? MODES[mode].tools ?? undefined : undefined).filter(isAction).map((t) => t.name);
  it("residents can file, book, invite and report for themselves — never assign, log, announce or message others", () => {
    const r = names("resident", "resident");
    expect(r).toEqual(expect.arrayContaining(["create_work_order", "create_booking", "cancel_booking", "register_visitor", "create_incident", "comment_on_work_order"]));
    for (const n of ["assign_work_order", "update_work_order_status", "log_package", "send_announcement", "message_resident", "create_task", "schedule_inspection"]) expect(r).not.toContain(n);
  });
  it("property managers get every action; the front desk gets desk actions", () => {
    expect(new Set(names("property_manager"))).toEqual(new Set(ACTION_TOOL_NAMES));
    const desk = names("concierge", "frontdesk");
    expect(desk).toEqual(expect.arrayContaining(["log_package", "register_visitor"]));
    expect(desk).not.toContain("assign_work_order");
  });
  it("vendors only act on work they can see", () => {
    const v = names("vendor");
    expect(v).not.toContain("create_work_order");
    expect(v).not.toContain("send_announcement");
  });
  it("every action declares its risk and policy keys", () => {
    const p = principal("property_manager");
    for (const t of toolsForPrincipal(p).filter(isAction)) {
      expect(t.policyKeys({} as never, p).every((k) => k in POLICY_ACTIONS)).toBe(true);
    }
  });
});
