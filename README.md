# [YOUR PRODUCT NAME]

AI-native operations platform for property managers, strata/HOAs, facility teams, concierge desks and residents. The assistant, **[YOUR AI ASSISTANT NAME]**, answers from live records through typed, permission-checked tools and prepares changes — work orders, assignments, bookings, packages, visitors, tasks, inspections, incidents, notices and messages — as plans the user approves, edits or cancels. Everything it reads or does is logged and audited.

> **Status: Iteration 7 of 13 complete.**
> - **Iteration 1 — foundation:** authentication with MFA, organizations, role-based access scoped to portfolio/property/building/unit, Postgres row-level-security tenant isolation, invitations, settings, audit log.
> - **Iteration 2 — portfolio core:** portfolios, properties, buildings (stacking plan, bulk unit generation), floors, units, residents (move-in/out history, resident-app invites), staff directory, vendors (contacts, property approvals, vendor-portal invites), permission-aware full-text search and a Cmd/Ctrl-K command palette.
> - **Iteration 3 — operations core:** maintenance work orders (triage rules, SLA targets and monitor, vendor portal), tasks, inspections, incidents, complaints, file attachments, in-app + email notifications through a transactional outbox.
> - **Iteration 4 — community & resident experience:** amenities with a booking rules engine and approvals, packages with pickup codes and signatures, announcements, resident ↔ management messaging with templates, a versioned document library, and a mobile-first resident app.
> - **Iteration 5 — front desk & facility:** a front desk console, visitors with QR guest passes, parking (spaces, vehicles, permits, human-reviewed violation reports), staff shifts with on-call routing and handoffs, an asset registry with preventive maintenance and downtime, and a unified calendar.
> - **Iteration 6 — AI foundation (read-only):** the assistant with 22 permission-filtered read tools over the domain services, a provider layer (Anthropic, OpenAI, any OpenAI-compatible server, and a labelled demo mode that needs no key), streamed answers with a visible lookup trail and record cards, private conversation history, five specialised modes, Cmd/Ctrl-K "Ask", tool-call logs, token/cost usage with per-organization caps, and an evaluation suite.
> - **Iteration 7 — agentic AI:** 13 action tools that prepare changes through the real rules without writing, a policy engine (risk classes, per-organization and per-property rules, hard limits on anything that contacts residents), plan cards with Approve / Edit / Cancel, re-authorization and verification at approval, audit entries marked AI-generated with the plan id, tone-aware drafts for notices and messages, a pending-approvals list, and admin controls for what the assistant may do.
>
> See [`docs/roadmap.md`](docs/roadmap.md) and [`docs/iterations/`](docs/iterations/).

## Architecture in one paragraph

A modular monolith: **Next.js 16** (App Router, React 19, TypeScript) serves the UI, server actions and REST routes. Domain services in `src/server/modules/*` take a `TenantCtx` (the acting **Principal**) and run every query inside `withContext()`, which pins the Postgres transaction to one organization. **PostgreSQL 16 row-level security** enforces tenant isolation for the least-privilege runtime role, independent of application code. **Drizzle ORM** provides typed queries and SQL migrations. Details: [`docs/architecture.md`](docs/architecture.md), [`docs/ai-architecture.md`](docs/ai-architecture.md), [`docs/database-schema.md`](docs/database-schema.md).

```
src/
  app/                 routes: (auth) pages, /orgs, /onboarding, /o/[orgSlug]/…, /account, /admin, /api/health
  components/          ui/ design system, shell/ navigation, ops/ timeline, attachments, status forms, bar lists,
                       community/ booking form, day timeline, package intake, signature pad, message composer,
                       ai/ assistant chat, plan card, record cards, safe markdown, ask box,
                       frontdesk/ visitor form, pass card, pass scanner, plate lookup, handoff snapshot
  config/              brand placeholders, navigation
  server/
    ai/                assistant: providers/ (anthropic, openai, demo), tools/ (registry, read tools, action tools),
                       orchestrator, policy engine + policies, approvals (plans), prompt, modes, conversation store,
                       usage + caps, demo intent + action planner, eval/ (cases, grounding)
    auth/              passwords (argon2id), sessions, TOTP MFA, rate limiting, crypto
    authz/             permission catalog, system roles, authorize()
    db/                Drizzle schema, pooled client, withContext() for RLS
    modules/           organizations, members, portfolio, people, vendors, search,
                       maintenance (rules, triage, SLA, config), tasks, inspections, incidents, complaints,
                       notifications (outbox delivery, inbox, preferences), ops (timeline, counters, KPIs),
                       amenities (booking rules engine), packages, announcements, messaging, documents,
                       visitors (guest passes), parking, shifts (on-call, handoffs), assets (PM, downtime), calendar
                       scope.ts: SQL scope filters, search-query sanitizer, pagination
    files/             upload sniffing, BlobStore (local | S3), permission-checked downloads
    worker.ts          background tick: SLA monitor, scheduled announcements, package reminders, preventive maintenance, outbox delivery
    mail/              Mailer (console | SMTP) + templates
    audit.ts           audit writer (same transaction as the change)
drizzle/               SQL migrations (incl. RLS policies)
scripts/               migrate, seed (+ seed-ops, seed-community, seed-facility, seed-ai), reset, worker, ai-ask, ai-eval
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
- To store files in S3-compatible storage instead of a volume: `FILE_STORAGE=s3 docker compose --profile s3 up --build` (adds MinIO and creates the bucket; console at http://localhost:9001, `propai` / `propai-minio`).

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
| `facility@demo.test` | Facility Manager (Daniel Okafor) | "Mixed-Use & Commercial" portfolio (Fraser Towers): assets, PM, shifts |
| `staff@demo.test` | Maintenance Staff | Harbour Centre, Main Tower building only |
| `concierge@demo.test` | Concierge (Aisha Rahman) | Fraser Towers front desk — always on the shift that's happening now in the demo data |
| `council@demo.test` | Strata Council Member | Pacific Heights |
| `resident@demo.test` | Resident (Emma Tremblay) | Own unit: Fraser Towers, Tower B #1204 |
| `owner@demo.test` | Owner (Noah Williams) | Own unit: Fraser Towers, Tower A #805 — sees owners-only documents and amenities |
| `vendor@demo.test` | Vendor (linked to Blake Plumbing & Heating) | Only work orders assigned to their company |
| `admin@northshore.test` | Organization Admin (Northshore Strata) | Second tenant, used to prove isolation |
| `superadmin@demo.test` | Platform super admin | `/admin` console |

Demo org **Pacific Properties Management**: 4 properties (Harbour Centre, Pacific Heights, Fraser Towers, Kingsway Residences) in 2 portfolios, 6 buildings, 339 units, ~550 residents (incl. move-out history), 8 vendors with contacts and property approvals, staff profiles — plus ~175 work orders over 90 days (with SLA history, costs and timelines), SLA targets and 9 triage rules, 12 tasks, 3 inspection templates and 8 inspections, 14 incidents (two of them earlier today), 25 complaints, 8 amenities with ~210 bookings and closures, 44 packages, 7 announcements, resident conversations and reply templates, 10 documents (real PDFs), ~90 visitors (expected, on site and a month of history), 223 parking spaces with ~115 registered vehicles, permits and violation reports (including a camera detection to review), ~170 shifts (front desk, security, maintenance, after-hours on call) with handoffs, 27 assets with PM schedules, a year of PM history and downtime, notifications, and a few assistant conversations produced by running the real tools in demo mode — including AI plans in each state (one waiting for the property manager, one approved, one run under an organization rule) and assistant rules for both organizations. Six extra staff members without logins (`*@staff.example.test`) make the schedules realistic. Data is deterministic apart from dates and the current shift, which are relative to when you seed.

Things to try:

- **The assistant:** open *Assistant* (or press **Ctrl/Cmd-K** and type a question). As `pm@demo.test` try "Show me all overdue maintenance requests across my properties", "Which vendor has been the slowest this month?", "Summarize today's incidents" or "Give me my morning briefing" — the trail shows which lookup ran, and the cards link to the real records. **Actions:** `pm@demo.test` already has a plan waiting in the assistant's sidebar ("Create work order “Broken elevator”") — open it, **Edit** the title, **Approve**, and follow the link to the new work order (assigned to Summit Elevator Services, with an AI-marked audit trail). Try "Create a maintenance request for the broken elevator in Tower B and assign Summit Elevator" (it shows the similar open requests first), "Send residents of Fraser Towers a notice saying the pool will be closed tomorrow" then "make it friendlier", "Cancel WO-…" (high impact: needs a tick-box), or "Create a task to … by Friday" (runs straight away — Pacific's admin allowed tasks without asking). As `concierge@demo.test`: "A package arrived for unit 1204" (asks which tower). As `resident@demo.test`: "Book the gym the day after tomorrow at 7 PM", "My kitchen sink is leaking — please file a request", "Book the party room tomorrow at 7 PM" (refused by the 48-hour rule before anything is prepared) or "Show me all residents in another building" (refused, nothing looked up). As `admin@demo.test`, "Is the gym free tomorrow at 6 PM?" asks which of the two gyms you mean, and *Organization → AI assistant* shows usage, cost estimates, the tool-call log, the monthly limit, **what the assistant may do** (per organization and property) and recent plans. Without an API key the assistant runs in **demo mode** (labelled on every answer).
- **The maintenance loop:** sign in as `resident@demo.test` → *Report a problem* → title "Water spreading under my sink" → the triage rules make it an urgent emergency, assign Blake Plumbing, and show the configured "what to do now" guidance. Then sign in as `vendor@demo.test` to see only that company's jobs, start and complete it (resolution notes required), and as the resident again to see the notification bell and the outcome.
- `pm@demo.test` → dashboard KPIs (open, overdue, SLA met, response time, spend — all computed from rows in their two properties), *Maintenance → Overdue*, assign staff or an approved vendor (★ marks matching trades), internal vs vendor vs public comments, *Organization → Maintenance rules* for SLA targets and triage rules.
- `facility@demo.test` → *Inspections* → schedule from a template, fail an item, complete and sign, then turn the failure into a follow-up work order.
- **Book an amenity:** as `resident@demo.test` on a phone-sized window → *Book an amenity* → *Party Room* → pick a day and time; it needs approval and shows the $50 fee and $250 deposit. As `pm@demo.test` → *Amenities → Bookings → Awaiting approval* → approve with a note → the resident gets a notification and can cancel until the cut-off. Try a time that overlaps, or a closure, to see the rule messages. *Amenities → Calendar* shows the week across amenities.
- **Packages:** as `concierge@demo.test` → *Packages* → pick Tower B, unit 1204, type or scan a tracking number (the carrier is detected) → *Log package*. The resident sees it on their home screen with a 6-digit pickup code; the desk checks that code (a wrong one is refused) and can take an on-screen signature, for one package or several at once.
- **Announcements and documents:** as `pm@demo.test` → *Announcements → New* → target Fraser Towers · Tower A, schedule it or publish now. `owner@demo.test` (Tower A) sees it plus the owners-only bylaws; `resident@demo.test` (Tower B) sees neither. Upload a new version of a document and the old file becomes staff-only.
- **Messages:** as the resident → *Message management*; as `concierge@demo.test` → *Messages → Needs reply* → insert the "Request received" template (variables filled from the thread), add an internal note the resident never sees.
- **Guest passes:** as `resident@demo.test` → *Invite a guest* → you get a QR pass with a link to send. Open the link in a private window — that's the guest's view (first name, building, time; nothing about the host). As `concierge@demo.test` the dashboard *is* the front desk: paste the link into *Guest pass* (or scan the QR with a phone camera), check them in with a free visitor parking space, and the resident is notified. Checking out ends the pass and the parking permit.
- **Parking:** as the concierge → *Parking* → review the camera detection (it's labelled with its confidence and can only be confirmed or dismissed by a person). Report a violation for plate `WLM805` → confirm → issue a notice → `owner@demo.test` sees it under *My parking*. *Plate lookup* shows registration, permits, visitors and past reports for a plate.
- **Shifts and on-call:** *Shifts* shows the week's schedule and who's on now. Write a *Shift handoff* — it attaches the open items automatically — and acknowledge it as another user. Outside weekday hours Tomás Reyes is on call at Fraser Towers, so an emergency request there with no triage assignment goes straight to him.
- **Facility:** as `pm@demo.test` → *Assets* → *Rooftop unit RTU-4* shows six reactive requests in 90 days with downtime and cost from real rows. As `facility@demo.test` → *Emergency generator* → the worker has already opened its monthly load-test work order from the PM schedule (or click *Create now*). Mark an asset out of service, or create a work order with *Equipment is out of service* ticked — finishing the job brings it back.
- **Calendar:** *Calendar* merges scheduled work, inspections, PM due dates, bookings, visitors, shifts and task due dates in day/week/month/agenda views, filtered to what you're allowed to see.
- Press **Ctrl/Cmd-K** for navigation and quick actions ("Create work order", "Show overdue work orders", "Report incident"…); sign in as `pm@demo.test` and notice Pacific Heights has disappeared everywhere.

## Tests

```bash
npm run test:unit          # pure logic: authorization, crypto, TOTP, rate limits, templates…
npm run test:integration   # real Postgres (propai_test): resets, migrates from empty, seeds twice, then tests
npm run test:e2e           # Playwright against `npm run dev` (starts it if not running)
npm run ai:eval            # assistant evaluation suite against the configured provider (demo model without a key)
npm run ai:ask -- --as pm@demo.test "Which vendor has been the slowest this month?"   # ask from the terminal
npm run lint && npm run typecheck && npm run build
```

Integration tests connect as the **runtime role** and prove tenant isolation at the database level (cross-org reads, writes, moves and audit tampering all fail). Override the test database with `TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL`.

E2E notes: sign-in is rate-limited per IP, so the Playwright web server is started with `RATE_LIMITS=relaxed` (ignored in production). If you reuse your own dev server, start it with that variable. To use a pre-installed Chromium, set `PW_CHROMIUM_PATH`.

## Environment variables

See [`.env.example`](.env.example). Required: `DATABASE_URL`, `APP_ENCRYPTION_KEY`; `MIGRATION_DATABASE_URL` for migrate/seed. `TRUST_PROXY=true` only behind a reverse proxy that sets `X-Forwarded-For`.

- **Attachments:** `FILE_STORAGE=local` (default; files under `FILE_STORAGE_DIR`, default `./.data/uploads`, a named volume in Docker) or `FILE_STORAGE=s3` with `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT` for MinIO/R2, `S3_PUBLIC_ENDPOINT` when browsers reach the bucket on a different host than the app, `S3_SSE=none` for MinIO without a KMS, and credentials from the standard AWS chain. `S3_TEST_ENDPOINT=http://… npm run test:integration` also runs the S3 adapter test against that server.
- **Guest pass links** are built from `APP_URL`, so set it to the public HTTPS origin in production.
- **Background worker:** notification delivery, the SLA monitor, scheduled announcements, preventive-maintenance work orders and package reminders (`PACKAGE_REMINDER_DAYS`, default 3) run in-process every `WORKER_INTERVAL_MS` (30 s). For several app instances, set `DISABLE_INPROCESS_WORKER=true` on them and run one `npm run worker` process (or `npm run worker -- --once` from a scheduler).

## Production deployment (current state)

1. Build the image: `docker build --target runner -t yourapp:TAG .` (Next.js standalone server, non-root, healthcheck on `/api/health`).
2. Run migrations as a release step: `docker build --target migrator -t yourapp-migrate:TAG .` with `MIGRATION_DATABASE_URL` (owner) and `DATABASE_URL` (runtime role, used to grant privileges). Do **not** set `SEED_DEMO` in production.
3. Run the app with the **runtime role** URL, a unique `APP_ENCRYPTION_KEY` from your secret manager, `MAIL_PROVIDER=smtp`, `APP_URL` set to your HTTPS origin, behind TLS. Cookies are `__Host-` prefixed and `Secure` in production.
4. Use managed Postgres with point-in-time recovery. A full production runbook (backups, monitoring, key rotation) is Iteration 13.

The in-memory rate limiter is per instance; run a single instance until the Redis adapter lands. With local file storage, also keep a single instance (or switch to `FILE_STORAGE=s3`).

## AI configuration

The assistant works out of the box in **demo mode**: no language model, fixed rules route common questions and change requests to the same tools a model would call, answers are composed only from tool results, and notices are drafted from your own words through fixed tone templates. Every demo answer is labelled. To use a real model, set one provider in `.env`:

| Provider | Settings |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY=…` (optional `AI_MODEL`, default `claude-sonnet-5`; `ANTHROPIC_BASE_URL` for a gateway) |
| OpenAI | `AI_PROVIDER=openai`, `OPENAI_API_KEY=…`, `AI_MODEL=…` |
| OpenAI-compatible (Ollama, vLLM, LM Studio, gateways) | `AI_PROVIDER=openai-compatible`, `AI_COMPAT_BASE_URL=http://host:port/v1`, `AI_MODEL=…`, optional `AI_COMPAT_API_KEY` |

The model must support tool calling. Limits: `AI_MAX_STEPS` (lookups per answer, default 6), `AI_TIMEOUT_MS` (60 s), `AI_MAX_OUTPUT_TOKENS`, `AI_REQUESTS_PER_MINUTE` per person (20) and `AI_MONTHLY_REQUEST_CAP` (the default per-organization cap; admins set their own under *Organization → AI assistant*). Cost estimates use a small built-in price table or `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK`; models without a price record tokens but no estimate. Prompts, tool results and record text are sent to the provider you configure, so choose one your customers' data agreements allow.

Before switching models or changing prompts, run `npm run ai:eval` against the new configuration: it checks tool choice, permission compliance, that changes are prepared as plans (never claimed as done, never self-approved), organization policies, ambiguity handling and that every number in an answer appears in a tool result. `npm run ai:ask -- --as pm@demo.test --approve "…"` prepares a plan from the terminal and approves it as that user. Design notes: [`docs/ai-architecture.md`](docs/ai-architecture.md). Integration adapters (Stripe, email/SMS providers, calendars, accounting) arrive in Iteration 10.

## Rebranding

Replace the placeholders in `src/config/brand.ts` (product and assistant names) and the logo in `src/components/brand/logo.tsx`.
