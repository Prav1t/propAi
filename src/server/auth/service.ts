import "server-only";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, withContext } from "../db/client";
import { emailTokens, loginEvents, mfaChallenges, mfaRecoveryCodes, sessions, users, type User } from "../db/schema";
import { env } from "../env";
import { log } from "../log";
import { sendEmail } from "../mail/mailer";
import { newSignInTemplate, resetPasswordTemplate, verifyEmailTemplate } from "../mail/templates";
import { writeAudit } from "../audit";
import type { RequestMeta } from "../request-meta";
import { generateToken, hashToken } from "./crypto";
import { seal, unseal } from "../keyring";
import { burnPasswordCheck, hashPassword, passwordSchema, verifyPassword } from "./password";
import { LIMITS, rateLimiter } from "./rate-limit";
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, totpStep, totpUri, verifyTotp } from "./totp";
import { BRAND } from "@/config/brand";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const SESSION_REFRESH_MS = 24 * 60 * 60_000; // slide expiry at most once a day
const SEEN_UPDATE_MS = 5 * 60_000;
const VERIFY_TTL_MS = 24 * 60 * 60_000;
const RESET_TTL_MS = 60 * 60_000;
const MFA_CHALLENGE_TTL_MS = 5 * 60_000;

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);
export const nameSchema = z.string().trim().min(1, "Enter your name.").max(100);

export type AuthResult<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });

const RATE_LIMITED = fail("rate_limited", "Too many attempts. Please wait a few minutes and try again.");

/* ───────────── sessions ───────────── */

// how a session was established (RFC 8176-style): "pwd" password, "otp" authenticator code, "recovery" recovery code,
// "sso" an organization's identity provider ("sso_mfa" when it reported multi-factor), "invite" a new account
export type AuthMethod = "pwd" | "otp" | "recovery" | "sso" | "sso_mfa" | "invite";
export type SessionOptions = { amr: AuthMethod[]; ssoConnectionId?: string | null };

export async function createSession(userId: string, meta: RequestMeta | null, opts: SessionOptions = { amr: ["pwd"] }): Promise<string> {
  const token = generateToken();
  const now = new Date();
  await db().insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
    amr: [...new Set(opts.amr)],
    reauthAt: now, // signing in counts as a fresh confirmation
    ssoConnectionId: opts.ssoConnectionId ?? null,
  });
  return token;
}

export type SessionUser = Pick<User, "id" | "email" | "name" | "isPlatformAdmin" | "mfaEnabled" | "emailVerifiedAt"> & { hasPassword: boolean };
export type ValidSession = {
  sessionId: string; expiresAt: Date; user: SessionUser; refreshed: boolean;
  createdAt: Date; amr: string[]; reauthAt: Date | null; ssoConnectionId: string | null;
};

// sessions slide while used, but a stolen cookie can't be kept alive forever (finding F-07)
export const absoluteExpiry = (createdAt: Date) => new Date(createdAt.getTime() + env().SESSION_ABSOLUTE_DAYS * 24 * 60 * 60_000);

// validates an opaque token; slides expiry; rejects deactivated users
export async function validateSessionToken(token: string): Promise<ValidSession | null> {
  if (!token || token.length > 128) return null;
  const id = hashToken(token);
  const rows = await db()
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  const hardStop = absoluteExpiry(row.s.createdAt).getTime();
  if (row.s.expiresAt.getTime() <= now || hardStop <= now || row.u.status !== "active") {
    await db().delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  let expiresAt = row.s.expiresAt;
  let refreshed = false;
  if (expiresAt.getTime() - now < SESSION_TTL_MS - SESSION_REFRESH_MS) {
    expiresAt = new Date(Math.min(now + SESSION_TTL_MS, hardStop));
    refreshed = true;
    await db().update(sessions).set({ expiresAt, lastSeenAt: new Date() }).where(eq(sessions.id, id));
  } else if (now - row.s.lastSeenAt.getTime() > SEEN_UPDATE_MS) {
    await db().update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, id));
  }
  const { id: uid, email, name, isPlatformAdmin, mfaEnabled, emailVerifiedAt } = row.u;
  return {
    sessionId: id, expiresAt, refreshed, createdAt: row.s.createdAt, amr: row.s.amr, reauthAt: row.s.reauthAt, ssoConnectionId: row.s.ssoConnectionId,
    user: { id: uid, email, name, isPlatformAdmin, mfaEnabled, emailVerifiedAt, hasPassword: !!row.u.passwordHash },
  };
}

/* ───────────── re-authentication for sensitive changes (finding F-09) ───────────── */

export const REAUTH_WINDOW_MS = 10 * 60_000;

// signed in, or re-confirmed, within the last few minutes
export function isRecentAuth(s: Pick<ValidSession, "reauthAt">, windowMs = REAUTH_WINDOW_MS, now = Date.now()): boolean {
  return !!s.reauthAt && now - s.reauthAt.getTime() <= windowMs;
}

// "confirm it's you": the password, or an authenticator/recovery code for people who sign in without one
export async function reauthenticate(sessionId: string, userId: string, input: { password?: string; code?: string }, meta: RequestMeta | null): Promise<AuthResult> {
  const rl = await rateLimiter().hit(`reauth:${userId}`, LIMITS.mfa.limit, LIMITS.mfa.windowMs);
  if (!rl.allowed) return RATE_LIMITED;
  const user = await db().query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || user.status !== "active") return fail("invalid", "Sign in again.");
  let ok = false;
  if (input.password && user.passwordHash) ok = await verifyPassword(user.passwordHash, input.password);
  else if (input.code && user.mfaEnabled && user.mfaSecretEnc) ok = (await acceptMfaCode(user, input.code)) !== null;
  if (!ok) {
    await recordLogin({ userId, email: user.email, success: false, reason: "reauth_failed", meta });
    return fail("invalid", user.passwordHash ? "That password isn't right." : "That code didn't work.");
  }
  await db().update(sessions).set({ reauthAt: new Date() }).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  return { ok: true };
}

// marks the session as freshly confirmed (used by an SSO round trip with prompt=login)
export async function markReauthenticated(sessionId: string, userId: string) {
  await db().update(sessions).set({ reauthAt: new Date() }).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
}

export async function revokeSession(sessionId: string) {
  await db().delete(sessions).where(eq(sessions.id, sessionId));
}

export async function revokeOtherSessions(userId: string, keepSessionId: string | null) {
  const cond = keepSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)) : eq(sessions.userId, userId);
  await db().delete(sessions).where(cond);
}

export async function listSessions(userId: string) {
  return db()
    .select({ id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, ip: sessions.ip, userAgent: sessions.userAgent })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.lastSeenAt));
}

// revoke one of *my* sessions by its public id (the hash); ownership enforced in the WHERE
export async function revokeMySession(userId: string, sessionId: string) {
  await db().delete(sessions).where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)));
}

/* ───────────── email tokens ───────────── */

async function issueEmailToken(userId: string, purpose: "verify_email" | "reset_password", ttlMs: number) {
  const token = generateToken();
  // one live token per purpose: invalidate older ones
  await db()
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose), isNull(emailTokens.usedAt)));
  await db().insert(emailTokens).values({ userId, purpose, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + ttlMs) });
  return token;
}

// atomically consumes a token; returns its user id or null
async function consumeEmailToken(token: string, purpose: "verify_email" | "reset_password"): Promise<string | null> {
  const rows = await db()
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailTokens.tokenHash, hashToken(token)),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: emailTokens.userId });
  return rows[0]?.userId ?? null;
}

async function sendVerification(user: { id: string; name: string; email: string }) {
  const token = await issueEmailToken(user.id, "verify_email", VERIFY_TTL_MS);
  await sendEmail(user.email, verifyEmailTemplate(user.name, `${env().APP_URL}/verify-email?token=${token}`));
}

/* ───────────── registration & verification ───────────── */

export const registerSchema = z.object({ name: nameSchema, email: emailSchema, password: passwordSchema });

// same response whether or not the email exists (anti-enumeration)
export async function register(input: z.infer<typeof registerSchema>, meta: RequestMeta | null): Promise<AuthResult> {
  if (!env().ALLOW_REGISTRATION) return fail("disabled", "Registration is currently closed.");
  const rl = await rateLimiter().hit(`register:${meta?.ip ?? "unknown"}`, LIMITS.register.limit, LIMITS.register.windowMs);
  if (!rl.allowed) return RATE_LIMITED;

  const existing = await db().query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) {
    if (!existing.emailVerifiedAt) await sendVerification(existing);
    else {
      const token = await issueEmailToken(existing.id, "reset_password", RESET_TTL_MS);
      await sendEmail(existing.email, resetPasswordTemplate(existing.name, `${env().APP_URL}/reset-password?token=${token}`));
    }
    return { ok: true };
  }
  const passwordHash = await hashPassword(input.password);
  const [user] = await db().insert(users).values({ name: input.name, email: input.email, passwordHash }).returning();
  await withContext({ userId: user.id }, (tx) =>
    writeAudit(tx, { orgId: null, actorUserId: user.id, action: "user.registered", entityType: "user", entityId: user.id }, meta),
  );
  await sendVerification(user);
  return { ok: true };
}

export async function verifyEmail(token: string): Promise<AuthResult<{ userId: string }>> {
  const userId = await consumeEmailToken(token, "verify_email");
  if (!userId) return fail("invalid_token", "This verification link is invalid or has expired.");
  await db().update(users).set({ emailVerifiedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
  return { ok: true, userId };
}

export async function resendVerification(email: string, meta: RequestMeta | null): Promise<void> {
  const rl = await rateLimiter().hit(`verify:${email}`, 3, 60 * 60_000);
  if (!rl.allowed) return;
  const user = await db().query.users.findFirst({ where: eq(users.email, email) });
  if (user && !user.emailVerifiedAt && user.status === "active") await sendVerification(user);
  void meta;
}

/* ───────────── login ───────────── */

export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password.").max(128) });

export type LoginOutcome =
  | { ok: true; kind: "session"; token: string; userId: string }
  | { ok: true; kind: "mfa"; challengeToken: string }
  | { ok: false; code: string; message: string };

const BAD_CREDENTIALS = fail("invalid_credentials", "Incorrect email or password.");

async function recordLogin(e: { userId: string | null; email: string; success: boolean; reason: string; meta: RequestMeta | null; suspicious?: boolean }) {
  await db().insert(loginEvents).values({
    userId: e.userId, email: e.email, success: e.success, reason: e.reason, suspicious: e.suspicious ?? false,
    ip: e.meta?.ip ?? null, userAgent: e.meta?.userAgent ?? null,
  });
}

export async function login(input: z.infer<typeof loginSchema>, meta: RequestMeta | null): Promise<LoginOutcome> {
  const limiter = rateLimiter();
  const ipRl = await limiter.hit(`login:ip:${meta?.ip ?? "unknown"}`, LIMITS.loginPerIp.limit, LIMITS.loginPerIp.windowMs);
  const emailRl = await limiter.hit(`login:email:${input.email}`, LIMITS.loginPerEmail.limit, LIMITS.loginPerEmail.windowMs);
  if (!ipRl.allowed || !emailRl.allowed) {
    await recordLogin({ userId: null, email: input.email, success: false, reason: "rate_limited", meta });
    return RATE_LIMITED;
  }

  const user = await db().query.users.findFirst({ where: eq(users.email, input.email) });
  if (!user || !user.passwordHash) {
    await burnPasswordCheck(input.password);
    await recordLogin({ userId: null, email: input.email, success: false, reason: "unknown_user", meta });
    return BAD_CREDENTIALS;
  }
  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    await recordLogin({ userId: user.id, email: input.email, success: false, reason: "bad_password", meta });
    return BAD_CREDENTIALS;
  }
  if (user.status !== "active") {
    await recordLogin({ userId: user.id, email: input.email, success: false, reason: "deactivated", meta });
    return fail("deactivated", "This account has been deactivated. Contact your administrator.");
  }
  if (!user.emailVerifiedAt) {
    await recordLogin({ userId: user.id, email: input.email, success: false, reason: "unverified", meta });
    return fail("unverified", "Verify your email address before signing in. We can send a new link.");
  }
  await limiter.reset(`login:email:${input.email}`);

  if (user.mfaEnabled) {
    const challengeToken = generateToken();
    await db().insert(mfaChallenges).values({ id: hashToken(challengeToken), userId: user.id, expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS) });
    await recordLogin({ userId: user.id, email: input.email, success: false, reason: "mfa_required", meta });
    return { ok: true, kind: "mfa", challengeToken };
  }
  return completeLogin(user, meta);
}

// new-device detection: no successful login from this IP + user agent family in 90 days
async function isNewDevice(userId: string, meta: RequestMeta | null): Promise<boolean> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60_000);
  const prior = await db()
    .select({ ip: loginEvents.ip, ua: loginEvents.userAgent })
    .from(loginEvents)
    .where(and(eq(loginEvents.userId, userId), eq(loginEvents.success, true), gt(loginEvents.createdAt, since)))
    .limit(200);
  if (prior.length === 0) return false; // first login ever isn't suspicious
  return !prior.some((p) => p.ip === (meta?.ip ?? null) && p.ua === (meta?.userAgent ?? null));
}

async function completeLogin(user: User, meta: RequestMeta | null, amr: AuthMethod[] = ["pwd"]): Promise<LoginOutcome> {
  const suspicious = await isNewDevice(user.id, meta);
  await recordLogin({ userId: user.id, email: user.email, success: true, reason: "ok", meta, suspicious });
  await db().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  if (suspicious) {
    await sendEmail(user.email, newSignInTemplate(user.name, new Date().toUTCString(), meta?.ip ?? null, meta?.userAgent ?? null, `${env().APP_URL}/account/security`));
  }
  const token = await createSession(user.id, meta, { amr });
  return { ok: true, kind: "session", token, userId: user.id };
}

export async function verifyMfaLogin(challengeToken: string, code: string, meta: RequestMeta | null): Promise<LoginOutcome> {
  const rl = await rateLimiter().hit(`mfa:${meta?.ip ?? "unknown"}`, LIMITS.mfa.limit, LIMITS.mfa.windowMs);
  if (!rl.allowed) return RATE_LIMITED;
  const id = hashToken(challengeToken);
  const challenge = await db().query.mfaChallenges.findFirst({ where: eq(mfaChallenges.id, id) });
  if (!challenge || challenge.expiresAt.getTime() <= Date.now() || challenge.attempts >= 5) {
    if (challenge) await db().delete(mfaChallenges).where(eq(mfaChallenges.id, id));
    return fail("challenge_expired", "Your sign-in attempt expired. Sign in again.");
  }
  const user = await db().query.users.findFirst({ where: eq(users.id, challenge.userId) });
  if (!user || user.status !== "active" || !user.mfaEnabled || !user.mfaSecretEnc) return fail("challenge_expired", "Sign in again.");

  const method = await acceptMfaCode(user, code);
  const ok = method !== null;
  const usedRecovery = method === "recovery";
  if (!ok) {
    await db().update(mfaChallenges).set({ attempts: sql`${mfaChallenges.attempts} + 1` }).where(eq(mfaChallenges.id, id));
    await recordLogin({ userId: user.id, email: user.email, success: false, reason: "mfa_failed", meta });
    return fail("invalid_code", "That code didn't work. Check your authenticator app and try again.");
  }
  await db().delete(mfaChallenges).where(eq(mfaChallenges.id, id));
  if (usedRecovery) log.info("auth.recovery_code_used", { userId: user.id });
  return completeLogin(user, meta, ["pwd", method]);
}

// accepts a current authenticator code once (the step is recorded atomically, finding F-06) or an unused recovery code
async function acceptMfaCode(user: User, code: string): Promise<"otp" | "recovery" | null> {
  if (!user.mfaSecretEnc) return null;
  const step = totpStep(code, unseal(user.mfaSecretEnc));
  if (step !== null) {
    const claimed = await db().update(users).set({ mfaLastUsedStep: step })
      .where(and(eq(users.id, user.id), sql`(${users.mfaLastUsedStep} is null or ${users.mfaLastUsedStep} < ${step})`))
      .returning({ id: users.id });
    return claimed.length ? "otp" : null; // already used: a replay
  }
  if (/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(code.trim())) {
    const used = await db()
      .update(mfaRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(mfaRecoveryCodes.userId, user.id), eq(mfaRecoveryCodes.codeHash, hashRecoveryCode(code)), isNull(mfaRecoveryCodes.usedAt)))
      .returning({ id: mfaRecoveryCodes.id });
    if (used.length) return "recovery";
  }
  return null;
}

/* ───────────── password reset / change ───────────── */

export async function requestPasswordReset(email: string, meta: RequestMeta | null): Promise<void> {
  const rl = await rateLimiter().hit(`reset:${meta?.ip ?? "unknown"}`, LIMITS.resetRequest.limit, LIMITS.resetRequest.windowMs);
  const rl2 = await rateLimiter().hit(`reset:${email}`, 3, LIMITS.resetRequest.windowMs);
  if (!rl.allowed || !rl2.allowed) return;
  const user = await db().query.users.findFirst({ where: eq(users.email, email) });
  if (!user || user.status !== "active") return; // silent: no enumeration
  const token = await issueEmailToken(user.id, "reset_password", RESET_TTL_MS);
  await sendEmail(user.email, resetPasswordTemplate(user.name, `${env().APP_URL}/reset-password?token=${token}`));
}

export async function resetPassword(token: string, newPassword: string, meta: RequestMeta | null): Promise<AuthResult> {
  const parsed = passwordSchema.safeParse(newPassword);
  if (!parsed.success) return fail("weak_password", parsed.error.issues[0].message);
  const userId = await consumeEmailToken(token, "reset_password");
  if (!userId) return fail("invalid_token", "This reset link is invalid or has expired. Request a new one.");
  // reset proves email ownership, so it also verifies the address
  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
    .where(eq(users.id, userId));
  await revokeOtherSessions(userId, null);
  await withContext({ userId }, (tx) =>
    writeAudit(tx, { orgId: null, actorUserId: userId, action: "user.password_reset", entityType: "user", entityId: userId }, meta),
  );
  return { ok: true };
}

export async function changePassword(userId: string, current: string, next: string, keepSessionId: string, meta: RequestMeta | null): Promise<AuthResult> {
  const user = await db().query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, current))) return fail("invalid_password", "Your current password is incorrect.");
  const parsed = passwordSchema.safeParse(next);
  if (!parsed.success) return fail("weak_password", parsed.error.issues[0].message);
  await db().update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, userId));
  await revokeOtherSessions(userId, keepSessionId);
  await withContext({ userId }, (tx) =>
    writeAudit(tx, { orgId: null, actorUserId: userId, action: "user.password_changed", entityType: "user", entityId: userId }, meta),
  );
  return { ok: true };
}

/* ───────────── MFA enrollment ───────────── */

export async function beginMfaEnrollment(userId: string): Promise<{ secret: string; uri: string }> {
  const user = await db().query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new Error("User not found");
  const secret = newTotpSecret();
  await db().update(users).set({ mfaPendingSecretEnc: seal(secret) }).where(eq(users.id, userId));
  return { secret, uri: totpUri(secret, user.email, BRAND.name) };
}

// keepSessionId: the session that enrolled stays signed in (now counting as two-step); every other session ends (F-08)
export async function confirmMfaEnrollment(userId: string, code: string, meta: RequestMeta | null, keepSessionId: string | null = null): Promise<AuthResult<{ recoveryCodes: string[] }>> {
  const user = await db().query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.mfaPendingSecretEnc) return fail("no_enrollment", "Start setup again.");
  const secretEnc = user.mfaPendingSecretEnc;
  const step = totpStep(code, unseal(secretEnc));
  if (step === null) return fail("invalid_code", "That code didn't match. Try the current code from your app.");
  const codes = newRecoveryCodes();
  await db().transaction(async (tx) => {
    await tx.update(users).set({ mfaEnabled: true, mfaSecretEnc: secretEnc, mfaPendingSecretEnc: null, mfaLastUsedStep: step }).where(eq(users.id, userId));
    await tx.delete(sessions).where(keepSessionId ? and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)) : eq(sessions.userId, userId));
    if (keepSessionId) await tx.update(sessions).set({ amr: sql`array(select distinct unnest(${sessions.amr} || array['otp']))`, reauthAt: new Date() }).where(eq(sessions.id, keepSessionId));
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await tx.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })));
  });
  await withContext({ userId }, (tx) =>
    writeAudit(tx, { orgId: null, actorUserId: userId, action: "user.mfa_enabled", entityType: "user", entityId: userId }, meta),
  );
  return { ok: true, recoveryCodes: codes };
}

export async function disableMfa(userId: string, password: string, meta: RequestMeta | null, keepSessionId: string | null = null): Promise<AuthResult> {
  const user = await db().query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, password))) return fail("invalid_password", "Your password is incorrect.");
  await db().update(users).set({ mfaEnabled: false, mfaSecretEnc: null, mfaPendingSecretEnc: null, mfaLastUsedStep: null }).where(eq(users.id, userId));
  await db().delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await revokeOtherSessions(userId, keepSessionId); // a weaker sign-in requirement shouldn't leave other sessions running (F-08)
  await withContext({ userId }, (tx) =>
    writeAudit(tx, { orgId: null, actorUserId: userId, action: "user.mfa_disabled", entityType: "user", entityId: userId }, meta),
  );
  return { ok: true };
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  const [r] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
  return r?.n ?? 0;
}

export async function loginHistory(userId: string, limit = 20) {
  return db()
    .select({ id: loginEvents.id, success: loginEvents.success, reason: loginEvents.reason, suspicious: loginEvents.suspicious, ip: loginEvents.ip, userAgent: loginEvents.userAgent, createdAt: loginEvents.createdAt })
    .from(loginEvents)
    .where(eq(loginEvents.userId, userId))
    .orderBy(desc(loginEvents.createdAt))
    .limit(limit);
}

export async function updateProfile(userId: string, name: string, meta: RequestMeta | null): Promise<AuthResult> {
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) return fail("invalid", parsed.error.issues[0].message);
  const before = await db().query.users.findFirst({ where: eq(users.id, userId), columns: { name: true } });
  await db().update(users).set({ name: parsed.data }).where(eq(users.id, userId));
  await withContext({ userId }, (tx) =>
    writeAudit(tx, { orgId: null, actorUserId: userId, action: "user.profile_updated", entityType: "user", entityId: userId, before, after: { name: parsed.data } }, meta),
  );
  return { ok: true };
}
