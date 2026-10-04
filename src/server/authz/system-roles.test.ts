import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, isPermission } from "./permissions";
import { SYSTEM_ROLES } from "./system-roles";

describe("system roles", () => {
  it("covers every role named in the product brief", () => {
    const keys = SYSTEM_ROLES.map((r) => r.key);
    for (const k of ["org_admin", "property_manager", "portfolio_manager", "facility_manager", "building_manager", "staff",
      "maintenance_staff", "concierge", "security", "vendor", "accountant", "council_member", "resident", "tenant", "owner", "occupant"]) {
      expect(keys).toContain(k);
    }
  });
  it("only references known permissions", () => {
    for (const r of SYSTEM_ROLES) for (const p of r.permissions) expect(isPermission(p), `${r.key}:${p}`).toBe(true);
  });
  it("gives org admin every permission", () => {
    expect(new Set(SYSTEM_ROLES.find((r) => r.key === "org_admin")!.permissions)).toEqual(new Set(ALL_PERMISSIONS));
  });
  it("reserves member management, settings and audit for org admins", () => {
    for (const r of SYSTEM_ROLES.filter((x) => x.key !== "org_admin")) {
      expect(r.permissions, r.key).not.toContain("member.manage");
      expect(r.permissions, r.key).not.toContain("org.settings.manage");
      expect(r.permissions, r.key).not.toContain("audit.read");
    }
  });
  it("never gives resident-type roles directory or full-unit access", () => {
    for (const r of SYSTEM_ROLES.filter((x) => x.category === "resident")) {
      expect(r.scopeLevel).toBe("occupant");
      for (const p of ["resident.read", "unit.read", "workorder.read", "member.read", "property.manage"]) expect(r.permissions, r.key).not.toContain(p);
      // residents never manage shared records (bookings, packages, messages, documents…)
      expect(r.permissions.filter((p) => p.endsWith(".manage") || p.endsWith(".configure")), r.key).toEqual([]);
    }
  });
  it("front desk staff see the schedule and write handoffs; managers schedule", () => {
    const role = (k: string) => SYSTEM_ROLES.find((r) => r.key === k)!.permissions;
    for (const k of ["concierge", "security", "staff", "maintenance_staff"]) {
      expect(role(k), k).toContain("shift.read");
      expect(role(k), k).not.toContain("shift.manage");
    }
    for (const k of ["building_manager", "facility_manager", "property_manager"]) expect(role(k), k).toContain("shift.manage");
    for (const k of ["resident", "tenant", "owner", "occupant"]) {
      expect(role(k), k).toEqual(expect.arrayContaining(["visitor.invite", "parking.use"]));
      expect(role(k), k).not.toContain("visitor.manage");
    }
  });
  it("keeps vendors minimal", () => {
    const v = SYSTEM_ROLES.find((r) => r.key === "vendor")!;
    expect(v.scopeLevel).toBe("assigned");
    expect(v.permissions.sort()).toEqual(["message.use", "org.read", "workorder.read.assigned"]);
  });
});
