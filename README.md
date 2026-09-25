# [YOUR PRODUCT NAME]

AI-native operations platform for property managers, strata/HOAs, facility teams, concierge desks and residents. The assistant, **[YOUR AI ASSISTANT NAME]**, acts through typed, permission-checked tools with approvals and a full audit trail (arriving in Iterations 6–8).

> **Status: Iteration 1 of 13 — application foundation.** Authentication (with MFA), organizations, role-based access with property/building scoping, Postgres row-level-security tenant isolation, invitations, settings, audit log, demo data, Docker and CI. See [`docs/roadmap.md`](docs/roadmap.md).

## Architecture in one paragraph

A modular monolith: **Next.js 16** (App Router, React 19, TypeScript) serves the UI, server actions and REST routes. Domain services in `src/server/modules/*` take a `TenantCtx` (the acting **Principal**) and run every query inside `withContext()`, which pins the Postgres transaction to one organization. **PostgreSQL 16 row-level security** enforces tenant isolation for the least-privilege runtime role, independent of application code. **Drizzle ORM** provides typed queries and SQL migrations. Details: [`docs/architecture.md`](docs/architecture.md), [`docs/ai-architecture.md`](docs/ai-architecture.md), [`docs/database-schema.md`](docs/database-schema.md).

```
src/
  app/                 routes: (auth) pages, /orgs, /onboarding, /o/[orgSlug]/…, /account, /admin, /api/health
  components/          ui/ design system, shell/ navigation
  config/              brand placeholders, navigation
  server/
    auth/              passwords (argon2id), sessions, TOTP MFA, rate limiting, crypto
    authz/             permission catalog, system roles, authorize()
    db/                Drizzle schema, pooled client, withContext() for RLS
    modules/           organizations, members (+ future domains)
    mail/              Mailer (console | SMTP) + templates
    audit.ts           audit writer (same transaction as the change)
drizzle/               SQL migrations (incl. RLS policies)
scripts/               migrate, seed, reset
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
| `vendor@demo.test` | Vendor | Only work assigned to them (none until Iteration 3) |
| `admin@northshore.test` | Organization Admin (Northshore Strata) | Second tenant, used to prove isolation |
| `superadmin@demo.test` | Platform super admin | `/admin` console |

Demo org **Pacific Properties Management**: 4 properties (Harbour Centre, Pacific Heights, Fraser Towers, Kingsway Residences), 6 buildings, 339 units, ~565 residents. Data is deterministic.

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

## Production deployment (current state)

1. Build the image: `docker build --target runner -t yourapp:TAG .` (Next.js standalone server, non-root, healthcheck on `/api/health`).
2. Run migrations as a release step: `docker build --target migrator -t yourapp-migrate:TAG .` with `MIGRATION_DATABASE_URL` (owner) and `DATABASE_URL` (runtime role, used to grant privileges). Do **not** set `SEED_DEMO` in production.
3. Run the app with the **runtime role** URL, a unique `APP_ENCRYPTION_KEY` from your secret manager, `MAIL_PROVIDER=smtp`, `APP_URL` set to your HTTPS origin, behind TLS. Cookies are `__Host-` prefixed and `Secure` in production.
4. Use managed Postgres with point-in-time recovery. A full production runbook (backups, monitoring, key rotation) is Iteration 13.

The in-memory rate limiter is per instance; run a single instance until the Redis adapter lands.

## AI and integrations configuration

Not active yet. The provider abstraction (`AI_PROVIDER=demo|anthropic|openai|google|openai-compatible`, `AI_MODEL`) arrives in Iteration 6, with a clearly labelled demo mode that works without an API key. Integration adapters (Stripe, email/SMS providers, calendars, accounting) arrive in Iteration 10. See `docs/ai-architecture.md` and `docs/architecture.md` §10.

## Rebranding

Replace the placeholders in `src/config/brand.ts` (product and assistant names) and the logo in `src/components/brand/logo.tsx`.
