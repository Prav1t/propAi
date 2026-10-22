# Threat model and security review — Iteration 11

This document records how the platform's security was reviewed in Iteration 11: what is protected, from whom, where the trust boundaries are, which controls apply at each, and what the review found. Every finding has a fix and a test that proves it, except the accepted risks listed at the end.

It describes engineering controls. It is not a certification. Whether a deployment meets a given law or standard depends on how the organization runs it.

## 1. Scope and method

**Scope:** the whole application as of `iteration-11`:

- Next.js pages, server actions and route handlers;
- services, the REST API, outgoing webhooks and integrations;
- single sign-on, the assistant and its tools;
- the background worker;
- the PostgreSQL schema with its row-level security, and file storage.

**Method:**

1. **Inventory of entry points:**
   - 18 server action files (about 170 actions);
   - 9 route handlers, including the new SSO, session and privacy-export routes;
   - the REST API route table;
   - the worker jobs.
2. **Read-through of the authorization path for each entry point:**
   - every action resolves the caller from the session, never from form input;
   - services check permission and scope on the record, not just the page;
   - row-level security pins every tenant transaction to one organization.
3. **Review of every context that bypasses that path** (`system`, `platformAdmin`, raw `db()`). Each system-context use is either:
   - a worker job; or
   - an organization-pinned lookup that runs after its own permission check (integrations, SSO, privacy).
4. **Automated attack suites** in `tests/security/` and `tests/e2e/security.spec.ts` (section 5), which keep the findings fixed.
5. **Dependency audit and a secret scan.**

## 2. Assets

| Asset | Where | Why it matters |
|---|---|---|
| Residents' personal data (names, contacts, units, vehicles, messages, visitor logs) | PostgreSQL | Privacy law, trust |
| Operational records (work orders, incidents, complaints, inspections) | PostgreSQL, object storage | Legal and insurance evidence |
| Credentials | `users`, `sessions`, `api_keys`, sealed columns | Account takeover |
| Integration and SSO secrets, webhook signing secrets | Sealed (AES-256-GCM with key ids) | Pivot into customers' other systems |
| Audit log | `audit_logs` (hash chain) | Accountability; must resist tampering |
| Organization configuration (roles, policies, SSO, billing) | PostgreSQL | Controls who can do what |
| Uploaded files | Object storage (private, signed URLs) | Often sensitive (IDs, leases, photos) |

## 3. Actors

**Untrusted:**

- anonymous internet users;
- people signed in to *another* organization;
- residents and vendors, who are signed in but have narrow rights;
- staff limited to some properties or buildings;
- a stolen session cookie or API key;
- a malicious or compromised identity provider configured by a customer;
- content written by users that later reaches the assistant (prompt injection).

**Trusted, but limited:**

- organization admins, within their own organization;
- platform admins;
- the worker;
- database owners, who are trusted but whose changes should be detectable afterwards.

## 4. Trust boundaries and controls (STRIDE)

### 4.1 Browser ↔ application (cookie sessions)

- **Spoofing:**
  - argon2id password hashes;
  - TOTP two-step verification, with each code accepted once (F-06);
  - per-IP and per-account rate limits, shared across instances through Redis;
  - client addresses taken only from trusted proxies (F-01);
  - opaque 256-bit session tokens stored as SHA-256 hashes;
  - `__Host-` cookies that are HttpOnly, Secure and SameSite=Lax;
  - sliding 30-day sessions with an absolute 90-day limit (F-07);
  - other sessions end on password and MFA changes (F-08);
  - new-device sign-in alerts.
- **Tampering / CSRF:**
  - Next.js checks Origin on server actions;
  - the proxy refuses cross-site and same-site-subdomain writes using Fetch Metadata and Origin (F-04);
  - API and provider webhooks are exempt because they use bearer or signature authentication.
- **Elevation:**
  - sensitive changes need a sign-in or confirmation from the last 10 minutes (F-09). These are: API keys, webhook secrets, integrations, SSO and security policy, privacy requests, member roles and status, billing, MFA enrolment and platform administration;
  - an organization's MFA/SSO policy is enforced on every request (section 4.5).
- **Information disclosure:**
  - pages return 404 for both "doesn't exist" and "not yours";
  - search and lists are filtered by scope;
  - files are served only through a permission-checked route, with a sandbox CSP and `nosniff`.
- **XSS:**
  - React escaping, and no `dangerouslySetInnerHTML` anywhere;
  - email templates escape every value;
  - CSV exports are formula-safe;
  - strict nonce-based CSP: no inline or `eval` scripts in production, `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and `upgrade-insecure-requests` when `APP_URL` is https (F-05). Every page renders per request so its scripts carry the nonce; only the icon and web manifest are static.
- **Other headers:** HSTS (production), COOP, CORP, X-Frame-Options, Referrer-Policy, Permissions-Policy.

### 4.2 Inside an organization (authorization)

- **Decision point:** a single function (`can`/`authorize`) checks permission plus scope (organization, portfolio, property, building, unit, own, assigned).
- **Database backstop:** row-level security on every table with an `org_id`. A test now fails if a new table is added without it.
- **Role changes:**
  - nobody can grant or modify a role with more permissions than their own;
  - a manager who isn't organization-wide can't grant organization-wide roles, can't grant properties they don't fully manage, and can't manage members outside their scope (F-03);
  - deleting a resident record never touches the same person's staff membership (F-02);
  - incoming residents get their unit on move-in day, not before (F-14).
- **Mass assignment:** forms and the API parse input through explicit schemas (unknown fields are dropped, and the API rejects them).

### 4.3 REST API (API keys)

- **Keys:**
  - `ak_<prefix>_<43 random chars>`, stored as SHA-256 hashes;
  - looked up by hash under a dedicated RLS policy;
  - never more powerful than their creator (re-checked on every request), and limited by scopes and properties.
- **Limits:** a per-key rate limit, and a per-IP limit on failed authentication.
- **Changes:** idempotency keys; every change is audited with the key's id.
- **Lapsed subscriptions:** read-only state returns 402.

### 4.4 Outbound requests (webhooks, chat/SMS integrations, OIDC discovery and tokens)

- **SSRF-safe fetch:**
  - https only;
  - every resolved address must be public (no loopback, private, link-local or metadata addresses, CGNAT or reserved ranges, and IPv4-mapped IPv6 forms are caught);
  - the connection is pinned to the vetted address (no DNS rebinding);
  - redirects are never followed;
  - time and size limits.
- **Coverage:** OpenID Connect discovery, key and token requests use the same fetch, because issuers are typed in by customers.
- **Secrets:**
  - webhook payloads are HMAC-signed with a timestamp;
  - signing secrets and credentials are sealed with key ids and can be rotated (F-10).

### 4.5 Identity providers (single sign-on)

- **The flow:**
  - authorization code flow with PKCE (S256), `state` and `nonce`;
  - the sign-in state is single use, expires after 10 minutes, and is stored server-side.
- **Token checks:**
  - ID token issuer, audience, expiry and nonce are checked;
  - its signature is also verified against the provider's published keys, beyond what the spec requires over TLS.
- **Who can sign in:**
  - only email addresses on domains the organization has proven it controls (DNS TXT), and only one organization per domain;
  - shared mailbox domains such as gmail.com can't be claimed;
  - the provider's `email_verified=false` is refused.
- **Just-in-time membership:** off unless an admin chooses a staff role, which must be no stronger than the admin's own.
- **Policy:**
  - organizations can require MFA (for staff or everyone) and/or SSO for staff;
  - enforced on every request, so it applies to sessions that are already open;
  - org admins are the break-glass exception to SSO, but then must use MFA;
  - an admin can't require MFA without having it themselves;
  - switching SSO off lifts the SSO requirement so nobody is locked out.
- **Error messages:** shown from fixed codes, never from text in the URL.

### 4.6 Assistant (LLM)

- **No direct database access:** the model calls typed tools that run the same services with the user's principal.
- **Approval for changes:** a change is only *prepared*; a person approves it, and it's re-checked at approval.
- **Data, not instructions:**
  - tool results are marked as data;
  - instructions inside records are ignored;
  - retrieved knowledge is filtered by permission.
- **Limits:** organization usage caps; read-only organizations can't act.
- **Privacy:** conversations are owner-only under row-level security. Privacy requests and retention reach them through the system context, after their own permission check.

### 4.7 Worker and system contexts

- **Organization-pinned work:** the `system` context is used for worker jobs and for lookups that must happen before a principal exists (SSO sign-in, provider webhooks). Each such use is pinned to one organization, or only enumerates.
- **Organization lookups:** organizations aren't visible to the system context. Enumerating them uses the platform context, as worker jobs already do.

### 4.8 Database, storage and logs

- **Database roles:**
  - the app role is neither superuser nor BYPASSRLS;
  - migrations run as a separate owner.
- **Audit log:**
  - append-only for the app (no UPDATE or DELETE grants);
  - an UPDATE trigger stops even the owner by accident;
  - each organization's entries form a SHA-256 hash chain kept by a trigger;
  - `audit_verify()` detects any edited, removed or reordered entry;
  - daily checkpoints are written to a table *and* to the application logs, as an external anchor (F-11);
  - retention can prune whole prefixes only, never less than a year, and records the boundary as a checkpoint.
- **Files:** stored privately and served through signed URLs or the permission-checked route.

### 4.9 Privacy

- **Personal data requests:**
  - per-person export (JSON; downloadable for 7 days; audited);
  - erasure by anonymization. Building records are kept without the person; the account is anonymized only when no other organization uses it;
  - legal holds block erasure and retention.
- **Retention:** settings for messages, visitor logs, parking evidence photos, assistant conversations and the audit log (minimum one year).
- **Consent:** email consent history is recorded when people change their notification choices.

## 5. Automated security tests

| Suite | What it proves |
|---|---|
| `tests/security/idor-sweep.test.ts` | 28 detail getters × 8 restricted roles: nothing outside a role's reach opens (personal links such as reporter, booker, assignee and inspector are the designed exceptions) |
| `tests/security/hardening.test.ts` | F-02, F-03, F-06–F-11, F-14, mass assignment, audit tampering detected, the app role can't alter the audit log, key rotation |
| `tests/security/sso.test.ts` | Against a local OIDC provider: sign-in; just-in-time membership; unverified domain; `email_verified=false`; tampered nonce, audience, issuer, expiry and signature; state replay and expiry; deactivated members; re-confirmation; policy enforcement; SSRF guard on discovery |
| `tests/security/privacy.test.ts` | The export holds only that person's data; access is limited to privacy managers; legal hold blocks erasure; erasure results; the shared account is kept; retention skips held people; consent history |
| `tests/integration/tenant-isolation.test.ts` | Cross-organization reads and writes on every tenant table; every `org_id` table has RLS |
| `tests/integration/redis-rate-limit.test.ts` | Limits are shared across instances, the window slides, and Redis-down falls back to per-instance limits |
| `src/server/client-ip.test.ts` | Forged `X-Forwarded-For` prefixes can't change the address used for rate limits |
| `tests/e2e/security.spec.ts` | Headers and per-response nonces; no CSP violations across the main pages; cross-site writes refused; no open redirect; the re-auth round trip; SSO in a real browser; privacy export and audit verification |

## 6. Finding log

| ID | Severity | Finding | Fix | Proven by |
|---|---|---|---|---|
| F-01 | Medium | The client IP came from the *leftmost* `X-Forwarded-For` entry (or `X-Real-IP` without a proxy), so anyone could forge it: per-IP sign-in, MFA, registration, reset and API-auth limits could be evaded, and audit, login-history and new-device IPs forged | `TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER`; take the entry the outermost trusted proxy appended; production warns when unset | `client-ip.test.ts` |
| F-02 | Medium | Deleting a resident record deactivated *every* membership the linked person had in the organization, so a resident manager could lock out a staff member or admin who also lives there | Only resident-category memberships are deactivated | `hardening.test.ts` |
| F-03 | Low (latent) | Member management compared permissions but not scope: a property-limited manager with `member.manage` could grant organization-wide roles and manage members anywhere. No system role combines these today | Scoped managers grant only scoped roles on properties they fully manage, and manage only members inside their scope | `hardening.test.ts` |
| F-04 | Low | CSRF protection relied on SameSite cookies and Next.js's Origin check, which lets requests without Origin through and doesn't cover route handlers | Fetch Metadata + Origin guard in the proxy for all cookie-authenticated writes | `security.spec.ts` |
| F-05 | Medium | CSP allowed `'unsafe-inline'` scripts, so an XSS bug would have been fully exploitable | Per-request nonce, `strict-dynamic`, no inline/eval scripts in production; every page renders per request | `security.spec.ts` |
| F-06 | Low | A TOTP code could be replayed within its ~90-second validity window | The last accepted time step is stored atomically; each code works once | `auth.test.ts`, `hardening.test.ts` |
| F-07 | Low | Sessions slid forever while used | Absolute limit (`SESSION_ABSOLUTE_DAYS`, default 90) | `hardening.test.ts` |
| F-08 | Low | Turning MFA on or off left other sessions signed in, so an attacker's session would survive enrolment | Other sessions end; the enrolling session is upgraded to two-step | `hardening.test.ts` |
| F-09 | Medium | A stolen or unattended session could create API keys, rotate secrets, connect integrations, change roles or billing | Recent sign-in (10 min) required, with a "Confirm it's you" page (password, code, or SSO with `prompt=login`) | `hardening.test.ts`, `security.spec.ts` |
| F-10 | Low | One encryption key and no way to rotate it | Keyring with key ids bound as AAD; `npm run keys:rotate` re-seals everything | `hardening.test.ts`, `keyring` unit tests |
| F-11 | Low | Audit entries were append-only for the app but could be changed by the database owner without trace | Per-organization hash chain, `audit_verify()`, immutability trigger, external checkpoints | `hardening.test.ts` |
| F-12 | High | Dependencies: Next.js 16.3.6 had published advisories (an SSRF in image optimization, cache poisoning, information disclosure); sharp had a librsvg CVE | Next.js 16.3.8; sharp 0.35.5 (override) | `npm run security:audit` (production gate) |
| F-14 | Medium | Future occupants (move-in date ahead) got the unit's access at once, so an incoming tenant could see the current household's packages, visitors and requests and receive their notifications | Occupancy counts from move-in day in the principal and in notification recipients | `hardening.test.ts` |

**Found and fixed while building this iteration (never released):**

- the SSO organization lookup ran in a context that can't see organizations;
- privacy erasure checked other memberships in the wrong context, and would have anonymized an account another organization still used;
- retention for assistant conversations would have deleted nothing (owner-only RLS);
- OIDC ID tokens were accepted without a signature check over plain-http test providers (signature verification is now always on).

**Reviewed with no finding:**

- cross-organization isolation (RLS sweep over every tenant table);
- raw SQL, which only wraps constant column names from the metric catalog;
- XSS sinks (none) and email templates (escaped);
- open redirects (`safeNext`, tested);
- upload handling (content sniffing, size limits, safe names, private storage);
- API key entropy and storage;
- webhook signing;
- assistant tool permissions and approvals.

## 7. Accepted risks and limits

- **`style-src 'unsafe-inline'`:** React style attributes need it. CSS injection without script execution is a much smaller risk than script injection.
- **Identity tables** (`users`, `sessions`, MFA, email tokens, login events) have no row-level security. They aren't tenant data; only the authentication code reads them.
- **Deployments without a reverse proxy** (`TRUSTED_PROXY_HOPS=0`) can't know the real client address. Production should set it; the app warns at start-up.
- **Development-only advisories** (Vite and esbuild dev servers, launch-editor) don't run in production. The CI gate is on production dependencies (`--omit=dev`), and all dependencies are checked at `critical`.
- **mammoth → argparse/sprintf-js:** the advisory's code path is mammoth's command-line interface, which the app doesn't use.
- **External verification gaps:**
  - SSO is verified against a local OpenID Connect provider, not live Google, Entra or Okta tenants;
  - DNS verification is verified with a stubbed resolver (no outbound DNS in this environment).
- **GitHub Actions are pinned to version tags, not commit SHAs.** The SHAs couldn't be looked up from this environment, so pinning them is a follow-up.
- **No external penetration test yet.** This review and its test suites are internal.
