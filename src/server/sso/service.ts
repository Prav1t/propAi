import "server-only";
import dns from "node:dns/promises";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import * as oidc from "openid-client";
import { z } from "zod";
import { db, withContext, type Tx } from "../db/client";
import {
  memberships, membershipScopes, organizations, orgSecurityPolicies, properties, roles, ssoConnections, ssoDomains, ssoLoginStates, users,
} from "../db/schema";
import { authorize, ForbiddenError, NotFoundError } from "../authz/authorize";
import { writeAudit } from "../audit";
import { generateToken, hashToken } from "../auth/crypto";
import { createSession, markReauthenticated, type AuthMethod } from "../auth/service";
import { seal, unseal } from "../keyring";
import { env } from "../env";
import { log } from "../log";
import { safeFetch, UnsafeTargetError } from "../net/safe-fetch";
import { assertWithinLimit } from "../billing/entitlements";
import type { RequestMeta } from "../request-meta";
import { auditAs, tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { DEFAULT_POLICY, MFA_REQUIREMENTS } from "@/lib/security-policy";
import { loadSecurityPolicy } from "./policy";
import { domainRecordName, domainRecordValue, emailDomain, normalizeDomain, reportsMfa, SSO_PROVIDER_KEYS, SSO_PROVIDERS, type SsoProvider } from "@/lib/sso";
import { safeNext } from "@/lib/safe-next";

const STATE_TTL_MS = 10 * 60_000;
export const ssoCallbackUrl = () => `${env().APP_URL}/sso/callback`;

// what went wrong, as a code: the sign-in page shows a fixed message for it (never text taken from a URL)
export const SSO_ERRORS = {
  incomplete: "The sign-in response was incomplete. Start again.",
  expired: "This sign-in link has expired or was already used. Start again.",
  declined: "Your identity provider declined the sign-in.",
  disabled: "Single sign-on is switched off for this organization.",
  unverified_response: "The sign-in response couldn't be verified. Start again.",
  no_email: "Your identity provider didn't share an email address.",
  email_unverified: "Your identity provider says this email address isn't verified.",
  domain_not_verified: "Your email address isn't on a domain this organization has verified.",
  deactivated: "This account has been deactivated. Contact your administrator.",
  org_inactive: "This organization isn't active.",
  membership_off: "Your access to this organization has been switched off. Contact your administrator.",
  not_member: "You aren't a member of this organization yet. Ask an administrator to invite you.",
  no_seats: "This organization has no staff seats left on its plan. Ask an administrator.",
  wrong_account: "You signed in as a different person than the one using this session.",
  reauth_required: "Sign in again to continue.",
  no_connection: "That email address doesn't use single sign-on here. Sign in with your password.",
} as const;
export type SsoErrorCode = keyof typeof SSO_ERRORS;
export class SsoError extends Error {
  constructor(readonly code: SsoErrorCode) {
    super(SSO_ERRORS[code]);
  }
}

/* ───────────── policy ───────────── */

export { loadSecurityPolicy } from "./policy";

export const policySchema = z.object({ requireMfa: z.enum(MFA_REQUIREMENTS), requireSso: z.enum(["on", "off"]).transform((v) => v === "on") });

export async function setSecurityPolicy(ctx: TenantCtx, input: z.output<typeof policySchema>, actor: { mfaEnabled: boolean }) {
  const p = ctx.principal;
  authorize(p, "security.manage");
  return tenantTx(ctx, async (tx) => {
    if (input.requireSso) {
      const [c] = await tx.select().from(ssoConnections).where(and(eq(ssoConnections.orgId, p.orgId), eq(ssoConnections.status, "active")));
      const [d] = await tx.select({ id: ssoDomains.id }).from(ssoDomains).where(and(eq(ssoDomains.orgId, p.orgId), isNotNull(ssoDomains.verifiedAt))).limit(1);
      if (!c || !d) throw new ValidationError("Set up single sign-on and verify a domain before requiring it.", "requireSso");
    }
    // don't let an admin lock themselves out: whoever turns on MFA (or SSO, which makes admins use MFA) must have it
    if ((input.requireMfa !== "off" || input.requireSso) && !actor.mfaEnabled) {
      throw new ValidationError("Turn on two-step verification for your own account first (Account → Security).", "requireMfa");
    }
    const [before] = await tx.select().from(orgSecurityPolicies).where(eq(orgSecurityPolicies.orgId, p.orgId));
    await tx.insert(orgSecurityPolicies).values({ orgId: p.orgId, requireMfa: input.requireMfa, requireSso: input.requireSso, updatedByUserId: p.userId })
      .onConflictDoUpdate({ target: orgSecurityPolicies.orgId, set: { requireMfa: input.requireMfa, requireSso: input.requireSso, updatedByUserId: p.userId } });
    await auditAs(tx, ctx, "security.policy_changed", "organization", p.orgId, before ? { requireMfa: before.requireMfa, requireSso: before.requireSso } : DEFAULT_POLICY, input);
  });
}

/* ───────────── settings page ───────────── */

export async function getSecuritySettings(ctx: TenantCtx) {
  const p = ctx.principal;
  authorize(p, "security.manage");
  return tenantTx(ctx, async (tx) => {
    const [c] = await tx.select().from(ssoConnections).where(eq(ssoConnections.orgId, p.orgId));
    const domains = await tx.select().from(ssoDomains).where(eq(ssoDomains.orgId, p.orgId)).orderBy(ssoDomains.domain);
    const policy = await loadSecurityPolicy(tx, p.orgId);
    const [stored] = await tx.select().from(orgSecurityPolicies).where(eq(orgSecurityPolicies.orgId, p.orgId));
    const jitRoles = (await tx.select({ id: roles.id, key: roles.key, name: roles.name, scopeLevel: roles.scopeLevel, permissions: roles.permissions, category: roles.category })
      .from(roles).where(sql`${roles.orgId} is null or ${roles.orgId} = ${p.orgId}`))
      .filter((r) => r.category === "staff" && r.key !== "org_admin" && r.permissions.every((x) => p.permissions.has(x)));
    const props = await tx.select({ id: properties.id, name: properties.name }).from(properties).where(eq(properties.orgId, p.orgId)).orderBy(properties.name);
    return {
      connection: c ? { ...c, clientSecretEnc: undefined, hasSecret: !!c.clientSecretEnc } : null,
      domains: domains.map((d) => ({ ...d, recordName: domainRecordName(d.domain), recordValue: domainRecordValue(d.verificationToken) })),
      policy: { ...policy, requireSso: stored?.requireSso ?? false },
      jitRoles: jitRoles.map(({ id, name, scopeLevel }) => ({ id, name, scopeLevel })),
      properties: props,
      callbackUrl: ssoCallbackUrl(),
    };
  });
}

/* ───────────── connection ───────────── */

export const connectionSchema = z.object({
  provider: z.enum(SSO_PROVIDER_KEYS as [SsoProvider, ...SsoProvider[]]),
  issuerInput: z.string().trim().max(300).default(""), // tenant id, Okta domain or issuer URL, depending on the provider
  clientId: z.string().trim().min(3, "Enter the client ID.").max(300),
  clientSecret: z.string().trim().max(1000).default(""), // blank = keep the stored one
  jitRoleId: z.string().uuid().or(z.literal("")).default(""),
  jitPropertyId: z.string().uuid().or(z.literal("")).default(""),
});

function issuerFor(provider: SsoProvider, input: string): string {
  const def = SSO_PROVIDERS[provider];
  if (def.needs && !input.trim()) throw new ValidationError(`Enter the ${def.needs}.`, "issuerInput");
  if (provider === "microsoft" && !/^[0-9a-f-]{36}$|^[a-z0-9.-]+\.[a-z]{2,}$/i.test(input.trim())) throw new ValidationError("Enter the directory (tenant) ID, a GUID.", "issuerInput");
  const issuer = def.issuer(input.trim());
  try {
    const u = new URL(issuer);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && env().OIDC_ALLOW_HTTP_ISSUERS)) throw new Error();
  } catch {
    throw new ValidationError("The issuer must be an https:// URL.", "issuerInput");
  }
  return issuer;
}

// identity provider calls go through the SSRF-safe fetch: issuers are typed in by customers
const fetchOpts = () => (env().OIDC_ALLOW_HTTP_ISSUERS ? { allowHttp: true, allowPrivate: true } : {});

const configs = new Map<string, { at: number; config: oidc.Configuration }>();
async function oidcConfig(c: { id: string; issuer: string; clientId: string; clientSecretEnc: string; updatedAt: Date }): Promise<oidc.Configuration> {
  const key = `${c.id}:${c.updatedAt.getTime()}`;
  const hit = configs.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.config;
  const config = await oidc.discovery(new URL(c.issuer), c.clientId, unseal(c.clientSecretEnc), undefined, {
    [oidc.customFetch]: safeFetch(fetchOpts()) as unknown as oidc.CustomFetch,
    // ID token signatures are checked against the provider's published keys as well: the spec lets clients rely on
    // TLS to the token endpoint instead, but checking costs one cached key fetch and covers a misrouted token endpoint
    execute: [...(env().OIDC_ALLOW_HTTP_ISSUERS ? [oidc.allowInsecureRequests] : []), oidc.enableNonRepudiationChecks],
    timeout: 10,
  });
  configs.set(key, { at: Date.now(), config });
  return config;
}

// checks the provider answers its discovery document; returns a readable problem or null
export async function testDiscovery(issuer: string): Promise<string | null> {
  try {
    await oidc.discovery(new URL(issuer), "connection-test", undefined, undefined, {
      [oidc.customFetch]: safeFetch(fetchOpts()) as unknown as oidc.CustomFetch,
      execute: env().OIDC_ALLOW_HTTP_ISSUERS ? [oidc.allowInsecureRequests] : [],
      timeout: 10,
    });
    return null;
  } catch (e) {
    if (e instanceof UnsafeTargetError) return e.message;
    return `Couldn't read ${issuer}/.well-known/openid-configuration (${(e as Error).message}).`;
  }
}

export async function saveConnection(ctx: TenantCtx, input: z.output<typeof connectionSchema>) {
  const p = ctx.principal;
  authorize(p, "security.manage");
  const issuer = issuerFor(input.provider, input.issuerInput);
  const problem = await testDiscovery(issuer);
  if (problem) throw new ValidationError(problem, "issuerInput");
  return tenantTx(ctx, async (tx) => {
    const [existing] = await tx.select().from(ssoConnections).where(eq(ssoConnections.orgId, p.orgId));
    if (!existing && !input.clientSecret) throw new ValidationError("Enter the client secret.", "clientSecret");
    let jitRoleId: string | null = null;
    let jitPropertyId: string | null = null;
    if (input.jitRoleId) {
      const [r] = await tx.select().from(roles).where(and(eq(roles.id, input.jitRoleId), sql`(${roles.orgId} is null or ${roles.orgId} = ${p.orgId})`));
      if (!r || r.category !== "staff" || r.key === "org_admin") throw new ValidationError("Choose a staff role.", "jitRoleId");
      if (!r.permissions.every((x) => p.permissions.has(x))) throw new ForbiddenError("You can't grant a role with more access than your own.");
      jitRoleId = r.id;
      if (r.scopeLevel === "scoped") {
        if (!input.jitPropertyId) throw new ValidationError("Choose the property new people get.", "jitPropertyId");
        const [prop] = await tx.select({ id: properties.id }).from(properties).where(and(eq(properties.id, input.jitPropertyId), eq(properties.orgId, p.orgId)));
        if (!prop) throw new ValidationError("Property not found.", "jitPropertyId");
        jitPropertyId = prop.id;
      }
    }
    const values = {
      provider: input.provider, issuer, clientId: input.clientId,
      clientSecretEnc: input.clientSecret ? seal(input.clientSecret) : existing!.clientSecretEnc,
      jitRoleId, jitPropertyId, status: existing?.status ?? "active",
    };
    const [row] = existing
      ? await tx.update(ssoConnections).set(values).where(eq(ssoConnections.id, existing.id)).returning()
      : await tx.insert(ssoConnections).values({ ...values, orgId: p.orgId, createdByUserId: p.userId }).returning();
    // the secret never goes into the audit log
    await auditAs(tx, ctx, existing ? "sso.connection_updated" : "sso.connection_created", "sso_connection", row.id,
      existing ? { provider: existing.provider, issuer: existing.issuer, clientId: existing.clientId, jitRoleId: existing.jitRoleId } : undefined,
      { provider: row.provider, issuer: row.issuer, clientId: row.clientId, jitRoleId, secretChanged: !!input.clientSecret });
    return row.id;
  });
}

export async function setConnectionStatus(ctx: TenantCtx, status: "active" | "disabled") {
  const p = ctx.principal;
  authorize(p, "security.manage");
  return tenantTx(ctx, async (tx) => {
    const [c] = await tx.select().from(ssoConnections).where(eq(ssoConnections.orgId, p.orgId));
    if (!c) throw new NotFoundError();
    await tx.update(ssoConnections).set({ status }).where(eq(ssoConnections.id, c.id));
    // switching SSO off also lifts the requirement, or staff couldn't sign in at all
    if (status === "disabled") await tx.update(orgSecurityPolicies).set({ requireSso: false, updatedByUserId: p.userId }).where(eq(orgSecurityPolicies.orgId, p.orgId));
    await auditAs(tx, ctx, `sso.connection_${status === "active" ? "enabled" : "disabled"}`, "sso_connection", c.id);
  });
}

/* ───────────── verified domains ───────────── */

export async function addDomain(ctx: TenantCtx, raw: string) {
  const p = ctx.principal;
  authorize(p, "security.manage");
  const n = normalizeDomain(raw);
  if ("error" in n) throw new ValidationError(n.error, "domain");
  return tenantTx(ctx, async (tx) => {
    const [mine] = await tx.select().from(ssoDomains).where(and(eq(ssoDomains.orgId, p.orgId), eq(ssoDomains.domain, n.domain)));
    if (mine) throw new ValidationError("That domain is already listed.", "domain");
    const [row] = await tx.insert(ssoDomains).values({ orgId: p.orgId, domain: n.domain, verificationToken: generateToken(18) }).returning();
    await auditAs(tx, ctx, "sso.domain_added", "sso_domain", row.id, undefined, { domain: n.domain });
    return row;
  });
}

export type TxtResolver = (name: string) => Promise<string[][]>;
const systemTxt: TxtResolver = (name) => dns.resolveTxt(name);

// looks up the TXT record; a domain can be verified by only one organization
export async function verifyDomain(ctx: TenantCtx, id: string, resolveTxt: TxtResolver = systemTxt): Promise<{ verified: boolean; message: string }> {
  const p = ctx.principal;
  authorize(p, "security.manage");
  const [d] = await tenantTx(ctx, (tx) => tx.select().from(ssoDomains).where(and(eq(ssoDomains.id, id), eq(ssoDomains.orgId, p.orgId))));
  if (!d) throw new NotFoundError();
  if (d.verifiedAt) return { verified: true, message: `${d.domain} is verified.` };
  let records: string[] = [];
  let problem: string | null = null;
  try {
    records = (await resolveTxt(domainRecordName(d.domain))).map((parts) => parts.join(""));
  } catch (e) {
    problem = (e as NodeJS.ErrnoException).code === "ENOTFOUND" || (e as NodeJS.ErrnoException).code === "ENODATA" ? "The TXT record isn't there yet (DNS changes can take a while)." : "DNS lookup failed. Try again in a few minutes.";
  }
  const found = records.includes(domainRecordValue(d.verificationToken));
  if (!found && !problem) problem = "A TXT record exists, but it doesn't contain this verification value.";
  // another organization verified it first: verified_uq stops a second claim
  const claimed = found ? await withContext({ system: true }, (tx) => tx.select({ id: ssoDomains.id }).from(ssoDomains).where(and(eq(ssoDomains.domain, d.domain), isNotNull(ssoDomains.verifiedAt)))) : [];
  if (claimed.length) problem = "Another organization has already verified this domain.";
  return tenantTx(ctx, async (tx) => {
    await tx.update(ssoDomains).set({ lastCheckedAt: new Date(), lastCheckError: problem, verifiedAt: found && !problem ? new Date() : null }).where(eq(ssoDomains.id, id));
    if (found && !problem) await auditAs(tx, ctx, "sso.domain_verified", "sso_domain", id, undefined, { domain: d.domain });
    return found && !problem ? { verified: true, message: `${d.domain} is verified.` } : { verified: false, message: problem! };
  });
}

export async function removeDomain(ctx: TenantCtx, id: string) {
  const p = ctx.principal;
  authorize(p, "security.manage");
  return tenantTx(ctx, async (tx) => {
    const [d] = await tx.delete(ssoDomains).where(and(eq(ssoDomains.id, id), eq(ssoDomains.orgId, p.orgId))).returning();
    if (!d) throw new NotFoundError();
    await auditAs(tx, ctx, "sso.domain_removed", "sso_domain", id, { domain: d.domain });
  });
}

/* ───────────── sign-in ───────────── */

type ConnRow = typeof ssoConnections.$inferSelect;

// by email domain (sign-in page) or organization slug (an organization that requires SSO)
export async function findConnection(by: { email?: string; orgSlug?: string; connectionId?: string }): Promise<ConnRow | null> {
  return withContext({ system: true }, async (tx) => {
    if (by.connectionId) return (await tx.select().from(ssoConnections).where(and(eq(ssoConnections.id, by.connectionId), eq(ssoConnections.status, "active"))))[0] ?? null;
    if (by.orgSlug) {
      // organizations aren't visible to the system context: resolve the slug the way worker jobs do
      const slug = by.orgSlug;
      const [org] = await withContext({ platformAdmin: true }, (ptx) => ptx.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)));
      if (!org) return null;
      return (await tx.select().from(ssoConnections).where(and(eq(ssoConnections.orgId, org.id), eq(ssoConnections.status, "active"))))[0] ?? null;
    }
    if (by.email) {
      const [r] = await tx.select({ c: ssoConnections }).from(ssoDomains).innerJoin(ssoConnections, eq(ssoConnections.orgId, ssoDomains.orgId))
        .where(and(eq(ssoDomains.domain, emailDomain(by.email)), isNotNull(ssoDomains.verifiedAt), eq(ssoConnections.status, "active")));
      return r?.c ?? null;
    }
    return null;
  });
}

// builds the identity provider URL for a sign-in (or a re-confirmation) and remembers state, nonce and PKCE verifier
export async function startSsoLogin(c: ConnRow, opts: { next?: string | null; loginHint?: string | null; reauthUserId?: string | null }): Promise<string> {
  const config = await oidcConfig(c);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  await db().insert(ssoLoginStates).values({
    id: hashToken(state), connectionId: c.id, nonce, codeVerifier, purpose: opts.reauthUserId ? "reauth" : "login",
    userId: opts.reauthUserId ?? null, next: safeNext(opts.next ?? null), expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });
  const params: Record<string, string> = {
    redirect_uri: ssoCallbackUrl(), scope: "openid email profile", state, nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: "S256",
  };
  if (opts.loginHint) params.login_hint = opts.loginHint;
  if (opts.reauthUserId) Object.assign(params, { prompt: "login", max_age: "0" }); // a fresh sign-in, not a remembered one
  return oidc.buildAuthorizationUrl(config, params).href;
}

export type SsoOutcome =
  | { kind: "session"; token: string; next: string | null; orgSlug: string }
  | { kind: "reauth"; next: string | null };

// the identity provider sent the browser back: check everything, then sign in (or re-confirm) the person
export async function completeSsoLogin(callbackUrl: URL, meta: RequestMeta | null, current: { sessionId: string; userId: string } | null): Promise<SsoOutcome> {
  const state = callbackUrl.searchParams.get("state");
  if (!state) throw new SsoError("incomplete");
  const [st] = await db().delete(ssoLoginStates).where(and(eq(ssoLoginStates.id, hashToken(state)), gt(ssoLoginStates.expiresAt, new Date()))).returning();
  if (!st) throw new SsoError("expired");
  if (callbackUrl.searchParams.get("error")) throw new SsoError("declined");
  const c = await findConnection({ connectionId: st.connectionId });
  if (!c) throw new SsoError("disabled");
  let claims: oidc.IDToken;
  try {
    const tokens = await oidc.authorizationCodeGrant(await oidcConfig(c), callbackUrl, { pkceCodeVerifier: st.codeVerifier, expectedNonce: st.nonce, expectedState: state, idTokenExpected: true });
    claims = tokens.claims()!;
  } catch (e) {
    log.warn("sso.callback_rejected", { connectionId: c.id, err: (e as Error).message });
    throw new SsoError("unverified_response");
  }
  const rawEmail = typeof claims.email === "string" ? claims.email : typeof claims.preferred_username === "string" && claims.preferred_username.includes("@") ? claims.preferred_username : null;
  if (!rawEmail) throw new SsoError("no_email");
  if (claims.email_verified === false) throw new SsoError("email_unverified");
  const email = rawEmail.trim().toLowerCase();
  // only addresses on domains this organization proved it controls
  const [domain] = await withContext({ system: true }, (tx) => tx.select({ id: ssoDomains.id }).from(ssoDomains)
    .where(and(eq(ssoDomains.orgId, c.orgId), eq(ssoDomains.domain, emailDomain(email)), isNotNull(ssoDomains.verifiedAt))));
  if (!domain) throw new SsoError("domain_not_verified");
  const amr: AuthMethod[] = reportsMfa(claims.amr) ? ["sso", "sso_mfa"] : ["sso"];

  if (st.purpose === "reauth") {
    if (!current || current.userId !== st.userId) throw new SsoError("reauth_required");
    const [u] = await db().select({ email: users.email }).from(users).where(eq(users.id, current.userId));
    if (u?.email !== email) throw new SsoError("wrong_account");
    await markReauthenticated(current.sessionId, current.userId);
    return { kind: "reauth", next: st.next };
  }

  // the person: an existing account with this email, or a new one (no password: they sign in through SSO)
  let [user] = await db().select().from(users).where(eq(users.email, email));
  if (user && user.status !== "active") throw new SsoError("deactivated");
  if (!user) {
    const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 100) : email.split("@")[0];
    [user] = await db().insert(users).values({ email, name, emailVerifiedAt: new Date() }).onConflictDoNothing().returning();
    if (!user) [user] = await db().select().from(users).where(eq(users.email, email));
  } else if (!user.emailVerifiedAt) {
    await db().update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
  }

  const orgSlug = await withContext({ orgId: c.orgId, userId: user.id, system: true }, async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, c.orgId));
    if (!org || org.status !== "active") throw new SsoError("org_inactive");
    const [m] = await tx.select().from(memberships).where(and(eq(memberships.orgId, c.orgId), eq(memberships.userId, user.id)));
    if (m && m.status !== "active") throw new SsoError("membership_off");
    if (!m) {
      if (!c.jitRoleId) throw new SsoError("not_member");
      const [role] = await tx.select().from(roles).where(eq(roles.id, c.jitRoleId));
      if (!role) throw new SsoError("not_member");
      await assertWithinLimit(tx, c.orgId, "staff_seats").catch(() => {
        throw new SsoError("no_seats");
      });
      const [nm] = await tx.insert(memberships).values({ orgId: c.orgId, userId: user.id, roleId: role.id, status: "active" }).returning();
      if (role.scopeLevel === "scoped" && c.jitPropertyId) await tx.insert(membershipScopes).values({ orgId: c.orgId, membershipId: nm.id, propertyId: c.jitPropertyId });
      await writeAudit(tx, { orgId: c.orgId, actorUserId: user.id, action: "member.joined_via_sso", entityType: "membership", entityId: nm.id, after: { role: role.key, propertyId: c.jitPropertyId } }, meta);
    }
    await tx.update(ssoConnections).set({ lastLoginAt: new Date() }).where(eq(ssoConnections.id, c.id));
    await writeAudit(tx, { orgId: c.orgId, actorUserId: user.id, action: "user.sso_signed_in", entityType: "user", entityId: user.id, after: { amr } }, meta);
    return org.slug;
  });
  await db().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  const token = await createSession(user.id, meta, { amr, ssoConnectionId: c.id });
  return { kind: "session", token, next: st.next, orgSlug };
}

// housekeeping: abandoned sign-ins
export async function purgeSsoStates(): Promise<number> {
  const r = await db().delete(ssoLoginStates).where(sql`${ssoLoginStates.expiresAt} < now()`).returning({ id: ssoLoginStates.id });
  return r.length;
}

export const _test = { clearConfigCache: () => configs.clear() };
