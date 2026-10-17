# Iteration 1 — Application foundation

_Completed 2026-09-25_

## What was built

- **Authentication:** registration with email verification (required before sign-in), sign-in, sign-out, forgot/reset password (resets revoke every session), change password (revokes other sessions), TOTP two-factor with QR enrollment and 10 single-use recovery codes, server-side sessions (hashed tokens, 30-day sliding expiry, `__Host-` Secure cookies in production), active-session list with per-device sign-out, login history, new-device detection with email alert, per-IP and per-email rate limits, anti-enumeration responses.
- **Organizations:** create org (creator becomes admin), globally unique slugs, org picker/switcher, settings (name, time zone), suspension by platform admin.
- **RBAC:** 54 permissions, 16 system roles (all roles in the brief), four scope levels (org-wide, scoped to portfolio/property/building, occupant = own unit, assigned = vendor jobs). One `authorize()` decision point; cross-org resources return 404.
- **Invitations & members:** invite by email with role and property scope, accept as new or existing user, revoke, change role, deactivate/reactivate; guards against privilege escalation, self-demotion and removing the last admin.
- **Tenant isolation:** Postgres RLS on every tenant table for a non-superuser runtime role; explicit org filters in services as a second layer.
- **Audit log:** append-only, same-transaction writes, secrets redacted, viewer with pagination.
- **UI:** design system (buttons, fields, panels, tables, badges, stats, empty states), responsive shell with permission-aware navigation and mobile drawer, role-aware dashboards backed by real data (portfolio KPIs, property table, activity; resident "your home"; empty state for vendors), account pages, platform admin console, dev mailbox.
- **Ops:** `/api/health`, structured JSON logging, request IDs, security headers + baseline CSP, Dockerfile (standalone, non-root), docker-compose (Postgres+pgvector, Mailpit, migrator, app), GitHub Actions CI.
- **Seed:** deterministic demo data for two orgs, repeatable.

## Database changes

`0000_init` (21 tables), `0001_rls_policies`, `0002_rls_strict_org_context` (fix for a cross-org membership leak found by manual testing; regression-tested).

## APIs added

`GET /api/health`. All other mutations are Server Actions (POST, same-origin checked by Next.js). Public REST API is Iteration 10.

## AI capabilities added

None yet (by plan). The principal, `authorize()`, tenant-scoped transactions and audit fields (`ai_generated`, `approval_id`) that the AI layer will use are in place.

## Tests

- Unit (48): authorization matrix, role catalog invariants, AES-GCM, argon2id + password policy, TOTP + recovery codes, rate limiter, open-redirect guard, email escaping, slugs.
- Integration (61, real Postgres as the runtime role): RLS on every table, cross-org read/write/move/audit-tamper attempts, no-context reads, membership-leak regression, auth flows (verification, sessions, lockout, reset, password change, MFA, new-device), org creation, scoped visibility, invitations, member management guards, cross-org admin attempts, suspension.
- E2E (10, Playwright): redirect-and-return, generic login error, register → verify → create org → invite → invitee joins, MFA enroll + sign-in, admin vs PM visibility, 404s for admin pages/cross-tenant/platform admin, resident on mobile.

## Known issues / limitations

- Rate limiter is in-memory (per instance). Redis adapter planned.
- Docker images were written but not built in this environment (no Docker daemon available); the standalone server they run was verified directly.
- CSP allows `'unsafe-inline'` scripts; nonce-based CSP is planned for hardening.
- Common-password check uses a small built-in list, not a breached-password corpus.
- Users table has no RLS (needed for login lookup); access is only through the auth service.
- No custom roles UI yet (table supports org roles).
- Resident and vendor invitations need the resident/vendor records from Iterations 2–3.
