import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrganization, getOrgStats, listVisibleProperties, listAuditLogs, adminSetOrganizationStatus } from "@/server/modules/organizations/service";
import { loadPrincipal, listMyOrganizations } from "@/server/modules/organizations/principal";
import {
  acceptInvitation, acceptInvitationAsNewUser, changeMemberRole, getInvitation, inviteMember, listAssignableRoles,
  listMembers, revokeInvitation, setMemberStatus,
} from "@/server/modules/members/service";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { closeDb } from "@/server/db/client";
import type { TenantCtx } from "@/server/modules/context";
import { latestEmailLink, orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.5", userAgent: "vitest", requestId: "test" };
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function ctxFor(email: string, slug: string): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} is not a member of ${slug}`);
  return { principal: p, meta };
}
const tokenFrom = (link: string) => link.split("/invite/")[1];

let hbc: string; let frt: string;
beforeAll(async () => {
  const { rows } = await ownerPool.query("select code, id from properties where code in ('HBC','FRT')");
  hbc = rows.find((r) => r.code === "HBC").id;
  frt = rows.find((r) => r.code === "FRT").id;
});
afterAll(async () => {
  await closeDb();
  await ownerPool.end();
});

describe("principal loading", () => {
  it("returns null for organizations the user doesn't belong to", async () => {
    expect(await loadPrincipal(await userIdByEmail("pm@demo.test"), "northshore-strata")).toBeNull();
    expect(await loadPrincipal(await userIdByEmail("pm@demo.test"), "does-not-exist")).toBeNull();
  });
  it("expands portfolio scopes to their properties", async () => {
    const c = await ctxFor("facility@demo.test", "pacific-properties");
    expect([...c.principal.propertyIds]).toEqual([frt]);
  });
  it("resolves resident units from occupancy", async () => {
    const c = await ctxFor("resident@demo.test", "pacific-properties");
    expect(c.principal.unitIds.size).toBe(1);
    expect([...c.principal.occupantPropertyIds]).toEqual([frt]);
  });
  it("lists only the user's own organizations", async () => {
    const orgs = await listMyOrganizations(await userIdByEmail("admin@demo.test"));
    expect(orgs.map((o) => o.slug).sort()).toEqual(["northshore-strata", "pacific-properties"]);
  });
});

describe("scoped visibility", () => {
  it("org admin sees all 4 properties; the PM sees only their 2", async () => {
    const admin = await listVisibleProperties(await ctxFor("admin@demo.test", "pacific-properties"));
    const pm = await listVisibleProperties(await ctxFor("pm@demo.test", "pacific-properties"));
    expect(admin).toHaveLength(4);
    expect(pm.map((p) => p.code).sort()).toEqual(["FRT", "HBC"]);
  });
  it("building-scoped staff see only their building's units", async () => {
    const tech = await getOrgStats(await ctxFor("staff@demo.test", "pacific-properties"));
    const { rows } = await ownerPool.query("select count(*)::int n from units u join buildings b on b.id = u.building_id join properties p on p.id = b.property_id where p.code = 'HBC'");
    expect(tech.units).toBe(rows[0].n);
    expect(tech.properties).toBe(1);
  });
  it("a vendor sees no properties", async () => {
    await expect(listVisibleProperties(await ctxFor("vendor@demo.test", "pacific-properties"))).rejects.toThrow(ForbiddenError);
  });
  it("members and audit logs never include another org's rows", async () => {
    const c = await ctxFor("admin@demo.test", "pacific-properties");
    const members = await listMembers(c);
    const { rows } = await ownerPool.query("select id from memberships where org_id = $1", [c.principal.orgId]);
    expect(members.map((m) => m.membershipId).sort()).toEqual(rows.map((r) => r.id).sort());
    const logs = await listAuditLogs(c, { page: 1 });
    expect(logs.rows.every((r) => r.log.orgId === c.principal.orgId)).toBe(true);
  });
});

describe("organization creation", () => {
  it("creator becomes org admin with a unique slug and an audit trail", async () => {
    const userId = await userIdByEmail("pm@demo.test");
    const org1 = await createOrganization(userId, { name: "Dup Name Co", kind: "strata", timezone: "America/Vancouver" }, meta);
    const org2 = await createOrganization(userId, { name: "Dup Name Co", kind: "strata", timezone: "America/Vancouver" }, meta);
    expect(org1.slug).not.toBe(org2.slug);
    const p = await loadPrincipal(userId, org1.slug);
    expect(p?.role.key).toBe("org_admin");
    const { rows } = await ownerPool.query("select action from audit_logs where org_id = $1", [org1.id]);
    expect(rows.map((r) => r.action)).toContain("org.created");
  });
  it("unverified users cannot create organizations", async () => {
    const { rows } = await ownerPool.query("insert into users (email, name, password_hash) values ($1, 'Nope', 'x') returning id", [`unverified-${uniq()}@example.test`]);
    await expect(createOrganization(rows[0].id, { name: "Nope", kind: "strata", timezone: "UTC" }, meta)).rejects.toThrow(ForbiddenError);
  });
});

describe("invitations and membership management", () => {
  it("a scoped invite produces a member who only sees that property", async () => {
    const admin = await ctxFor("admin@demo.test", "pacific-properties");
    const roles = await listAssignableRoles(admin);
    const pmRole = roles.find((r) => r.key === "property_manager")!;
    const email = `new-pm-${uniq()}@example.test`;
    await expect(inviteMember(admin, { email, roleId: pmRole.id })).rejects.toThrow(/property/);
    await inviteMember(admin, { email, roleId: pmRole.id, propertyId: hbc });
    const token = tokenFrom(await latestEmailLink(email, "/invite/"));
    expect((await getInvitation(token))?.propertyName).toBe("Harbour Centre");
    const { orgSlug } = await acceptInvitationAsNewUser(token, { name: "New PM", password: "fresh passphrase 101" }, meta);
    expect(orgSlug).toBe("pacific-properties");
    const props = await listVisibleProperties(await ctxFor(email, "pacific-properties"));
    expect(props.map((p) => p.code)).toEqual(["HBC"]);
    expect(await getInvitation(token)).toBeNull(); // consumed
  });
  it("invitations can only be accepted by the invited email", async () => {
    const admin = await ctxFor("admin@demo.test", "pacific-properties");
    const staffRole = (await listAssignableRoles(admin)).find((r) => r.key === "accountant")!;
    const email = `acct-${uniq()}@example.test`;
    await inviteMember(admin, { email, roleId: staffRole.id });
    const token = tokenFrom(await latestEmailLink(email, "/invite/"));
    await expect(acceptInvitation(token, await userIdByEmail("vendor@demo.test"), meta)).rejects.toThrow(ForbiddenError);
  });
  it("revoked invitations can't be used", async () => {
    const admin = await ctxFor("admin@demo.test", "pacific-properties");
    const role = (await listAssignableRoles(admin)).find((r) => r.key === "accountant")!;
    const email = `revoked-${uniq()}@example.test`;
    await inviteMember(admin, { email, roleId: role.id });
    const token = tokenFrom(await latestEmailLink(email, "/invite/"));
    const { rows } = await ownerPool.query("select id from invitations where email = $1", [email]);
    await revokeInvitation(admin, rows[0].id);
    expect(await getInvitation(token)).toBeNull();
  });
  it("non-admins cannot invite, change roles or deactivate", async () => {
    const pm = await ctxFor("pm@demo.test", "pacific-properties");
    const target = (await listMembers(await ctxFor("admin@demo.test", "pacific-properties"))).find((m) => m.email === "concierge@demo.test")!;
    await expect(inviteMember(pm, { email: "x@example.test", roleId: target.membershipId })).rejects.toThrow(ForbiddenError);
    await expect(setMemberStatus(pm, target.membershipId, "deactivated")).rejects.toThrow(ForbiddenError);
  });
  it("an admin of another org cannot touch this org's members (not found)", async () => {
    const nsAdmin = await ctxFor("admin@northshore.test", "northshore-strata");
    const { rows } = await ownerPool.query("select m.id from memberships m join users u on u.id = m.user_id where u.email = 'concierge@demo.test'");
    await expect(setMemberStatus(nsAdmin, rows[0].id, "deactivated")).rejects.toThrow(NotFoundError);
    const roleId = (await listAssignableRoles(nsAdmin))[0].id;
    await expect(changeMemberRole(nsAdmin, { membershipId: rows[0].id, roleId })).rejects.toThrow(NotFoundError);
  });
  it("cannot demote the last admin or change your own role", async () => {
    const userId = await userIdByEmail("council@demo.test");
    const org = await createOrganization(userId, { name: `Solo ${uniq()}`, kind: "strata", timezone: "UTC" }, meta);
    const c = await ctxFor("council@demo.test", org.slug);
    const roleId = (await listAssignableRoles(c)).find((r) => r.key === "accountant")!.id;
    await expect(changeMemberRole(c, { membershipId: c.principal.membershipId, roleId })).rejects.toThrow(ForbiddenError);
    await expect(setMemberStatus(c, c.principal.membershipId, "deactivated")).rejects.toThrow(ForbiddenError);
  });
  it("deactivated members lose access immediately", async () => {
    const admin = await ctxFor("admin@demo.test", "pacific-properties");
    const role = (await listAssignableRoles(admin)).find((r) => r.key === "accountant")!;
    const email = `leaver-${uniq()}@example.test`;
    await inviteMember(admin, { email, roleId: role.id });
    await acceptInvitationAsNewUser(tokenFrom(await latestEmailLink(email, "/invite/")), { name: "Leaver", password: "leaving passphrase 3" }, meta);
    const m = (await listMembers(admin)).find((x) => x.email === email)!;
    await setMemberStatus(admin, m.membershipId, "deactivated");
    expect(await loadPrincipal(await userIdByEmail(email), "pacific-properties")).toBeNull();
    const { rows } = await ownerPool.query("select action from audit_logs where entity_id = $1 order by created_at", [m.membershipId]);
    expect(rows.map((r) => r.action)).toContain("member.deactivated");
  });
});

describe("platform administration", () => {
  it("only platform admins can suspend, and suspension blocks access", async () => {
    const orgId = await orgIdBySlug("northshore-strata");
    await expect(adminSetOrganizationStatus(await userIdByEmail("admin@demo.test"), orgId, "suspended", meta)).rejects.toThrow(ForbiddenError);
    const superId = await userIdByEmail("superadmin@demo.test");
    await adminSetOrganizationStatus(superId, orgId, "suspended", meta);
    expect(await loadPrincipal(await userIdByEmail("admin@northshore.test"), "northshore-strata")).toBeNull();
    await adminSetOrganizationStatus(superId, orgId, "active", meta);
    expect(await loadPrincipal(await userIdByEmail("admin@northshore.test"), "northshore-strata")).not.toBeNull();
  });
});
