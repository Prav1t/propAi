# Architecture

_Iteration 0 design, updated Iteration 1 with what is actually built. Sections marked **(planned)** are not implemented yet._

## 1. Decisions at a glance

| Concern | Decision | Why |
|---|---|---|
| Shape | **Modular monolith** in one Next.js app, with domain modules under `src/server/modules/*` | One deployable, one DB, clear module seams. Split out workers/services when load demands, not before |
| Web framework | **Next.js 16 (App Router) + React 19 + TypeScript** | Server Components for data-heavy screens, Server Actions for forms, Route Handlers for the public REST API |
| Styling | **Tailwind CSS v4** + in-house component library in `src/components/ui` | No generic dashboard kit; consistent, accessible primitives |
| Forms | Server Actions + `useActionState` + **Zod** (shared schemas) | Progressive enhancement, one validation source. React Hook Form / TanStack Query are introduced where client-heavy interaction needs them (AI chat, calendars) |
| Database | **PostgreSQL 16** (+ **pgvector** from Iteration 8) | Relational core, RLS, JSONB, full-text search, vectors in one engine |
| ORM / migrations | **Drizzle ORM** + drizzle-kit SQL migrations | Pure TypeScript (no engine binaries), SQL-transparent, first-class raw SQL for RLS, FTS and pgvector. Chosen over Prisma for RLS/`set_config` ergonomics and zero native-binary downloads |
| Auth | Session-cookie auth built on vetted primitives: **argon2id** (`@node-rs/argon2`), CSPRNG tokens, SHA-256 token hashing, **TOTP** via `otplib`, AES-256-GCM for MFA secrets | Follows the OWASP session-management and Lucia-style guidance; no home-made crypto. OAuth/SSO adapters slot in beside the password provider (Iteration 11) |
| Jobs / events | Transactional **outbox table** + worker; queue = **pg-boss** (Postgres) first, Redis/BullMQ if throughput requires **(planned, Iteration 9)** | Keeps ops to one datastore early; outbox guarantees events are never lost on commit |
| Cache / rate limit | In-process limiter behind a `RateLimiter` interface now; Redis adapter when running >1 instance **(planned)** | Honest about current scale; interface avoids rewrite |
| Files | S3-compatible object storage (MinIO in dev), signed URLs, scanning hook **(planned, Iteration 4)** | Portable across AWS/GCP/Azure/on-prem |
| Email | `Mailer` interface: `console` (dev outbox table) and `smtp` providers; Resend/SendGrid adapters later | Works with zero config in dev; Mailpit in Docker |
| AI | Provider abstraction (Anthropic / OpenAI / Google / local) + typed tool registry + policy engine **(Iterations 6–8)**; see `ai-architecture.md` | |
| Deploy | Docker image (Next.js `standalone` output), Compose for dev; any container host in prod | Cloud-agnostic |

## 2. System context

```
 Browser / PWA ──HTTPS──▶  Next.js app (Node)
                           ├─ proxy.ts            request id, auth gate (optimistic)
                           ├─ app/ (RSC pages)     UI, server actions
                           ├─ app/api/*            REST API, health
                           └─ server/
                               ├─ auth/           sessions, passwords, MFA, tokens
                               ├─ authz/          permissions, roles, scopes, authorize()
                               ├─ db/             drizzle schema, withTenant(), RLS
                               ├─ modules/*       domain services (org, property, …)
                               ├─ audit/          audit log writer
                               ├─ mail/           Mailer adapters
                               └─ ai/             (planned) providers, tools, policy
                                      │
                      ┌───────────────┼──────────────────┐
                 PostgreSQL 16     Object storage     SMTP / providers
              (RLS, FTS, pgvector)   (planned)        (LLM, SMS, Stripe…)
```

### Module boundaries

Each domain module (`organizations`, `members`, `properties`, later `maintenance`, `amenities`, …) owns its tables and exposes service functions that take a **`TenantContext`** as the first argument. Modules call each other only through those service functions or through domain events — never by querying another module's tables directly. UI code (pages, server actions) calls services; it never builds SQL.

## 3. Request lifecycle

1. `proxy.ts` assigns `x-request-id`, and redirects to `/login` if a protected route has no session cookie (cheap, optimistic check only).
2. A page/action calls `requireUser()` → validates the session token against the DB (hash lookup, expiry, user status), slides expiry.
3. Org routes (`/o/[orgSlug]/…`) call `requireOrgContext(slug)` → loads membership, role permissions, scopes, occupancies → builds a **`Principal`**; returns 404 if not a member or org is suspended.
4. Services call `authorize(principal, permission, resource?)` and run queries inside `withTenant(ctx, tx => …)`, which opens a transaction and sets `app.org_id` / `app.user_id` for RLS.
5. Mutations write an **audit log** row in the same transaction.
6. Structured JSON log line with request ID, user ID, org ID, latency.

## 4. Data architecture

See `database-schema.md` for tables. Key rules:

- **UUID v4 primary keys** (`gen_random_uuid()`), `created_at`/`updated_at` `timestamptz`.
- Every tenant-owned table has `org_id uuid not null` + an index leading with `org_id`.
- Composite FKs are avoided for simplicity, but services always filter by `org_id` and RLS guarantees it.
- Soft delete only where there's a business reason (e.g. residents moving out → `ended_at`); otherwise hard delete + audit log with `before`.
- Enumerations are Postgres `text` + `CHECK` constraints (easier to evolve than `enum` types).

## 5. Tenant isolation (defense in depth)

| Layer | Mechanism |
|---|---|
| Routing | Org is resolved from the URL slug **and** checked against the user's active membership |
| Service | Every service function takes `TenantContext`; queries filter by `ctx.orgId` |
| Database | **Row-Level Security** on all tenant tables. The app connects as a non-owner role (`propai_app`) with no `BYPASSRLS`. Policies compare `org_id` to `current_setting('app.org_id')`, which `withTenant()` sets per transaction with `set_config(…, true)` (transaction-local, safe with pooling) |
| Tests | Integration tests connect as the app role and prove: org A context cannot read, update or delete org B rows even with raw SQL; cross-org IDs in service calls return not-found |
| Search / AI / files | (planned) all go through the same tenant-scoped services; vector search filters on `org_id` under RLS |

Migrations and seeds run as the owner role (bypasses RLS as table owner). The runtime app never holds owner credentials.

## 6. Authorization model

- **Permissions** are strings like `property.read`, `member.manage`, `workorder.assign`. The catalog is in `src/server/authz/permissions.ts`.
- **Roles** (DB rows) map to permission sets. System roles are seeded from code on every migrate so code and DB can't drift.
- **Scope level** per role: `org` (org-wide), `scoped` (limited to membership scopes: portfolio/property/building), `occupant` (limited to the user's units), `assigned` (vendor: only records assigned to their vendor company, Iteration 3).
- `authorize(principal, permission, resource)` checks: permission present → resource org matches → scope contains the resource's property/building → record-level rule (own / assigned) where applicable.
- Platform super admin is a flag on `users`, used only by `/admin`. Org admins can never reach platform admin.

## 7. Security baseline

Implemented in Iteration 1 unless marked planned:

- argon2id password hashing (memory 19 MiB, t=2, p=1 — OWASP minimum), common-password rejection.
- Session cookie `HttpOnly`, `Secure` (prod), `SameSite=Lax`, `__Host-` prefix in production; tokens hashed at rest.
- CSRF: Server Actions are POST-only with Next's built-in Origin/Host check; JSON API route handlers require same-origin `Origin` for cookie-authenticated mutations; API keys (Iteration 10) are header-based and CSRF-immune.
- Rate limiting on login, registration, password reset, MFA (per IP and per identifier).
- Security headers: HSTS (prod), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, baseline CSP.
- All input validated with Zod at the boundary; all SQL parameterised via Drizzle.
- Generic auth errors (no account enumeration on login / reset).
- Audit log for auth, membership and settings changes.
- Planned: SSRF-safe fetcher for webhooks (Iteration 10), file scanning (Iteration 4), secret rotation guide (Iteration 13).

## 8. Events (planned, Iteration 3+)

Domain events (`MaintenanceRequestCreated`, `PackageArrived`, `SlaBreached`, …) are written to an `outbox` table in the same transaction as the change. A worker delivers them to in-process subscribers (notifications, workflow engine, webhooks, AI insights). This gives at-least-once delivery without a broker. Subscribers must be idempotent (keyed on event ID).

## 9. Storage (planned, Iteration 4)

Private bucket; object keys `org/{orgId}/{module}/{uuid}`; metadata row in `files` with owner entity, MIME sniffed server-side, size limits per module, scan status. Downloads via short-lived signed URLs issued only after `authorize()`. Access logged.

## 10. Integrations (planned, Iteration 10)

`src/server/integrations/<kind>/<provider>.ts` implementing interfaces (`Mailer`, `SmsSender`, `PaymentProvider`, `CalendarSync`, `AccessControl`). Selection by env + per-org config. Credentials encrypted with the app encryption key.

## 11. Deployment

- **Dev:** `docker compose up` → Postgres (pgvector image), Mailpit, app. Or run Postgres yourself and `npm run dev`.
- **Prod:** build image with `Dockerfile` (multi-stage, `output: "standalone"`, non-root user). Run `npm run db:migrate` as a release step with the owner URL; run app with the least-privilege URL. Put behind a TLS-terminating proxy/load balancer. Managed Postgres with PITR backups.
- Health: `GET /api/health` (liveness + DB check).
