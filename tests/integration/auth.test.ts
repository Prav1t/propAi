import { afterAll, describe, expect, it } from "vitest";
import {
  beginMfaEnrollment, changePassword, confirmMfaEnrollment, login, register, requestPasswordReset, resetPassword,
  validateSessionToken, verifyEmail, verifyMfaLogin, revokeSession, listSessions,
} from "@/server/auth/service";
import { hashToken } from "@/server/auth/crypto";
import { currentTotp } from "@/server/auth/totp";
import { closeDb } from "@/server/db/client";
import { latestEmailLink, ownerPool } from "../support/db";

let n = 0;
// unique client ip per test so the in-memory rate limiter doesn't couple tests
const meta = () => ({ ip: `10.0.0.${++n}`, userAgent: "vitest", requestId: null });
const email = (tag: string) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
const PW = "a sturdy passphrase 42";

async function registerAndVerify(tag: string) {
  const e = email(tag);
  expect((await register({ name: "Test User", email: e, password: PW }, meta())).ok).toBe(true);
  const link = await latestEmailLink(e, "/verify-email");
  const token = new URL(link).searchParams.get("token")!;
  expect((await verifyEmail(token)).ok).toBe(true);
  return e;
}

afterAll(async () => {
  await closeDb();
  await ownerPool.end();
});

describe("registration and verification", () => {
  it("requires email verification before sign-in", async () => {
    const e = email("unverified");
    await register({ name: "U", email: e, password: PW }, meta());
    const out = await login({ email: e, password: PW }, meta());
    expect(out).toMatchObject({ ok: false, code: "unverified" });
  });
  it("verification tokens are single-use", async () => {
    const e = email("single");
    await register({ name: "U", email: e, password: PW }, meta());
    const token = new URL(await latestEmailLink(e, "/verify-email")).searchParams.get("token")!;
    expect((await verifyEmail(token)).ok).toBe(true);
    expect((await verifyEmail(token)).ok).toBe(false);
  });
  it("does not reveal whether an email is registered", async () => {
    const e = await registerAndVerify("enum");
    const again = await register({ name: "Other", email: e, password: "different passphrase 9" }, meta());
    expect(again).toEqual({ ok: true });
    const { rows } = await ownerPool.query("select count(*)::int n from users where email = $1", [e]);
    expect(rows[0].n).toBe(1);
  });
  it("stores only argon2id hashes, never plaintext", async () => {
    const e = await registerAndVerify("hash");
    const { rows } = await ownerPool.query("select password_hash from users where email = $1", [e]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(PW);
  });
});

describe("sign-in and sessions", () => {
  it("creates a session whose token is stored only as a hash", async () => {
    const e = await registerAndVerify("session");
    const out = await login({ email: e, password: PW }, meta());
    if (!out.ok || out.kind !== "session") throw new Error("expected session");
    const { rows } = await ownerPool.query("select id from sessions where id = $1", [hashToken(out.token)]);
    expect(rows).toHaveLength(1);
    const { rows: raw } = await ownerPool.query("select count(*)::int n from sessions where id = $1", [out.token]);
    expect(raw[0].n).toBe(0);
    const s = await validateSessionToken(out.token);
    expect(s?.user.email).toBe(e);
    await revokeSession(s!.sessionId);
    expect(await validateSessionToken(out.token)).toBeNull();
  });
  it("uses the same error for unknown email and wrong password", async () => {
    const e = await registerAndVerify("generic");
    const a = await login({ email: e, password: "wrong passphrase 1" }, meta());
    const b = await login({ email: email("nobody"), password: "wrong passphrase 1" }, meta());
    expect(a).toEqual(b);
  });
  it("locks an account after 5 failed attempts within the window", async () => {
    const e = await registerAndVerify("lock");
    for (let i = 0; i < 5; i++) await login({ email: e, password: "nope nope nope" }, meta());
    const out = await login({ email: e, password: PW }, meta());
    expect(out).toMatchObject({ ok: false, code: "rate_limited" });
  });
  it("rejects expired sessions", async () => {
    const e = await registerAndVerify("expired");
    const out = await login({ email: e, password: PW }, meta());
    if (!out.ok || out.kind !== "session") throw new Error("expected session");
    await ownerPool.query("update sessions set expires_at = now() - interval '1 minute' where id = $1", [hashToken(out.token)]);
    expect(await validateSessionToken(out.token)).toBeNull();
  });
  it("rejects sessions of deactivated users", async () => {
    const e = await registerAndVerify("deact");
    const out = await login({ email: e, password: PW }, meta());
    if (!out.ok || out.kind !== "session") throw new Error("expected session");
    await ownerPool.query("update users set status = 'deactivated' where email = $1", [e]);
    expect(await validateSessionToken(out.token)).toBeNull();
  });
  it("flags sign-ins from a new device after the first", async () => {
    const e = await registerAndVerify("newdevice");
    await login({ email: e, password: PW }, { ip: "192.0.2.1", userAgent: "UA-1", requestId: null });
    await login({ email: e, password: PW }, { ip: "192.0.2.1", userAgent: "UA-1", requestId: null });
    await login({ email: e, password: PW }, { ip: "198.51.100.7", userAgent: "UA-2", requestId: null });
    const { rows } = await ownerPool.query("select suspicious from login_events le join users u on u.id = le.user_id where u.email = $1 and success order by le.created_at", [e]);
    expect(rows.map((r) => r.suspicious)).toEqual([false, false, true]);
    await expect(latestEmailLink(e, "/account/security")).resolves.toContain("/account/security");
  });
});

describe("password reset and change", () => {
  it("reset link sets a new password and signs out every session", async () => {
    const e = await registerAndVerify("reset");
    const s = await login({ email: e, password: PW }, meta());
    if (!s.ok || s.kind !== "session") throw new Error("expected session");
    await requestPasswordReset(e, meta());
    const token = new URL(await latestEmailLink(e, "/reset-password")).searchParams.get("token")!;
    expect((await resetPassword(token, "brand new passphrase 7", meta())).ok).toBe(true);
    expect(await validateSessionToken(s.token)).toBeNull();
    expect((await login({ email: e, password: "brand new passphrase 7" }, meta())).ok).toBe(true);
    expect((await resetPassword(token, "another passphrase 88", meta())).ok).toBe(false); // single use
  });
  it("silently ignores reset requests for unknown emails", async () => {
    const e = email("ghost");
    await requestPasswordReset(e, meta());
    const { rows } = await ownerPool.query('select count(*)::int n from email_outbox where "to" = $1', [e]);
    expect(rows[0].n).toBe(0);
  });
  it("changing password keeps the current session and revokes others", async () => {
    const e = await registerAndVerify("change");
    const s1 = await login({ email: e, password: PW }, meta());
    const s2 = await login({ email: e, password: PW }, meta());
    if (!s1.ok || s1.kind !== "session" || !s2.ok || s2.kind !== "session") throw new Error("expected sessions");
    const cur = await validateSessionToken(s1.token);
    const r = await changePassword(cur!.user.id, PW, "updated passphrase 55", cur!.sessionId, meta());
    expect(r.ok).toBe(true);
    expect(await validateSessionToken(s1.token)).not.toBeNull();
    expect(await validateSessionToken(s2.token)).toBeNull();
    expect((await listSessions(cur!.user.id)).length).toBe(1);
  });
});

describe("two-factor authentication", () => {
  it("enrolls TOTP, then requires a code; recovery codes work once", async () => {
    const e = await registerAndVerify("mfa");
    const first = await login({ email: e, password: PW }, meta());
    if (!first.ok || first.kind !== "session") throw new Error("expected session");
    const userId = first.userId;
    const { secret } = await beginMfaEnrollment(userId);
    expect((await confirmMfaEnrollment(userId, "000000", meta())).ok).toBe(false);
    const enrolled = await confirmMfaEnrollment(userId, currentTotp(secret), meta());
    if (!enrolled.ok) throw new Error("enrollment failed");
    expect(enrolled.recoveryCodes).toHaveLength(10);
    const { rows } = await ownerPool.query("select mfa_secret_enc from users where id = $1", [userId]);
    expect(rows[0].mfa_secret_enc).not.toContain(secret); // encrypted at rest

    const step = await login({ email: e, password: PW }, meta());
    if (!step.ok || step.kind !== "mfa") throw new Error("expected mfa challenge");
    expect((await verifyMfaLogin(step.challengeToken, "123456", meta())).ok).toBe(false);
    const done = await verifyMfaLogin(step.challengeToken, currentTotp(secret), meta());
    expect(done).toMatchObject({ ok: true, kind: "session" });

    const step2 = await login({ email: e, password: PW }, meta());
    if (!step2.ok || step2.kind !== "mfa") throw new Error("expected mfa challenge");
    const code = enrolled.recoveryCodes[0];
    expect((await verifyMfaLogin(step2.challengeToken, code, meta())).ok).toBe(true);
    const step3 = await login({ email: e, password: PW }, meta());
    if (!step3.ok || step3.kind !== "mfa") throw new Error("expected mfa challenge");
    expect((await verifyMfaLogin(step3.challengeToken, code, meta())).ok).toBe(false);
  });
  it("a challenge dies after 5 wrong codes", async () => {
    const e = await registerAndVerify("mfa-brute");
    const first = await login({ email: e, password: PW }, meta());
    if (!first.ok || first.kind !== "session") throw new Error("expected session");
    const { secret } = await beginMfaEnrollment(first.userId);
    await confirmMfaEnrollment(first.userId, currentTotp(secret), meta());
    const step = await login({ email: e, password: PW }, meta());
    if (!step.ok || step.kind !== "mfa") throw new Error("expected mfa challenge");
    for (let i = 0; i < 5; i++) await verifyMfaLogin(step.challengeToken, "999999", meta());
    expect(await verifyMfaLogin(step.challengeToken, currentTotp(secret), meta())).toMatchObject({ ok: false, code: "challenge_expired" });
  });
});
