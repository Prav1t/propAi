# [YOUR PRODUCT NAME]

AI-native operations platform for property managers, strata/HOAs, facility teams, concierge desks and residents. The assistant, **[YOUR AI ASSISTANT NAME]**, answers from live records through typed, permission-checked tools, answers rules and procedure questions from your own documents with citations, and prepares changes — work orders, assignments, bookings, packages, visitors, tasks, inspections, incidents, notices and messages — as plans the user approves, edits or cancels. Everything it reads or does is logged and audited.

> **Status: Iteration 11 of 13 complete.**
> - **Iteration 1 — foundation:** authentication with MFA, organizations, role-based access scoped to portfolio/property/building/unit, Postgres row-level-security tenant isolation, invitations, settings, audit log.
> - **Iteration 2 — portfolio core:** portfolios, properties, buildings (stacking plan, bulk unit generation), floors, units, residents (move-in/out history, resident-app invites), staff directory, vendors (contacts, property approvals, vendor-portal invites), permission-aware full-text search and a Cmd/Ctrl-K command palette.
> - **Iteration 3 — operations core:** maintenance work orders (triage rules, SLA targets and monitor, vendor portal), tasks, inspections, incidents, complaints, file attachments, in-app + email notifications through a transactional outbox.
> - **Iteration 4 — community & resident experience:** amenities with a booking rules engine and approvals, packages with pickup codes and signatures, announcements, resident ↔ management messaging with templates, a versioned document library, and a mobile-first resident app.
> - **Iteration 5 — front desk & facility:** a front desk console, visitors with QR guest passes, parking (spaces, vehicles, permits, human-reviewed violation reports), staff shifts with on-call routing and handoffs, an asset registry with preventive maintenance and downtime, and a unified calendar.
> - **Iteration 6 — AI foundation (read-only):** the assistant with 22 permission-filtered read tools over the domain services, a provider layer (Anthropic, OpenAI, any OpenAI-compatible server, and a labelled demo mode that needs no key), streamed answers with a visible lookup trail and record cards, private conversation history, five specialised modes, Cmd/Ctrl-K "Ask", tool-call logs, token/cost usage with per-organization caps, and an evaluation suite.
> - **Iteration 7 — agentic AI:** 13 action tools that prepare changes through the real rules without writing, a policy engine (risk classes, per-organization and per-property rules, hard limits on anything that contacts residents), plan cards with Approve / Edit / Cancel, re-authorization and verification at approval, audit entries marked AI-generated with the plan id, tone-aware drafts for notices and messages, a pending-approvals list, and admin controls for what the assistant may do.
> - **Iteration 8 — knowledge base & retrieval (RAG):** documents (PDF, Word, text) and knowledge-base entries are indexed into passages with pgvector; permission-aware hybrid search (meaning + keywords) never returns a passage the reader couldn't open; answers quote and cite their sources; a *Knowledge base* page to write versioned entries, see index status and test questions; policy lines on prepared bookings and emergency procedures on work orders; embedding providers (Voyage, OpenAI, OpenAI-compatible, or an offline demo embedder).
> - **Iteration 9 — analytics & automation:** a catalog of 24 metrics computed in SQL over the reader's own properties (period-over-period, breakdowns, trends), an *Analytics* page with accessible charts and table views, 10 reports with CSV export and a print layout, an explainable property health score with configurable weights, a WHEN → IF → THEN **automation engine** (11 event triggers + schedules, conditions, 10 actions including a manager-approval step and an assistant-drafted note, loop protection, idempotent runs, audit entries tied to the run), a rule builder with templates, plain-language summaries and a dry run against a past event, "due soon" SLA warnings, a daily operations brief, data-backed insights, and assistant tools that answer numeric questions from the same metric definitions.
> - **Iteration 10 — billing, API & integrations:** plans as configuration (Starter / Professional / Enterprise with per-unit pricing, limits and included features), a 14-day trial for every new organization, usage metered against limits, a **billing provider abstraction** with a labelled development provider (local checkout, invoices, renewals, proration) and a **Stripe adapter** (Checkout, Customer Portal, verified idempotent webhooks), read-only mode when a subscription lapses (nothing is deleted), scoped **API keys** and a versioned **REST API** (`/api/v1`: cursor pagination, filters, idempotency keys, one error shape, per-key rate limits, an OpenAPI 3.1 document and a reference page generated from the same route table), **signed outgoing webhooks** with retries, auto-disable and a replayable delivery log (SSRF-safe delivery), integrations (Slack, Microsoft Teams — also as an automation action — Twilio SMS, Resend/SendGrid email), **feature flags**, and a platform console with plans, estimated revenue and per-organization deals.
> - **Iteration 11 — security hardening:** a threat model with a route-by-route review and a finding log ([`docs/security/threat-model.md`](docs/security/threat-model.md)); attack-style test suites (an IDOR sweep over every detail page and role, privilege escalation, cross-tenant writes, CSRF, open redirects, tampering); **single sign-on** with OpenID Connect (Google Workspace, Microsoft Entra ID, Okta or any provider) with DNS-verified domains and optional just-in-time membership; organizations can **require SSO and/or two-step verification**; a recent sign-in ("Confirm it's you") for sensitive changes; one-time TOTP codes; an absolute session lifetime; trusted-proxy client addresses; shared **Redis rate limits**; a strict **nonce-based CSP** and cross-site write guard; a **tamper-evident audit log** (hash chain, verification, checkpoints); **encryption key rotation**; **privacy tools** (personal data export, erasure with legal holds, retention settings, consent history); dependency and secret scanning with an SBOM in CI.
>
> See [`docs/roadmap.md`](docs/roadmap.md) and [`docs/iterations/`](docs/iterations/).

## Architecture in one paragraph

A modular monolith: **Next.js 16** (App Router, React 19, TypeScript) serves the UI, server actions and REST routes. Domain services in `src/server/modules/*` take a `TenantCtx` (the acting **Principal**) and run every query inside `withContext()`, which pins the Postgres transaction to one organization. **PostgreSQL 16 row-level security** enforces tenant isolation for the least-privilege runtime role, independent of application code. **Drizzle ORM** provides typed queries and SQL migrations. Details: [`docs/architecture.md`](docs/architecture.md), [`docs/ai-architecture.md`](docs/ai-architecture.md), [`docs/database-schema.md`](docs/database-schema.md).

```
src/
  app/                 routes: (auth) pages, /orgs, /onboarding, /o/[orgSlug]/…, /account, /admin, /api/health,
                       /api/v1/[...path] (REST API), /api/billing/webhook/stripe, /developers/api (API reference)
  components/          ui/ design system, shell/ navigation, ops/ timeline, attachments, status forms, bar lists,
                       community/ booking form, day timeline, package intake, signature pad, message composer,
                       ai/ assistant chat, plan card, record cards, safe markdown, ask box,
                       frontdesk/ visitor form, pass card, pass scanner, plate lookup, handoff snapshot,
                       analytics/ trend chart (with table view), metric tiles, health badge,
                       automation/ rule builder (WHEN → IF → THEN, dry run), approve/decline form,
                       billing/ plan buttons, flag controls, developers/ key + endpoint forms, one-time secret reveal
  config/              brand placeholders, navigation, plans (prices, limits, features), feature flags
  server/
    ai/                assistant: providers/ (anthropic, openai, demo), tools/ (registry, read tools, action tools),
                       orchestrator, policy engine + policies, approvals (plans), prompt, modes, conversation store,
                       usage + caps, demo intent + action planner, eval/ (cases, grounding)
    analytics/         metric catalog (SQL per metric, scoped to the reader), periods in the org's time zone, reports + CSV,
                       property health score, insights, daily brief, analytics settings
    automation/        workflow engine: outbox + schedule triggers, conditions, actions, approvals, loop protection,
                       recipients (roles at a property, on call), dry run, rule service
    billing/           entitlements (plan + flags + read-only, the one place features and limits are checked),
                       service (trials, plan changes, idempotent provider events, usage metering, renewals),
                       providers/ (development mock, Stripe), platform admin
    api/               API keys (hashed, scoped service principals), v1/ route table, handler (auth → rate limit →
                       plan → permission → validation → idempotency), resources (cursor pagination), serializers, OpenAPI
    webhooks/          event catalog, HMAC signing, fan-out from the outbox, delivery with retries + auto-disable
    integrations/      Slack / Teams / Twilio adapters and connections (encrypted credentials), calendar sync contract
    net/               SSRF-safe outbound POST (public addresses only, DNS-pinned, no redirects, time/size caps)
    kb/                knowledge base: text extraction, heading-aware chunking, embedding providers, indexing queue,
                       permission-aware hybrid retrieval, knowledge entries
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
    worker.ts          background tick: SLA breach + due-soon monitor, scheduled announcements, package reminders, preventive maintenance,
                       scheduled rules, automation runs, daily briefs, outbox delivery, indexing, billing, webhooks, usage
    mail/              Mailer (console | SMTP | Resend | SendGrid) + templates
    audit.ts           audit writer (same transaction as the change)
drizzle/               SQL migrations (incl. RLS policies)
scripts/               migrate, seed (+ seed-ops, seed-community, seed-facility, seed-billing, seed-knowledge, seed-automation, seed-ai), reset, worker, ai-ask, ai-eval
tests/                 integration (real Postgres), e2e (Playwright); unit tests live next to code
docs/                  research, requirements, architecture, AI design, schema, roadmap
```

## Prerequisites

- Node.js **20.9+** (22 recommended)
- PostgreSQL **16** with the **pgvector** extension (the Docker image includes it; on Debian/Ubuntu `apt install postgresql-16-pgvector`, on macOS `brew install pgvector`)
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
   CREATE ROLE propai LOGIN PASSWORD 'propai' SUPERUSER;                    -- schema owner (migrations); superuser in dev only,
                                                                            -- so migrations can create the pgvector extension
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
| `superadmin@demo.test` | Platform super admin | `/admin` console: organizations, subscriptions, revenue estimate, feature flags |

**Demo API key** (development seed only, never created when `NODE_ENV=production`): `ak_demokey1_DEVELOPMENT-ONLY-demo-api-key-do-not-use-00` — acts for `admin@demo.test` in Pacific Properties with every API permission. Revoke it in *Organization → Developers* if your demo database is reachable by others.

Demo org **Pacific Properties Management**: 4 properties (Harbour Centre, Pacific Heights, Fraser Towers, Kingsway Residences) in 2 portfolios, 6 buildings, 339 units, ~550 residents (incl. move-out history), 8 vendors with contacts and property approvals, staff profiles — plus ~175 work orders over 90 days (with SLA history, costs and timelines), SLA targets and 9 triage rules, 12 tasks, 3 inspection templates and 8 inspections, 14 incidents (two of them earlier today), 25 complaints, 8 amenities with ~210 bookings and closures, 44 packages, 7 announcements, resident conversations and reply templates, 10 documents (real PDFs), ~90 visitors (expected, on site and a month of history), 223 parking spaces with ~115 registered vehicles, permits and violation reports (including a camera detection to review), ~170 shifts (front desk, security, maintenance, after-hours on call) with handoffs, 27 assets with PM schedules, a year of PM history and downtime, notifications, a knowledge base (7 entries written the way a manager would — party room rules, moving, an emergency checklist, a staff-only flood procedure, a staff-only unit-entry procedure, Harbour Centre amenities, and Northshore's lounge rules — plus every document, indexed into passages), six automation rules (five on — an elevator-emergency rule at Fraser Towers with a run waiting for the property manager's approval, due-soon warnings, urgent complaints, perishable packages and a weekly report that has already run once — and "Serious incidents", off), today's daily brief for the property manager, and a few assistant conversations produced by running the real tools in demo mode — including AI plans in each state (one waiting for the property manager, one approved, one run under an organization rule) and assistant rules for both organizations. Six extra staff members without logins (`*@staff.example.test`) make the schedules realistic. Data is deterministic apart from dates and the current shift, which are relative to when you seed.

Things to try:

- **The assistant:** open *Assistant* (or press **Ctrl/Cmd-K** and type a question). As `pm@demo.test` try "Show me all overdue maintenance requests across my properties", "Which vendor has been the slowest this month?", "Summarize today's incidents" or "Give me my morning briefing" — the trail shows which lookup ran, and the cards link to the real records. **Actions:** `pm@demo.test` already has a plan waiting in the assistant's sidebar ("Create work order “Broken elevator”") — open it, **Edit** the title, **Approve**, and follow the link to the new work order (assigned to Summit Elevator Services, with an AI-marked audit trail). Try "Create a maintenance request for the broken elevator in Tower B and assign Summit Elevator" (it shows the similar open requests first), "Send residents of Fraser Towers a notice saying the pool will be closed tomorrow" then "make it friendlier", "Cancel WO-…" (high impact: needs a tick-box), or "Create a task to … by Friday" (runs straight away — Pacific's admin allowed tasks without asking). As `concierge@demo.test`: "A package arrived for unit 1204" (asks which tower). As `resident@demo.test`: "Book the gym the day after tomorrow at 7 PM", "My kitchen sink is leaking — please file a request", "Book the party room tomorrow at 7 PM" (refused by the 48-hour rule before anything is prepared) or "Show me all residents in another building" (refused, nothing looked up). As `admin@demo.test`, "Is the gym free tomorrow at 6 PM?" asks which of the two gyms you mean, and *Organization → AI assistant* shows usage, cost estimates, the tool-call log, the monthly limit, **what the assistant may do** (per organization and property) and recent plans. Without an API key the assistant runs in **demo mode** (labelled on every answer).
- **Analytics:** as `pm@demo.test` → *Analytics*: every number is computed from rows in Harbour Centre and Fraser Towers only. Change the period, property or building; *Show as table* under each chart; click a tile to open the records behind it; *How it's calculated* on a property's health score shows each factor's value, score, weight and the records behind it. *Reports* has 10 reports (maintenance, SLA, vendor scorecard, complaints, incidents, inspections, amenities, packages, staff workload, property health) with *Download CSV* (audited) and *Print*. The dashboard shows insights computed from recorded rows — requests close to their resolution target, a category of requests rising at a property, a vendor missing SLA targets, failing inspections, equipment that keeps needing repairs — each linking to the records behind it, and *Brief* is today's operations brief. Ask the assistant "How much did maintenance spending change this quarter?", "Which property has the highest complaint volume?" (as `admin@demo.test`) or "Give me my morning briefing" — the numbers come from the same queries. As `admin@demo.test` → *Settings → Analytics & automation* to change the due-soon lead time, the brief time and the health-score weights.
- **Automations:** as `pm@demo.test` → *Automations → Waiting for approval*: the seeded elevator emergency at Fraser Towers already raised priority, alerted the managers and the on-call technician and opened a check-in task; **Approve** it and the resident is told a technician is on the way (their notification arrives only now). As `admin@demo.test` → *Automations → New rule*: start from a template, scope it to a property, add conditions ("category is Elevator"), actions (notify roles or whoever is on call, create a task, set priority, assign, escalate, ask for approval, have the assistant draft a note, send a report) and **Run test** against something that happened recently — nothing changes. Every run has a step-by-step log, and changes it made are in the audit log tied to the run. A property manager sees organization-wide rules as read-only; residents can't open automations.
- **Billing:** as `admin@demo.test` → *Organization → Billing*: Professional, active on the **development billing provider** (labelled — nothing is charged), usage against limits (339 of 5,000 units…), three monthly invoices from real renewals ($299 + 89 units above 250 × $0.80). Choose *Enterprise* to upgrade on the spot (the invoice credits the unused part of the month), or *Starter* to see why it doesn't fit. Register a new account and create an organization to see a 14-day trial → choose a plan → the development checkout page → confirm. `admin@northshore.test` is on Starter: automation, the API and webhooks show what they'd need. As `superadmin@demo.test` → `/admin`: subscriptions, estimated monthly revenue, global feature flags, and per-organization limit overrides, trial extensions and flags.
- **REST API and webhooks:** `curl -H "Authorization: Bearer ak_demokey1_DEVELOPMENT-ONLY-demo-api-key-do-not-use-00" "http://localhost:3000/api/v1/work-orders?status=new,acknowledged&limit=5"` — follow `next_cursor`; `POST /api/v1/work-orders` with an `Idempotency-Key` creates a request exactly like the app does (triage, SLA, notifications, automation). The reference is at **/developers/api** (and `/api/v1/openapi.json`). In *Organization → Developers* create your own keys (limited to some permissions and properties) and a webhook endpoint (for a local receiver start the dev server with `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`; https://webhook.site works without it), *Send a test event*, then create a work order and watch the signed delivery, its attempts and *Send again* in the delivery log.
- **Integrations:** *Organization → Integrations* connects Slack or Microsoft Teams (incoming-webhook URL; then add *Post to Slack or Teams* to an automation rule) and Twilio (send a test SMS). Credentials are encrypted and only a masked hint is ever shown.
- **Rules and procedures, with citations:** as `resident@demo.test` ask "What are the rules for booking the party room?", "Can I have a barbecue on my balcony?" or "Are dogs allowed?" — the answer quotes the documents and links each quote to its source; "What is the policy on hot tubs?" says nothing covers it. "Where are the Tower B riser valves?" finds nothing for the resident but, as `concierge@demo.test`, quotes the staff-only flood procedure. `owner@demo.test` gets the owners-only bylaws; a tenant doesn't. As `pm@demo.test` → *Knowledge base*: every document and entry with its index status, *Try a question* (shows the passages you'd get), *New entry* (write `## sections`; it's indexed as you save), versions, *Disable*, re-index. Each document page shows its *Assistant index* too.
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

## Security and privacy (walkthrough)

Sign in as `admin@demo.test`:

- **Settings → Security:**
  - Choose who must use two-step verification, and whether staff must sign in with SSO. Turn on two-step for your own account first.
  - Connect an OpenID Connect provider: Google Workspace, Microsoft Entra ID (tenant ID), Okta (domain) or any issuer URL.
  - Prove a domain with a DNS TXT record.
  - Optionally, let people from that domain join with a chosen staff role.
- **Sign in with SSO:** on the sign-in page, *Sign in with your organization (SSO)* finds the provider from the work email.
- **Re-confirmation:** creating an API key, rotating a webhook secret, connecting an integration, changing a role, billing or security settings, or exporting or erasing personal data needs a sign-in from the last 10 minutes. Otherwise you'll be asked to *Confirm it's you* and then sent straight back.
- **Settings → Privacy:**
  - Find a resident and export their data as JSON (a download link lasts 7 days).
  - Place a legal hold, or erase their data. Building records stay, without their name.
  - Set retention for messages, visitor logs, parking evidence, assistant chats and the audit log.
- **Settings → Audit log → Verify the audit log** recomputes the organization's hash chain. Platform admins can verify every chain from `/admin`.

## Tests

```bash
npm run test:unit          # pure logic: authorization, crypto, TOTP, rate limits, templates…
npm run test:integration   # real Postgres + pgvector (propai_test): resets, migrates from empty, seeds twice, then tests
npm run test:e2e           # Playwright against `npm run dev` (starts it if not running)
npm run test:e2e:batched   # the same suite in batches, a fresh dev server per batch (machines with ≤ 8 GB of memory)
npm run ai:eval            # assistant evaluation suite against the configured provider (demo model without a key)
npm run ai:ask -- --as pm@demo.test "Which vendor has been the slowest this month?"   # ask from the terminal
npm run test:security      # just the attack-style suites in tests/security (part of test:integration)
npm run security:audit     # production dependencies: fails on high/critical advisories
npm run security:secrets   # tracked files: fails on anything that looks like a real credential
npm run security:sbom      # CycloneDX SBOM of production dependencies → sbom.cdx.json
npm run lint && npm run typecheck && npm run build
```

`REDIS_TEST_URL=redis://127.0.0.1:6379/15 npm run test:integration` also runs the shared rate-limiter tests against Redis. The SSO tests run their own OpenID Connect provider on 127.0.0.1 (the test environment sets `OIDC_ALLOW_HTTP_ISSUERS=true`, which production refuses).

Integration tests connect as the **runtime role** and prove tenant isolation at the database level (cross-org reads, writes, moves and audit tampering all fail). Override the test database with `TEST_DATABASE_URL` / `TEST_MIGRATION_DATABASE_URL`.

E2E notes: sign-in is rate-limited per IP, so the Playwright web server is started with `RATE_LIMITS=relaxed` (ignored in production) and `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (the API → webhook test runs a receiver on 127.0.0.1). It also sets `DEV_FS_CACHE=off`: Turbopack's persistent dev cache takes several GB of memory when it snapshots, which kills the dev server on small machines and CI containers (~6 GB); with it off the dev server stays around 1–2 GB, and the warm-up compiles routes from scratch. If you reuse your own dev server, start it with these variables. To use a pre-installed Chromium, set `PW_CHROMIUM_PATH`. Before the tests, a warm-up step signs in and visits every page once so the dev server's first-visit compiles don't count against test timeouts (about 5 minutes on a cold 2-CPU machine, seconds on a warm server; `E2E_SKIP_WARMUP=1` skips it, and it never runs against `E2E_BASE_URL`).

## Environment variables

See [`.env.example`](.env.example). Required: `DATABASE_URL`, `APP_ENCRYPTION_KEY`; `MIGRATION_DATABASE_URL` for migrate/seed.

- **Client addresses (rate limits, audit, sign-in history):** set `TRUSTED_PROXY_HOPS` to the number of reverse proxies in front of the app that append to `X-Forwarded-For` (usually `1`; `2` for a CDN plus a load balancer), or `CLIENT_IP_HEADER` when your proxy sets its own header (`cf-connecting-ip`). Only the address your proxies added is used; anything a client writes is ignored. Without either, production logs a warning at start-up. (`TRUST_PROXY=true` from older configs means one proxy.)
- **Shared rate limits:** `REDIS_URL` makes sign-in, MFA, invitation, assistant and API-key limits hold across all app instances (sliding window). Without it, limits are per instance. If Redis becomes unreachable, each instance keeps limiting on its own rather than not at all.
- **Encryption keys:** secrets at rest (MFA secrets, webhook signing secrets, integration and SSO credentials) are sealed with `APP_ENCRYPTION_KEY`, named by `APP_ENCRYPTION_KEY_ID` (default `k1`). To rotate:
  1. Move the old key to `APP_ENCRYPTION_OLD_KEYS=k1:<base64>`.
  2. Set a new `APP_ENCRYPTION_KEY` and `APP_ENCRYPTION_KEY_ID=k2`, then deploy.
  3. Run `npm run keys:rotate`, then `npm run keys:status` until nothing is left on `k1`.
  4. Remove the old key.
- **Sessions:** they slide while used, but end `SESSION_ABSOLUTE_DAYS` (default 90) after sign-in.
- **Single sign-on:** configured per organization under *Settings → Security* (no environment variables). Register `<APP_URL>/sso/callback` as the redirect URI with your identity provider. `OIDC_ALLOW_HTTP_ISSUERS=true` is only for local test providers and is refused in production.

- **Attachments:** `FILE_STORAGE=local` (default; files under `FILE_STORAGE_DIR`, default `./.data/uploads`, a named volume in Docker) or `FILE_STORAGE=s3` with `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT` for MinIO/R2, `S3_PUBLIC_ENDPOINT` when browsers reach the bucket on a different host than the app, `S3_SSE=none` for MinIO without a KMS, and credentials from the standard AWS chain. `S3_TEST_ENDPOINT=http://… npm run test:integration` also runs the S3 adapter test against that server.
- **Guest pass links** are built from `APP_URL`, so set it to the public HTTPS origin in production.
- **Billing:** `BILLING_PROVIDER=mock` (development: local checkout, simulated invoices and renewals; refused in production unless `BILLING_ALLOW_MOCK=true` for a demo deployment) or `stripe` with `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and one price per plan and interval (`STRIPE_PRICE_PROFESSIONAL_MONTH`, …; optional `…_UNIT` per-unit prices). Point a Stripe webhook at `<APP_URL>/api/billing/webhook/stripe`. Plans, prices, limits and trial length live in `src/config/plans.ts`.
- **Email:** `MAIL_PROVIDER=console | smtp | resend | sendgrid` (`RESEND_API_KEY` / `SENDGRID_API_KEY`).
- **Feature flags:** `FLAG_PUBLIC_API`, `FLAG_WEBHOOKS`, `FLAG_INTEGRATIONS`, `FLAG_ADVANCED_ANALYTICS`, `FLAG_SELF_SERVE_BILLING` set environment defaults; platform admins override them globally or per organization in `/admin`.
- **Webhooks** only reach public addresses. `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` lets them reach localhost while developing; it is ignored in production.
- **Background worker:** notification delivery, the SLA monitor (breaches and "due soon" warnings), scheduled announcements, preventive-maintenance work orders, scheduled automation rules, automation runs for new events, daily briefs (at each organization's brief time), knowledge-base indexing, package reminders (`PACKAGE_REMINDER_DAYS`, default 3), billing (trial notices and expiry, development-provider renewals), webhook fan-out and retries, and an hourly usage snapshot run in-process every `WORKER_INTERVAL_MS` (30 s). For several app instances, set `DISABLE_INPROCESS_WORKER=true` on them and run one `npm run worker` process (or `npm run worker -- --once` from a scheduler).

## Production deployment (current state)

1. Build the image: `docker build --target runner -t yourapp:TAG .` (Next.js standalone server, non-root, healthcheck on `/api/health`).
2. Run migrations as a release step: `docker build --target migrator -t yourapp-migrate:TAG .` with `MIGRATION_DATABASE_URL` (owner) and `DATABASE_URL` (runtime role, used to grant privileges). Do **not** set `SEED_DEMO` in production. The database needs pgvector: on managed Postgres (RDS, Cloud SQL, Azure, Supabase…) either let the migration role create extensions or run `CREATE EXTENSION vector;` once yourself before the first migration.
3. Run the app with the **runtime role** URL, a unique `APP_ENCRYPTION_KEY` from your secret manager, `MAIL_PROVIDER=smtp` (or `resend`/`sendgrid`), `BILLING_PROVIDER=stripe` with its keys and prices, `APP_URL` set to your HTTPS origin, behind TLS. Cookies are `__Host-` prefixed and `Secure` in production.
4. Use managed Postgres with point-in-time recovery. A full production runbook (backups, monitoring, key rotation) is Iteration 13.

For more than one app instance, set `REDIS_URL` (shared rate limits) and use `FILE_STORAGE=s3`. Set `TRUSTED_PROXY_HOPS` for your proxy chain. Security headers (a nonce-based CSP, HSTS, frame and referrer policies) are set by the app, so a proxy shouldn't overwrite them.

## AI configuration

The assistant works out of the box in **demo mode**: no language model, fixed rules route common questions and change requests to the same tools a model would call, answers are composed only from tool results, and notices are drafted from your own words through fixed tone templates. Every demo answer is labelled. To use a real model, set one provider in `.env`:

| Provider | Settings |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY=…` (optional `AI_MODEL`, default `claude-sonnet-5`; `ANTHROPIC_BASE_URL` for a gateway) |
| OpenAI | `AI_PROVIDER=openai`, `OPENAI_API_KEY=…`, `AI_MODEL=…` |
| OpenAI-compatible (Ollama, vLLM, LM Studio, gateways) | `AI_PROVIDER=openai-compatible`, `AI_COMPAT_BASE_URL=http://host:port/v1`, `AI_MODEL=…`, optional `AI_COMPAT_API_KEY` |

The model must support tool calling. Limits: `AI_MAX_STEPS` (lookups per answer, default 6), `AI_TIMEOUT_MS` (60 s), `AI_MAX_OUTPUT_TOKENS`, `AI_REQUESTS_PER_MINUTE` per person (20) and `AI_MONTHLY_REQUEST_CAP` (the default per-organization cap; admins set their own under *Organization → AI assistant*). Cost estimates use a small built-in price table or `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK`; models without a price record tokens but no estimate. Prompts, tool results and record text are sent to the provider you configure, so choose one your customers' data agreements allow.

**Knowledge base and embeddings.** Documents and knowledge-base entries are indexed into passages automatically. Without an embedding key a local, offline embedder is used (labelled demo quality — keyword search does most of the work). For meaning-based search set one of:

| Provider | Settings |
|---|---|
| Voyage | `VOYAGE_API_KEY=…` (optional `EMBEDDING_MODEL`, default `voyage-3.5-lite`) |
| OpenAI | `OPENAI_API_KEY=…` (default `text-embedding-3-small`), or `EMBEDDING_PROVIDER=openai` with `EMBEDDING_API_KEY` |
| OpenAI-compatible (Ollama, vLLM…) | `EMBEDDING_PROVIDER=openai-compatible`, `EMBEDDING_BASE_URL=http://host:port/v1`, `EMBEDDING_MODEL=…` (must output 512 dimensions) |

After changing the embedding model, use *Knowledge base → Re-index everything*; until then keyword search still works and sources are flagged "older model". Passage text is sent to the embedding provider you configure.

Before switching models or changing prompts, run `npm run ai:eval` against the new configuration: it checks tool choice, permission compliance, that changes are prepared as plans (never claimed as done, never self-approved), organization policies, cited answers from documents (and "not covered" when nothing applies), audience leaks, ambiguity handling and that every number in an answer appears in a tool result. `npm run ai:ask -- --as pm@demo.test --approve "…"` prepares a plan from the terminal and approves it as that user. Design notes: [`docs/ai-architecture.md`](docs/ai-architecture.md). Integration adapters (Stripe, email/SMS providers, calendars, accounting) arrive in Iteration 10.

## Rebranding

Replace the placeholders in `src/config/brand.ts` (product and assistant names) and the logo in `src/components/brand/logo.tsx`.
