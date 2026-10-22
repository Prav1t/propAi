// Single sign-on (OpenID Connect) against a local provider: the sign-in flow, every check on the response, domain
// verification, just-in-time membership, re-confirmation and the organization's SSO/MFA policy (Iteration 11).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDomain, completeSsoLogin, findConnection, removeDomain, saveConnection, setConnectionStatus, setSecurityPolicy, SsoError, startSsoLogin, verifyDomain, _test } from "@/server/sso/service";
import { createSession, validateSessionToken } from "@/server/auth/service";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { orgPrincipalForSession } from "@/server/org-session";
import { safeFetch, UnsafeTargetError } from "@/server/net/safe-fetch";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import { orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";
import { startMockIdp, type MockIdp } from "../support/mock-oidc";

const meta = { ip: "203.0.113.30", userAgent: "vitest-sso", requestId: "sso" };
let idp: MockIdp;
let admin: TenantCtx;
let orgId: string;
let domainId: string;
const txt = (values: string[]) => async () => values.map((v) => [v]);

async function ctxFor(email: string): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), "pacific-properties");
  return { principal: p!, meta };
}

// the whole browser round trip: our authorization URL → provider → back to /sso/callback
async function ssoSignIn(email: string, current: { sessionId: string; userId: string } | null = null, reauthUserId: string | null = null) {
  const c = await findConnection({ email });
  if (!c) throw new Error(`no connection for ${email}`);
  const url = await startSsoLogin(c, { next: "/o/pacific-properties/maintenance", loginHint: email, reauthUserId });
  const back = await idp.authorize(url);
  return { back, run: () => completeSsoLogin(new URL(back), meta, current) };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof SsoError) return e.code;
    throw e;
  }
};

beforeAll(async () => {
  idp = await startMockIdp();
  orgId = await orgIdBySlug("pacific-properties");
  admin = await ctxFor("admin@demo.test");
}, 60_000);
afterAll(async () => {
  await ownerPool.query("delete from sso_connections where org_id = $1", [orgId]);
  await ownerPool.query("delete from sso_domains where domain in ('demo.test', 'claimed.test')");
  await ownerPool.query("update org_security_policies set require_mfa = 'off', require_sso = false where org_id = $1", [orgId]);
  await idp.close();
  await closeDb();
  await ownerPool.end();
});

describe("domain verification", () => {
  it("refuses shared mailbox providers and malformed domains", async () => {
    await expect(addDomain(admin, "gmail.com")).rejects.toThrow(ValidationError);
    await expect(addDomain(admin, "not a domain")).rejects.toThrow(ValidationError);
  });

  it("verifies only with the exact TXT value, and records why a check failed", async () => {
    const d = await addDomain(admin, "demo.test");
    domainId = d.id;
    expect(await verifyDomain(admin, d.id, txt(["sso-verification=wrong"]))).toMatchObject({ verified: false });
    const { rows } = await ownerPool.query("select verified_at, last_check_error from sso_domains where id = $1", [d.id]);
    expect(rows[0].verified_at).toBeNull();
    expect(rows[0].last_check_error).toMatch(/doesn't contain/);
    expect(await verifyDomain(admin, d.id, txt([`sso-verification=${d.verificationToken}`]))).toMatchObject({ verified: true });
  });

  it("a domain another organization verified first can't be claimed", async () => {
    const north = await orgIdBySlug("northshore-strata");
    await ownerPool.query("insert into sso_domains (org_id, domain, verification_token, verified_at) values ($1, 'claimed.test', 'x', now())", [north]);
    const d = await addDomain(admin, "claimed.test");
    expect(await verifyDomain(admin, d.id, txt([`sso-verification=${d.verificationToken}`]))).toMatchObject({ verified: false, message: expect.stringMatching(/Another organization/) });
    await removeDomain(admin, d.id);
  });
});

describe("connection", () => {
  it("is saved only after the provider answers discovery; the secret is sealed and never audited", async () => {
    await expect(saveConnection(admin, { provider: "oidc", issuerInput: "http://127.0.0.1:1", clientId: idp.clientId, clientSecret: idp.clientSecret, jitRoleId: "", jitPropertyId: "" })).rejects.toThrow(ValidationError);
    await saveConnection(admin, { provider: "oidc", issuerInput: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, jitRoleId: "", jitPropertyId: "" });
    const { rows } = await ownerPool.query("select client_secret_enc from sso_connections where org_id = $1", [orgId]);
    expect(rows[0].client_secret_enc).toMatch(/^v2\.k1\./);
    expect(rows[0].client_secret_enc).not.toContain(idp.clientSecret);
    const audit = await ownerPool.query("select after::text a from audit_logs where org_id = $1 and action like 'sso.connection_%'", [orgId]);
    expect(audit.rows.map((r) => r.a).join(" ")).not.toContain(idp.clientSecret);
  });

  it("the discovery fetch is SSRF-guarded in production settings (https only, public addresses only)", async () => {
    await expect(safeFetch()(`${idp.issuer}/.well-known/openid-configuration`)).rejects.toThrow(UnsafeTargetError);
    await expect(safeFetch()("https://169.254.169.254/latest/meta-data")).rejects.toThrow(UnsafeTargetError);
  });
});

describe("sign-in", () => {
  it("an existing member signs in: an SSO session for this connection, audited", async () => {
    idp.setUser({ sub: "pm-1", email: "pm@demo.test", email_verified: true });
    const { run } = await ssoSignIn("pm@demo.test");
    const out = await run();
    expect(out).toMatchObject({ kind: "session", next: "/o/pacific-properties/maintenance", orgSlug: "pacific-properties" });
    if (out.kind !== "session") throw new Error();
    const s = await validateSessionToken(out.token);
    const c = await findConnection({ orgSlug: "pacific-properties" });
    expect(s).toMatchObject({ amr: ["sso"], ssoConnectionId: c!.id });
    const { rows } = await ownerPool.query("select 1 from audit_logs where org_id = $1 and action = 'user.sso_signed_in' and actor_user_id = $2", [orgId, await userIdByEmail("pm@demo.test")]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("a provider that reports multi-factor gives an sso_mfa session", async () => {
    idp.setUser({ sub: "pm-1", email: "pm@demo.test", email_verified: true, amr: ["pwd", "mfa"] });
    const out = await (await ssoSignIn("pm@demo.test")).run();
    if (out.kind !== "session") throw new Error();
    expect((await validateSessionToken(out.token))?.amr).toEqual(["sso", "sso_mfa"]);
  });

  it("people who aren't members can't get in unless just-in-time membership is on — then they join with the chosen role and property", async () => {
    idp.setUser({ sub: "new-1", email: "newhire@demo.test", email_verified: true, name: "New Hire" });
    expect(await code((await ssoSignIn("newhire@demo.test")).run())).toBe("not_member");
    const role = await ownerPool.query("select id from roles where key = 'staff' and org_id is null");
    const prop = await ownerPool.query("select id from properties where org_id = $1 and code = 'FRT'", [orgId]);
    await saveConnection(admin, { provider: "oidc", issuerInput: idp.issuer, clientId: idp.clientId, clientSecret: "", jitRoleId: role.rows[0].id, jitPropertyId: prop.rows[0].id });
    const out = await (await ssoSignIn("newhire@demo.test")).run();
    expect(out.kind).toBe("session");
    const p = await loadPrincipal(await userIdByEmail("newhire@demo.test"), "pacific-properties");
    expect(p?.role.key).toBe("staff");
    expect([...p!.propertyIds]).toEqual([prop.rows[0].id]);
    const u = await ownerPool.query("select password_hash, email_verified_at from users where email = 'newhire@demo.test'");
    expect(u.rows[0].password_hash).toBeNull(); // they sign in through SSO
    await saveConnection(admin, { provider: "oidc", issuerInput: idp.issuer, clientId: idp.clientId, clientSecret: "", jitRoleId: "", jitPropertyId: "" });
  });

  it("refuses an email on a domain the organization hasn't verified, or one the provider says is unverified", async () => {
    idp.setUser({ sub: "x", email: "intruder@elsewhere.test", email_verified: true });
    expect(await code((await ssoSignIn("pm@demo.test")).run())).toBe("domain_not_verified");
    idp.setUser({ sub: "pm-1", email: "pm@demo.test", email_verified: false });
    expect(await code((await ssoSignIn("pm@demo.test")).run())).toBe("email_unverified");
    idp.setUser({ sub: "pm-1", email: "pm@demo.test", email_verified: true });
  });

  it("rejects a tampered or mismatched response: nonce, audience, issuer, expiry, signature, missing email", async () => {
    for (const bad of [{ nonce: "replayed-nonce" }, { aud: "someone-else" }, { iss: "https://evil.example" }, { expired: true }, { foreignKey: true }]) {
      idp.misbehave(bad);
      expect(await code((await ssoSignIn("pm@demo.test")).run()), JSON.stringify(bad)).toBe("unverified_response");
    }
    idp.misbehave({ noEmail: true });
    expect(await code((await ssoSignIn("pm@demo.test")).run())).toBe("no_email");
    idp.misbehave({});
  });

  it("a callback can be used once, and state expires", async () => {
    const { run } = await ssoSignIn("pm@demo.test");
    expect((await run()).kind).toBe("session");
    expect(await code(run())).toBe("expired");
    const second = await ssoSignIn("pm@demo.test");
    await ownerPool.query("update sso_login_states set expires_at = now() - interval '1 minute'");
    expect(await code(second.run())).toBe("expired");
  });

  it("a deactivated membership stays out", async () => {
    const mid = await ownerPool.query("select m.id from memberships m join users u on u.id = m.user_id where u.email = 'pm@demo.test' and m.org_id = $1", [orgId]);
    await ownerPool.query("update memberships set status = 'deactivated' where id = $1", [mid.rows[0].id]);
    try {
      expect(await code((await ssoSignIn("pm@demo.test")).run())).toBe("membership_off");
    } finally {
      await ownerPool.query("update memberships set status = 'active' where id = $1", [mid.rows[0].id]);
    }
  });

  it("re-confirmation through SSO refreshes this session — and only for the same person", async () => {
    const pmId = await userIdByEmail("pm@demo.test");
    const token = await createSession(pmId, meta, { amr: ["sso"] });
    const s = (await validateSessionToken(token))!;
    await ownerPool.query("update sessions set reauth_at = now() - interval '1 hour' where id = $1", [s.sessionId]);
    idp.setUser({ sub: "pm-1", email: "pm@demo.test", email_verified: true });
    const r = await (await ssoSignIn("pm@demo.test", { sessionId: s.sessionId, userId: pmId }, pmId)).run();
    expect(r).toMatchObject({ kind: "reauth" });
    expect((await validateSessionToken(token))!.reauthAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    idp.setUser({ sub: "x", email: "staff@demo.test", email_verified: true });
    expect(await code((await ssoSignIn("pm@demo.test", { sessionId: s.sessionId, userId: pmId }, pmId)).run())).toBe("wrong_account");
  });
});

describe("organization policy", () => {
  it("requiring SSO needs an active connection and a verified domain, and an admin with MFA", async () => {
    await expect(setSecurityPolicy(admin, { requireMfa: "off", requireSso: true }, { mfaEnabled: false })).rejects.toThrow(/two-step/);
    await setSecurityPolicy(admin, { requireMfa: "off", requireSso: true }, { mfaEnabled: true });
  });

  it("then a staff password session is sent to SSO; this organization's SSO session gets in; another organization's doesn't", async () => {
    const pmId = await userIdByEmail("pm@demo.test");
    const pwd = (await validateSessionToken(await createSession(pmId, meta, { amr: ["pwd"] })))!;
    expect((await orgPrincipalForSession(pwd, "pacific-properties")).decision).toEqual({ ok: false, reason: "sso_required" });
    const c = await findConnection({ orgSlug: "pacific-properties" });
    const sso = (await validateSessionToken(await createSession(pmId, meta, { amr: ["sso"], ssoConnectionId: c!.id })))!;
    expect((await orgPrincipalForSession(sso, "pacific-properties")).decision).toEqual({ ok: true });
    const other = (await validateSessionToken(await createSession(pmId, meta, { amr: ["sso"], ssoConnectionId: "00000000-0000-4000-8000-000000000000" })))!;
    expect((await orgPrincipalForSession(other, "pacific-properties")).decision).toEqual({ ok: false, reason: "sso_required" });
  });

  it("residents keep their passwords; admins are the break-glass exception but need MFA", async () => {
    const resident = (await validateSessionToken(await createSession(await userIdByEmail("resident@demo.test"), meta, { amr: ["pwd"] })))!;
    expect((await orgPrincipalForSession(resident, "pacific-properties")).decision).toEqual({ ok: true });
    const adminPwd = (await validateSessionToken(await createSession(await userIdByEmail("admin@demo.test"), meta, { amr: ["pwd"] })))!;
    expect((await orgPrincipalForSession(adminPwd, "pacific-properties")).decision).toMatchObject({ ok: false });
    const adminOtp = (await validateSessionToken(await createSession(await userIdByEmail("admin@demo.test"), meta, { amr: ["pwd", "otp"] })))!;
    expect((await orgPrincipalForSession(adminOtp, "pacific-properties")).decision).toEqual({ ok: true });
  });

  it("switching SSO off lifts the requirement, so nobody is locked out", async () => {
    await setConnectionStatus(admin, "disabled");
    const pwd = (await validateSessionToken(await createSession(await userIdByEmail("pm@demo.test"), meta, { amr: ["pwd"] })))!;
    expect((await orgPrincipalForSession(pwd, "pacific-properties")).decision).toEqual({ ok: true });
    expect(await findConnection({ email: "pm@demo.test" })).toBeNull();
    await setConnectionStatus(admin, "active");
    await setSecurityPolicy(admin, { requireMfa: "off", requireSso: false }, { mfaEnabled: true });
    _test.clearConfigCache();
    void domainId;
  });

  it("requiring MFA for staff applies to sessions that are already open", async () => {
    await setSecurityPolicy(admin, { requireMfa: "staff", requireSso: false }, { mfaEnabled: true });
    try {
      const staffPwd = (await validateSessionToken(await createSession(await userIdByEmail("staff@demo.test"), meta, { amr: ["pwd"] })))!;
      expect((await orgPrincipalForSession(staffPwd, "pacific-properties")).decision).toEqual({ ok: false, reason: "mfa_setup_required" });
      const resident = (await validateSessionToken(await createSession(await userIdByEmail("resident@demo.test"), meta, { amr: ["pwd"] })))!;
      expect((await orgPrincipalForSession(resident, "pacific-properties")).decision).toEqual({ ok: true });
    } finally {
      await setSecurityPolicy(admin, { requireMfa: "off", requireSso: false }, { mfaEnabled: true });
    }
  });
});
