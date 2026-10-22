# Iteration 11 — Security hardening

The goal was for every critical or high finding to be fixed and proven by a test, and for the controls an enterprise security review asks for to exist. The review and its finding log are in [`docs/security/threat-model.md`](../security/threat-model.md).

## What was built

**Review and attack-style tests:**

- **Review:** the threat model covers assets, actors, nine trust boundaries with STRIDE, a finding log and accepted risks. It came from a route-by-route review covering:
  - 18 server action files and 9 route handlers;
  - the REST API;
  - every use of the system or platform context.
- **IDOR sweep:** 28 detail pages × 8 restricted roles (property-, building- and portfolio-scoped staff, residents, owners, a vendor) × records outside each role's reach. No leaks. The designed personal access paths (reporter, booker, submitter, inspector, assignee) are spelled out in the test.
- **Hardening suites:**
  - privilege escalation;
  - mass assignment;
  - tenant writes on the new tables, plus a check that fails if any table with an `org_id` lacks row-level security;
  - XSS and injection probes on markdown links, redirect targets and search input;
  - forged client addresses;
  - an end-to-end security spec (headers, CSP, cross-site writes, open redirects, re-confirmation, SSO, privacy, audit).

**Single sign-on and sign-in policy:**

- **Settings → Security** connects an OpenID Connect provider: Google Workspace, Microsoft Entra ID, Okta, or any issuer.
  - **Domains:** an organization proves it owns a domain with a DNS TXT record, and only one organization can hold a verified domain. Shared mailbox domains (gmail.com and similar) can't be claimed.
  - **Sign-in:** *Sign in with your organization (SSO)* finds the provider from the work email. The flow is authorization code with PKCE, state and nonce.
  - **Checks on the response:** the ID token's issuer, audience, expiry, nonce *and signature* are checked; an `email_verified=false` claim is refused.
  - **New people:** they can join automatically with a staff role the admin chooses (no stronger than the admin's own), or only invited members get in.
  - **Errors** are shown as fixed messages, never text from the URL.
- **Requirements:** organizations can require **two-step verification** for staff or everyone, and **SSO for staff**.
  - Checked on every request, so a change applies to people who are already signed in.
  - Org admins are the break-glass exception to SSO, but must then use MFA.
  - An admin can't require MFA without having it, and switching SSO off lifts the SSO requirement.
- **Confirm it's you:** sensitive changes need a sign-in or confirmation from the last 10 minutes; otherwise the person confirms (password, authenticator code, or an SSO round trip with `prompt=login`) and goes straight back. This covers:
  - API keys, webhook endpoints and secret rotation;
  - integrations;
  - security and SSO settings, privacy requests and retention;
  - member roles and status;
  - plan changes and cancellation;
  - MFA enrolment;
  - platform administration.

**Sessions and credentials:**

- **Sessions** record how they were established (password, authenticator code, recovery code, SSO, SSO with MFA). They slide while used, but end 90 days after sign-in (configurable).
- **TOTP codes work once:** the last accepted time step is stored atomically.
- **MFA changes:** turning MFA on or off signs out every other session; the enrolling session counts as two-step from then on.
- **Client addresses** come only from trusted proxies (`TRUSTED_PROXY_HOPS` or `CLIENT_IP_HEADER`); anything a client writes into `X-Forwarded-For` is ignored.
- **Shared rate limits on Redis** (`REDIS_URL`): a sliding window shared by every instance for sign-in, MFA, invitations, the assistant and API keys. If Redis is unreachable, each instance falls back to its own limits.
- **Encryption keys can be rotated:** sealed values name their key, and the key id is authenticated. `npm run keys:status` / `keys:rotate`, with the old key readable during a rotation.

**Browser protections:**

- **Strict CSP:** a fresh nonce per response, `strict-dynamic`, and no inline or `eval` scripts in production. Every page renders per request so its scripts carry the nonce. COOP, CORP and an expanded Permissions-Policy are added.
- **Cross-site writes are refused in the proxy** (Fetch Metadata and Origin), on top of Next.js's Origin check on server actions. The API and provider webhooks are exempt (bearer and signature authentication).

**Audit log:**

- **Hash chain:** each organization's entries form a SHA-256 chain kept by a database trigger. *Verify the audit log* recomputes it and names the first edited, missing or reordered entry; platform admins can verify every chain.
- **Immutability:** an UPDATE trigger stops even the table owner from editing entries by accident (the app role already had no UPDATE or DELETE).
- **Checkpoints:** written daily to a table and to the application logs, as an outside anchor.
- **Retention:** prunes only whole prefixes, never less than a year, and leaves a verifiable boundary.

**Privacy (Settings → Privacy):**

- **Export:** a resident's data as JSON, covering the profile, occupancies, requests, complaints, bookings, packages, visitors, vehicles, permits, messages (internal notes marked), notifications, consent history, assistant conversations, uploaded files and their activity. It's downloadable for 7 days, and every export and download is audited.
- **Erasure by anonymization:**
  - the resident record is scrubbed and unlinked;
  - plates and personal notes are redacted, and their messages become "[erased]";
  - their assistant chats and notifications are deleted;
  - their resident access ends, while the same person's staff access is untouched;
  - building records stay, without the name;
  - the shared account is anonymized only if no other organization uses it.
- **Legal holds** block erasure and retention.
- **Retention settings** (messages, visitor logs, parking evidence photos, assistant chats, audit log), applied nightly by the worker.
- **Consent history:** an append-only email consent record when someone changes their notification choices.

**Supply chain:**

- **Dependencies:**
  - Next.js 16.3.6 → **16.3.8**, which fixes the published advisories, including an SSRF in image optimization;
  - sharp, source-map-js and vite pinned to patched versions through overrides;
  - every upgrade is at least two weeks old, except vitest 5.0.5, a dev-only test runner (npm couldn't resolve an exact 5.0.3 pin).
- **Scanning in CI:**
  - `npm run security:audit` gates on high or critical advisories in production dependencies, and the whole tree is gated at critical;
  - `npm run security:secrets` scans tracked files for credentials;
  - gitleaks scans history;
  - a CycloneDX SBOM is produced as an artifact;
  - Redis is now a CI service.

## Files created/modified

- **Security core:**
  - `src/server/client-ip.ts`, `src/server/reauth.ts`, `src/server/org-session.ts`, `src/server/keyring.ts`, `src/server/keyring-rotation.ts`, `src/server/audit-integrity.ts`
  - `src/lib/security-policy.ts`, `src/lib/sso.ts`
- **Single sign-on and privacy:** `src/server/sso/{service,policy}.ts`, `src/server/privacy/service.ts`
- **Changed:**
  - auth: `src/server/auth/{service,crypto,totp,rate-limit}.ts`
  - request handling: `src/proxy.ts`, `src/server/{org-context,request-meta,http,form-action,env,worker}.ts`, `src/server/net/safe-fetch.ts`
  - services: `src/server/modules/{members,people,organizations/principal,community/residents,notifications}/…`
  - permissions: `src/server/authz/{permissions,system-roles}.ts`
- **Pages and routes:**
  - settings: `settings/security`, `settings/privacy` (+ `exports/[requestId]`), audit verification
  - account: `/account/confirm`
  - sign-in: `/sso`, `/sso/org/[orgSlug]`, `/sso/callback`, `/sso/reauth`, `/session/renew`
  - existing pages: SSO and MFA messages on sign-in, a required-MFA banner on Account → Security, platform audit verification
- **Database:** `drizzle/0023_security_privacy.sql` (generated), `drizzle/0024_rls_security_privacy.sql` (RLS, the audit chain functions and triggers)
- **Scripts and CI:** `scripts/rotate-keys.ts`, `scripts/secret-scan.ts`, `.github/workflows/ci.yml`, `.gitleaks.toml`, `docker-compose.yml` (Redis)
- **Tests:**
  - `tests/security/{idor-sweep,hardening,sso,privacy}.test.ts`, `tests/integration/redis-rate-limit.test.ts`
  - `tests/support/mock-oidc.ts`, `tests/e2e/{security.spec,db}.ts`
  - `src/server/{client-ip,keyring}.test.ts`, `src/lib/{security-policy,injection}.test.ts`
- **Docs:** `docs/security/threat-model.md`, README, architecture, database schema, AI architecture, roadmap

## Database changes

- **Migration `0023`:** tables `org_security_policies`, `sso_connections`, `sso_domains`, `sso_login_states`, `privacy_requests`, `legal_holds`, `retention_policies`, `consents`, `audit_chain_heads`, `audit_checkpoints`. New columns: `users.mfa_last_used_step`; `sessions.amr`, `reauth_at`, `sso_connection_id`; `audit_logs.seq`, `prev_hash`, `hash`.
- **Migration `0024`:**
  - RLS on the new tenant tables;
  - assistant conversations reachable by the system context within one organization (privacy and retention), still owner-only for people;
  - the audit hash chain: `audit_entry_hash`, the `audit_chain` trigger, the `audit_immutable` trigger, `audit_prune`, `audit_verify`;
  - existing audit entries backfilled into chains.
- **Privileges:** the app role can't write chain heads or change checkpoints.

## APIs added

- **Sign-in routes:**
  - `GET /sso/org/{orgSlug}` starts SSO for an organization;
  - `GET /sso/callback` is the redirect URI;
  - `GET /sso/reauth` re-confirms through the provider;
  - `GET /session/renew` signs in again when an organization starts requiring MFA.
- **Download:** `GET /o/{org}/settings/privacy/exports/{requestId}` serves the export (privacy managers, 7 days, audited).
- **Server actions:**
  - SSO start;
  - re-confirmation;
  - security policy, SSO connection and domains (add, verify, remove);
  - privacy export, erasure, legal holds and retention;
  - audit verification (organization and platform).
- **Permissions:** `security.manage`, `privacy.manage` (org admins).
- **REST API:** unchanged. It's exempt from the cross-site guard and still uses API keys.

## AI capabilities added

- **Sign-in policy:** the assistant stream enforces the organization's policy like every page.
- **Privacy:** assistant conversations are included in a person's export, deleted by erasure, and subject to retention, while staying owner-only for everyone else.
- **Prompt injection:** recorded as a trust boundary in the threat model. The controls are unchanged: tools run with the user's permissions, and changes are approved plans. The evaluation suite's injection case still passes.

## Tests added

- **Unit:**
  - `client-ip` (8): forged prefixes, hop counts, a custom header, IPv6 and port forms, X-Forwarded-Host;
  - `security-policy` (7): SSO/MFA decisions per role, other organizations' SSO, break-glass;
  - `keyring` (4): sealing, retired keys, v1 compatibility, authenticated key id;
  - `injection` (25): markdown links (`javascript:`, `data:`, protocol-relative, backslash), redirect targets, search operators.
- **Security integration:**
  - `idor-sweep` (28): 28 getters × 8 roles;
  - `hardening` (16): F-02, F-03, F-06–F-11, F-14, mass assignment, audit tamper detection, app-role limits, key rotation;
  - `sso` (18): a local OIDC provider; JIT; unverified domains; `email_verified=false`; tampered nonce, audience, issuer, expiry and signature; missing email; state replay and expiry; deactivated members; re-confirmation; policy; the SSRF guard on discovery;
  - `privacy` (5): export scope and access, legal hold, erasure results, a shared account kept, retention with a hold, consent history.
- **Other integration:**
  - `redis-rate-limit` (4): shared across instances, sliding window, reset, Redis-down fallback;
  - `tenant-isolation` (+9): seven new tables in the read sweep, the "every org_id table has RLS" guard, cross-organization writes on SSO and privacy tables;
  - `auth`: the TOTP test now also proves a replayed code is refused.
- **E2E** `security.spec.ts` (6): headers and per-response nonces with no CSP violations across main pages, cross-site writes refused, no open redirect, the re-confirmation round trip, SSO in a real browser (connect, sign in, then required), privacy export download and audit verification.

## Test results

All of these ran on the final code in this commit.

| Check | Result |
| --- | --- |
| Type check (`tsc --noEmit`) | clean |
| Lint | clean |
| Vitest (unit + integration + security) | **59 files, 941 tests passed**: unit 348 (+44), integration 593 (+80, including the four security suites) |
| Vitest with shuffled file order | passed with seeds 1111 and 2222 as well as the default order |
| Assistant evaluation (`npm run ai:eval`) | 32/32 |
| Secret scan (`npm run security:secrets`) | no secrets in the 573 files of this commit; also verified to catch planted test secrets |
| Dependency gate (`npm run security:audit`, high or above, production deps) | passes. 3 moderate advisories remain (mammoth → argparse / sprintf-js) and no fix is published yet |
| Production build | OK. Every page is rendered per request (nonce CSP); only the icon and manifest are static |
| E2E (Playwright, 12 batches on a freshly reset database) | **69 passed, 0 failed, 0 flaky** in 24.8 minutes: analytics + automation 7, assistant 6, assistant actions 8, auth 4, authorization 6, billing 3, community 6, front desk 6, knowledge 6, maintenance 6, portfolio 5, security 6 |

**Production smoke test** (`next start` on port 3100):

- the CSP has no `unsafe-eval`, and every script tag carries the response's nonce;
- HSTS, COOP, CORP, `X-Frame-Options` and `Permissions-Policy` are present;
- a cross-site form POST gets 403;
- `/sso` returns 200;
- `/sso/org/pacific-properties` redirects to `/login?sso_error=disabled`, because the demo organization has no connection;
- memory use was about 195 MB.

**Not tested:**

- SSO against a real provider (Okta, Entra ID, Google). The tests use a local OIDC provider that does real signing.
- DNS domain verification against real DNS. The tests use a stubbed resolver.
- An external penetration test.

## Bugs found and fixed during the iteration

The security findings (F-01–F-14) are in the threat model's finding log. These issues were found while building and testing, and never shipped:

- **Organization lookup for SSO** ran in a context that can't see organizations. Found by the SSO tests; it now uses the platform context, like the worker.
- **ID tokens with a foreign signature** were accepted when the provider was on plain http. The spec lets clients skip signature checks over TLS; signature verification is now always on.
- **Erasure checked "other organizations" in the wrong context** and would have anonymized an account another organization still used. Found by the privacy tests.
- **Retention for assistant conversations would have deleted nothing**, because conversations are owner-only under RLS. The policy now lets the system context reach them within one organization.
- **Privacy export files had a storage key with a dot**, which the storage layer refuses.
- **The E2E warm-up would have signed itself out** by visiting `/session/renew`; that route is now excluded.
- **`upgrade-insecure-requests` would break a production build served over plain http** (the Docker quick start on localhost). It's now sent only when `APP_URL` is https. Found by the production smoke test.
- **Order-dependent integration tests.** The new test files changed vitest's file order, which exposed three problems:
  - **A leftover amenity:** the community tests left a second "gym" at Fraser Towers, so the assistant's booking test became ambiguous. It's now switched off when that file ends.
  - **An event backlog:** the automation tests processed events in a fixed number of batches, so a backlog left by earlier files could hide their own run. They now clear the backlog first and process until nothing is left.
  - **An unreadable fixture:** the IDOR sweep's webhook fixture had an unreadable secret that broke key rotation. It's now properly sealed and removed afterwards.

  Every new suite cleans up what it creates, and the privacy retention test touches only decade-old fixtures. The full suite passes in vitest's default order and with two shuffled file orders.
