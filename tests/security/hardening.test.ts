// Iteration 11 findings, each proven fixed: sessions and re-authentication (F-06–F-09), member management scope (F-03),
// resident deletion (F-02), move-in dates (F-14), mass assignment, audit tamper evidence and key rotation.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beginMfaEnrollment, confirmMfaEnrollment, createSession, disableMfa, isRecentAuth, reauthenticate, validateSessionToken,
} from "@/server/auth/service";
import { currentTotp } from "@/server/auth/totp";
import { hashPassword } from "@/server/auth/password";
import { changeMemberRole, inviteMember, inviteSchema, setMemberStatus } from "@/server/modules/members/service";
import { createResident, deleteResident, residentSchema } from "@/server/modules/people/service";
import { getPackage } from "@/server/modules/packages/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { unitResidentUsers } from "@/server/modules/community/residents";
import { checkpointAuditChains, verifyOrgAuditChain } from "@/server/audit-integrity";
import { resealAll } from "@/server/keyring-rotation";
import { unseal, type Keyring } from "@/server/keyring";
import { encrypt } from "@/server/auth/crypto";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { closeDb, withContext } from "@/server/db/client";
import type { TenantCtx } from "@/server/modules/context";
import { asApp, orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";
import { TEST_ENV } from "../support/test-env";

const meta = { ip: "203.0.113.40", userAgent: "vitest-hardening", requestId: "hard" };
const PW = "a sturdy passphrase 42";
let orgId: string;
let pm: TenantCtx;
let admin: TenantCtx;

async function ctxFor(email: string): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), "pacific-properties");
  if (!p) throw new Error(`${email} isn't a member`);
  return { principal: p, meta };
}
async function newUser(label: string, withPassword = true) {
  const email = `${label}-${randomUUID().slice(0, 8)}@sec.test`;
  const { rows } = await ownerPool.query("insert into users (email, name, password_hash, email_verified_at) values ($1, $2, $3, now()) returning id", [email, label, withPassword ? await hashPassword(PW) : null]);
  return { id: rows[0].id as string, email };
}
const roleId = async (key: string) => (await ownerPool.query("select id from roles where key = $1 and org_id is null", [key])).rows[0].id as string;
const propId = async (code: string) => (await ownerPool.query("select id from properties where org_id = $1 and code = $2", [orgId, code])).rows[0].id as string;

beforeAll(async () => {
  orgId = await orgIdBySlug("pacific-properties");
  pm = await ctxFor("pm@demo.test");
  admin = await ctxFor("admin@demo.test");
}, 60_000);
afterAll(async () => {
  // fixtures that would change other files' view of the organization
  await ownerPool.query("delete from unit_occupancies where resident_id in (select id from residents where first_name = 'Ivy' and last_name = 'Incoming')");
  await ownerPool.query("delete from residents where first_name = 'Ivy' and last_name = 'Incoming'");
  await ownerPool.query("delete from memberships where role_id in (select id from roles where key = 'site_admin')");
  await ownerPool.query("delete from invitations where role_id in (select id from roles where key = 'concierge') and email like '%@sec.test'");
  await ownerPool.query("delete from roles where key = 'site_admin'");
  await ownerPool.query("delete from webhook_endpoints where url = 'https://hooks.example.com/rotate'");
  await closeDb();
  await ownerPool.end();
});

describe("sessions (F-07, F-08) and re-authentication (F-09)", () => {
  it("a session can't outlive the absolute limit, however active it is", async () => {
    const u = await newUser("old-session");
    const token = await createSession(u.id, meta);
    const s = (await validateSessionToken(token))!;
    await ownerPool.query("update sessions set created_at = now() - interval '91 days' where id = $1", [s.sessionId]);
    expect(await validateSessionToken(token)).toBeNull();
    expect((await ownerPool.query("select 1 from sessions where id = $1", [s.sessionId])).rowCount).toBe(0);
  });

  it("sliding never extends past the absolute limit", async () => {
    const u = await newUser("slide");
    const token = await createSession(u.id, meta);
    const s = (await validateSessionToken(token))!;
    await ownerPool.query("update sessions set created_at = now() - interval '80 days', expires_at = now() + interval '1 day' where id = $1", [s.sessionId]);
    const after = (await validateSessionToken(token))!;
    expect(after.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 86_400_000 + 5_000);
  });

  it("sign-in counts as recent; after the window, only the right password or code re-confirms", async () => {
    const u = await newUser("reauth");
    const s = (await validateSessionToken(await createSession(u.id, meta)))!;
    expect(isRecentAuth(s)).toBe(true);
    await ownerPool.query("update sessions set reauth_at = now() - interval '11 minutes' where id = $1", [s.sessionId]);
    const stale = (await ownerPool.query("select reauth_at from sessions where id = $1", [s.sessionId])).rows[0].reauth_at as Date;
    expect(isRecentAuth({ reauthAt: stale })).toBe(false);
    expect(await reauthenticate(s.sessionId, u.id, { password: "wrong password!!" }, meta)).toMatchObject({ ok: false });
    expect(await reauthenticate(s.sessionId, u.id, { password: PW }, meta)).toEqual({ ok: true });
    const fresh = (await ownerPool.query("select reauth_at from sessions where id = $1", [s.sessionId])).rows[0].reauth_at as Date;
    expect(isRecentAuth({ reauthAt: fresh })).toBe(true);
  });

  it("re-confirmation can't be brute-forced", async () => {
    const u = await newUser("reauth-brute");
    const s = (await validateSessionToken(await createSession(u.id, meta)))!;
    for (let i = 0; i < 10; i++) await reauthenticate(s.sessionId, u.id, { password: `guess ${i} xxxxxxxx` }, meta);
    expect(await reauthenticate(s.sessionId, u.id, { password: PW }, meta)).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("turning MFA on keeps this session (now counting as two-step) and ends every other one; turning it off ends others too", async () => {
    const u = await newUser("mfa-sessions");
    const here = (await validateSessionToken(await createSession(u.id, meta)))!;
    const elsewhere = await createSession(u.id, meta);
    const { secret } = await beginMfaEnrollment(u.id);
    expect((await confirmMfaEnrollment(u.id, currentTotp(secret), meta, here.sessionId)).ok).toBe(true);
    expect(await validateSessionToken(elsewhere)).toBeNull();
    expect((await ownerPool.query("select amr from sessions where id = $1", [here.sessionId])).rows[0].amr).toContain("otp");
    const another = await createSession(u.id, meta);
    expect((await disableMfa(u.id, PW, meta, here.sessionId)).ok).toBe(true);
    expect(await validateSessionToken(another)).toBeNull();
    expect((await ownerPool.query("select 1 from sessions where id = $1", [here.sessionId])).rowCount).toBe(1);
  });
});

describe("member management stays inside the manager's scope (F-03)", () => {
  let site: TenantCtx;
  beforeAll(async () => {
    // a custom role that can manage members but is limited to Fraser Towers (no editor for this yet; it's how one would look)
    const perms = (await ownerPool.query("select array(select distinct unnest(permissions) from roles where org_id is null and key in ('property_manager','accountant')) p")).rows[0].p as string[];
    const r = await ownerPool.query("insert into roles (org_id, key, name, category, scope_level, permissions) values ($1, 'site_admin', 'Site admin', 'staff', 'scoped', $2) returning id", [orgId, [...new Set([...perms, "member.manage", "member.read"])]]);
    const u = await newUser("site-admin");
    const m = await ownerPool.query("insert into memberships (org_id, user_id, role_id) values ($1, $2, $3) returning id", [orgId, u.id, r.rows[0].id]);
    await ownerPool.query("insert into membership_scopes (org_id, membership_id, property_id) values ($1, $2, $3)", [orgId, m.rows[0].id, await propId("FRT")]);
    site = await ctxFor(u.email);
  });

  it("can't hand out an organization-wide role, even one with fewer permissions", async () => {
    await expect(inviteMember(site, { email: `acct-${randomUUID().slice(0, 6)}@sec.test`, roleId: await roleId("accountant") })).rejects.toThrow(ForbiddenError);
  });

  it("can grant property roles only for properties it fully manages", async () => {
    await expect(inviteMember(site, { email: `c1-${randomUUID().slice(0, 6)}@sec.test`, roleId: await roleId("concierge"), propertyId: await propId("KWR") })).rejects.toThrow(ForbiddenError);
    await expect(inviteMember(site, { email: `c2-${randomUUID().slice(0, 6)}@sec.test`, roleId: await roleId("concierge"), propertyId: await propId("FRT") })).resolves.toMatchObject({ ok: true });
  });

  it("can't change or deactivate members outside its scope", async () => {
    const staffMembership = (await ownerPool.query("select m.id from memberships m join users u on u.id = m.user_id where u.email = 'staff@demo.test' and m.org_id = $1", [orgId])).rows[0].id;
    await expect(changeMemberRole(site, { membershipId: staffMembership, roleId: await roleId("concierge"), propertyId: await propId("FRT") })).rejects.toThrow(ForbiddenError);
    await expect(setMemberStatus(site, staffMembership, "deactivated")).rejects.toThrow(ForbiddenError);
  });
});

describe("deleting a resident record (F-02)", () => {
  it("removes only resident access — the same person's staff membership stays", async () => {
    const r = await createResident(pm, { firstName: "Cora", lastName: "Concierge", email: null, phone: null, notes: null },
      { buildingId: (await ownerPool.query("select b.id from buildings b join properties p on p.id = b.property_id where p.code = 'FRT' limit 1")).rows[0].id, unitNumber: (await ownerPool.query("select u.number from units u join properties p on p.id = u.property_id where p.code = 'FRT' limit 1")).rows[0].number, relationship: "tenant", isPrimary: false, startsOn: null });
    const concierge = await userIdByEmail("concierge@demo.test");
    await ownerPool.query("update residents set user_id = $1 where id = $2", [concierge, r.id]);
    await deleteResident(pm, r.id);
    const { rows } = await ownerPool.query("select status from memberships where user_id = $1 and org_id = $2", [concierge, orgId]);
    expect(rows.map((x) => x.status)).toEqual(["active"]);
  });
});

describe("move-in dates (F-14)", () => {
  it("an incoming resident has no access to the unit — or its notifications — before move-in day", async () => {
    const unit = (await ownerPool.query("select k.unit_id, k.id from packages k where k.org_id = $1 and k.unit_id is not null limit 1", [orgId])).rows[0];
    const u = await newUser("incoming");
    const res = await ownerPool.query("insert into residents (org_id, user_id, first_name, last_name) values ($1, $2, 'Ivy', 'Incoming') returning id", [orgId, u.id]);
    await ownerPool.query("insert into unit_occupancies (org_id, unit_id, resident_id, relationship, starts_on) values ($1, $2, $3, 'tenant', current_date + 10)", [orgId, unit.unit_id, res.rows[0].id]);
    await ownerPool.query("insert into memberships (org_id, user_id, role_id) values ($1, $2, $3)", [orgId, u.id, await roleId("tenant")]);
    const p = (await loadPrincipal(u.id, "pacific-properties"))!;
    expect(p.unitIds.size).toBe(0);
    await expect(getPackage({ principal: p, meta }, unit.id)).rejects.toThrow(/Not found|permission/);
    const recipients = await withContext({ orgId, system: true }, (tx) => unitResidentUsers(tx, orgId, unit.unit_id));
    expect(recipients).not.toContain(u.id);
    // from move-in day on, it's theirs
    await ownerPool.query("update unit_occupancies set starts_on = current_date where resident_id = $1", [res.rows[0].id]);
    expect((await loadPrincipal(u.id, "pacific-properties"))!.unitIds.has(unit.unit_id)).toBe(true);
  });
});

describe("mass assignment", () => {
  it("form schemas drop fields nobody should be able to set", () => {
    const invite = inviteSchema.parse({ email: "x@sec.test", roleId: randomUUID(), orgId: randomUUID(), isPlatformAdmin: true, status: "active" });
    expect(Object.keys(invite).sort()).toEqual(["email", "propertyId", "roleId"].filter((k) => k in invite).sort());
    const resident = residentSchema.parse({ firstName: "A", lastName: "B", orgId: randomUUID(), userId: randomUUID() });
    expect(resident).not.toHaveProperty("orgId");
    expect(resident).not.toHaveProperty("userId");
  });
});

describe("audit log tamper evidence", () => {
  it("the chain verifies, and editing or removing an entry is detected", async () => {
    const ok = await verifyOrgAuditChain(admin);
    expect(ok.problem).toBeNull();
    expect(ok.checked).toBeGreaterThan(10);
    const c = await ownerPool.connect();
    try {
      await c.query("begin");
      await c.query("alter table audit_logs disable trigger audit_immutable");
      await c.query("update audit_logs set after = '{\"edited\":true}' where org_id = $1 and seq = 5", [orgId]);
      expect((await c.query("select problem_seq, problem from audit_verify($1)", [orgId])).rows[0]).toMatchObject({ problem_seq: "5", problem: "content changed after it was written" });
      await c.query("rollback");
      await c.query("begin");
      await c.query("delete from audit_logs where org_id = $1 and seq = 7", [orgId]);
      expect((await c.query("select problem from audit_verify($1)", [orgId])).rows[0].problem).toBe("entry 7 is missing");
    } finally {
      await c.query("rollback");
      c.release();
    }
  });

  it("the app's database role can't change or delete entries, or touch the chain head", async () => {
    await expect(asApp({ orgId }, (q) => q("update audit_logs set action = 'x' where org_id = $1", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asApp({ orgId }, (q) => q("delete from audit_logs where org_id = $1", [orgId]))).rejects.toThrow(/permission denied/);
    await expect(asApp({ system: true }, (q) => q("update audit_chain_heads set seq = 0"))).rejects.toThrow(/permission denied/);
  });

  it("retention can't prune less than a year, and checkpoints anchor each chain", async () => {
    await expect(ownerPool.query("select audit_prune($1, now() - interval '30 days')", [orgId])).rejects.toThrow(/at least 365 days/);
    expect(await checkpointAuditChains()).toBeGreaterThan(0);
    const { rows } = await ownerPool.query("select c.seq, h.seq head from audit_checkpoints c join audit_chain_heads h on h.chain_key = c.chain_key where c.chain_key = $1 order by c.created_at desc limit 1", [orgId]);
    expect(rows[0].seq).toBe(rows[0].head);
    expect(await checkpointAuditChains()).toBe(0); // at most daily
  });
});

describe("encryption key rotation", () => {
  it("re-seals old ciphertexts with the new key; values still read the same", async () => {
    const k1 = TEST_ENV.APP_ENCRYPTION_KEY;
    const k2 = Buffer.alloc(32, 7).toString("base64");
    const endpoint = await ownerPool.query("insert into webhook_endpoints (org_id, url, secret_enc, events) values ($1, 'https://hooks.example.com/rotate', $2, '{}') returning id", [orgId, encrypt("whsec_rotate_me", k1)]);
    const ring: Keyring = { currentId: "k2", keys: new Map([["k2", k2], ["k1", k1]]) };
    const { failed } = await resealAll(ownerPool, ring);
    expect(failed).toEqual([]);
    const v = (await ownerPool.query("select secret_enc from webhook_endpoints where id = $1", [endpoint.rows[0].id])).rows[0].secret_enc as string;
    expect(v.startsWith("v2.k2.")).toBe(true);
    expect(unseal(v, ring)).toBe("whsec_rotate_me");
    // nothing is left on the old key, so it can be retired
    const leftovers = await ownerPool.query("select count(*)::int n from webhook_endpoints where secret_enc not like 'v2.k2.%'");
    expect(leftovers.rows[0].n).toBe(0);
    // put things back for the rest of the suite (key k1 is the test environment's current key)
    await resealAll(ownerPool, { currentId: "k1", keys: new Map([["k1", k1], ["k2", k2]]) });
  });

  it("refuses a ciphertext whose key label was changed", async () => {
    const ring: Keyring = { currentId: "k1", keys: new Map([["k1", TEST_ENV.APP_ENCRYPTION_KEY], ["k9", TEST_ENV.APP_ENCRYPTION_KEY]]) };
    const { seal } = await import("@/server/keyring");
    const sealed = seal("secret", ring);
    expect(() => unseal(sealed.replace("v2.k1.", "v2.k9."), ring)).toThrow();
  });
});

void NotFoundError;
