# [YOUR PRODUCT NAME]

AI-native operations platform for property managers, strata/HOAs, facility teams, concierge desks and residents. The assistant, **[YOUR AI ASSISTANT NAME]**, acts through typed, permission-checked tools with approvals and a full audit trail (arriving in Iterations 6–8).

> **Status: Iteration 2 of 13 complete.**
> - **Iteration 1 — foundation:** authentication with MFA, organizations, role-based access scoped to portfolio/property/building/unit, Postgres row-level-security tenant isolation, invitations, settings, audit log.
> - **Iteration 2 — portfolio core:** portfolios, properties, buildings (stacking plan, bulk unit generation), floors, units, residents (move-in/out history, resident-app invites), staff directory, vendors (contacts, property approvals, vendor-portal invites), permission-aware full-text search and a Cmd/Ctrl-K command palette.
>
> See [`docs/roadmap.md`](docs/roadmap.md) and [`docs/iterations/`](docs/iterations/).

## Architecture in one paragraph

A modular monolith: **Next.js 16** (App Router, React 19, TypeScript) serves the UI, server actions and REST routes. Domain services in `src/server/modules/*` take a `TenantCtx` (the acting **Principal**) and run every query inside `withContext()`, which pins the Postgres transaction to one organization. **PostgreSQL 16 row-level security** enforces tenant isolation for the least-privilege runtime role, independent of application code. **Drizzle ORM** provides typed queries and SQL migrations. Details: [`docs/architecture.md`](docs/architecture.md), [`docs/ai-architecture.md`](docs/ai-architecture.md), [`docs/database-schema.md`](docs/database-schema.md).

```
src/
  app/                 routes: (auth) pages, /orgs, /onboarding, /o/[orgSlug]/…, /account, /admin, /api/health
  components/          ui/ design system, shell/ navigation, ops/ timeline, attachments, status forms, bar lists
  config/              brand placeholders, navigation
  server/
    auth/              passwords (argon2id), sessions, TOTP MFA, rate limiting, crypto
    authz/             permission catalog, system roles, authorize()
    db/                Drizzle schema, pooled client, withContext() for RLS
    modules/           organizations, members, portfolio, people, vendors, search,
                       maintenance (rules, triage, SLA, config), tasks, inspections, incidents, complaints,
                       notifications (outbox delivery, inbox, preferences), ops (timeline, counters, KPIs)
                       scope.ts: SQL scope filters, search-query sanitizer, pagination
    files/             upload sniffing, BlobStore (local | S3), permission-checked downloads
    worker.ts          background tick: SLA monitor + outbox delivery (in-process or `npm run worker`)
    mail/              Mailer (console | SMTP) + templates
    audit.ts           audit writer (same transaction as the change)
drizzle/               SQL migrations (incl. RLS policies)
scripts/               migrate, seed (+ seed-ops), reset, worker
tests/                 integration (real Postgres), e2e (Playwright); unit tests live next to code
docs/                  research, requirements, architecture, AI design, schema, roadmap
```

## Prerequisites

- Node.js **20.9+** (22 recommended)
- PostgreSQL **16** (the Docker image includes pgvector for later iterations)
- or just **Docker** with Compose v2

## Quick start with Docker

```bash
cp .env.example .env
# put a key in .env:  APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
docker compose up --build
```

- App: http://localhost:3000 (demo accounts are listed on the sign-in page)
- Email inbox (Mailpit): http://localhost:8025
- The `migrate` service runs migrations and seeds demo data once, then exits (`SEED_DEMO=false` to skip seeding).

## Local development without Docker

1. **Create the two database roles.** The runtime role must *not* be a superuser or have `BYPASSRLS`, otherwise row-level security doesn't apply.

   ```sql
   CREATE ROLE propai LOGIN PASSWORD 'propai';                              -- schema owner (migrations)
   CREATE ROLE propai_app LOGIN PASSWORD 'propai_app' NOSUPERUSER NOBYPASSRLS; -- runtime
   CREATE DATABASE propai OWNER propai;
   CREATE DATABASE propai_test OWNER propai;                                -- integration tests
   ```

2. **Configure and install**

   ```bash
   cp .env.example .env                      # then set APP_ENCRYPTION_KEY
   npm install
   npm run db:migrate                        # migrations + permission/role sync + grants to propai_app
   npm run db:seed                           # demo data (safe to re-run)
   npm run dev                               # http://localhost:3000
   ```

3. Emails (verification, reset, invitations) are captured at **http://localhost:3000/dev/mailbox** when `MAIL_PROVIDER=console`.

`npm run db:reset` drops the schema, re-migrates and re-seeds (refuses to run with `NODE_ENV=production`).

## Demo accounts (development/demo only)

Password for every account: `DemoPass!2026`. These are created by `npm run db:seed` and must never exist in production.

| Email | Role | What they can see |
|---|---|---|
| `admin@demo.test` | Organization Admin (Pacific Properties) + Council Member (Northshore) | Everything in Pacific; demonstrates org switching |
| `pm@demo.test` | Property Manager | Harbour Centre + Fraser Towers only |
| `facility@demo.test` | Facility Manager | "Mixed-Use & Commercial" portfolio (Fraser Towers) |
| `staff@demo.test` | Maintenance Staff | Harbour Centre, Main Tower building only |
| `concierge@demo.test` | Concierge | Fraser Towers |
| `council@demo.test` | Strata Council Member | Pacific Heights |
| `resident@demo.test` | Resident | Own unit: Fraser Towers, Tower B #1204 |
| `vendor@demo.test` | Vendor (linked to Blake Plumbing & Heating) | Only work orders assigned to their company |
| `admin@northshore.test` | Organization Admin (Northshore Strata) | Second tenant, used to prove isolation |
| `superadmin@demo.test` | Platform super admin | `/admin` console |

Demo org **Pacific Properties Management**: 4 properties (Harbour Centre, Pacific Heights, Fraser Towers, Kingsway Residences) in 2 portfolios, 6 buildings, 339 units, ~570 residents (incl. move-out history), 8 vendors with contacts and property approvals, staff profiles — plus ~175 work orders over 90 days (with SLA history, costs and timelines), SLA targets and 9 triage rules, 12 tasks, 3 inspection templates and 8 inspections, 12 incidents, 23 complaints and notifications. Data is deterministic.

Things to try:

- **The maintenance loop:** sign in as `resident@demo.test` → *Report a problem* → title "Water spreading under my sink" → the triage rules make it an urgent emergency, assign Blake Plumbing, and show the configured "what to do now" guidance. Then sign in as `vendor@demo.test` to see only that company's jobs, start and complete it (resolution notes required), and as the resident again to see the notification bell and the outcome.
- `pm@demo.test` → dashboard KPIs (open, overdue, SLA met, response time, spend — all computed from rows in their two properties), *Maintenance → Overdue*, assign staff or an approved vendor (★ marks matching trades), internal vs vendor vs public comments, *Organization → Maintenance rules* for SLA targets and triage rules.
- `facility@demo.test` → *Inspections* → schedule from a template, fail an item, complete and sign, then turn the failure into a follow-up work order.
- Press **Ctrl/Cmd-K** for navigation and quick actions ("Create work order", "Show overdue work orders", "Report incident"…); sign in as `pm@demo.test` and notice Pacific Heights has disappeared everywhere.

## Tests

```bash
npm run test:unit          # pure logic: authorization, crypto, TOTP, rate limits, templates…
npm run test:integration   # real Postgres (propai_test): resets, migrates from empty, seeds twice, then tests
npm run test:e2e           # Playwright against `npm run dev` (starts it if not running)
npm run lint && npm run typecheck && npm run build
```

Integration tests connect as the **runtime role** and prove tenant isolation at the database level (cross-org reads, writes, moves and audit tampering all fail). Override the test database with `TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL`.

E2E notes: sign-in is rate-limited per IP, so the Playwright web server is started with `RATE_LIMITS=relaxed` (ignored in production). If you reuse your own dev server, start it with that variable. To use a pre-installed Chromium, set `PW_CHROMIUM_PATH`.

## Environment variables

See [`.env.example`](.env.example). Required: `DATABASE_URL`, `APP_ENCRYPTION_KEY`; `MIGRATION_DATABASE_URL` for migrate/seed. `TRUST_PROXY=true` only behind a reverse proxy that sets `X-Forwarded-For`.

- **Attachments:** `FILE_STORAGE=local` (default; files under `FILE_STORAGE_DIR`, default `./.data/uploads`, a named volume in Docker) or `FILE_STORAGE=s3` with `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT` for MinIO/R2, and credentials from the standard AWS chain.
- **Background worker:** notification delivery and the SLA monitor run in-process every `WORKER_INTERVAL_MS` (30 s). For several app instances, set `DISABLE_INPROCESS_WORKER=true` on them and run one `npm run worker` process.

## Production deployment (current state)

1. Build the image: `docker build --target runner -t yourapp:TAG .` (Next.js standalone server, non-root, healthcheck on `/api/health`).
2. Run migrations as a release step: `docker build --target migrator -t yourapp-migrate:TAG .` with `MIGRATION_DATABASE_URL` (owner) and `DATABASE_URL` (runtime role, used to grant privileges). Do **not** set `SEED_DEMO` in production.
3. Run the app with the **runtime role** URL, a unique `APP_ENCRYPTION_KEY` from your secret manager, `MAIL_PROVIDER=smtp`, `APP_URL` set to your HTTPS origin, behind TLS. Cookies are `__Host-` prefixed and `Secure` in production.
4. Use managed Postgres with point-in-time recovery. A full production runbook (backups, monitoring, key rotation) is Iteration 13.

The in-memory rate limiter is per instance; run a single instance until the Redis adapter lands. With local file storage, also keep a single instance (or switch to `FILE_STORAGE=s3`).

## AI and integrations configuration

Not active yet. The provider abstraction (`AI_PROVIDER=demo|anthropic|openai|google|openai-compatible`, `AI_MODEL`) arrives in Iteration 6, with a clearly labelled demo mode that works without an API key. Integration adapters (Stripe, email/SMS providers, calendars, accounting) arrive in Iteration 10. See `docs/ai-architecture.md` and `docs/architecture.md` §10.

## Rebranding

Replace the placeholders in `src/config/brand.ts` (product and assistant names) and the logo in `src/components/brand/logo.tsx`.
