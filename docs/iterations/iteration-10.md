# Iteration 10 — Billing, API and integrations

_Completed 2026-10-19_

## What was built

**The vertical slices:**
1. **Trial → plan → upgrade.** Someone registers and creates an organization; it starts a 14-day trial of Professional with no card. Under *Organization → Billing* they choose Starter and land on the development checkout page (clearly labelled: nothing is charged), confirm, and come back to an active Starter subscription with a paid invoice. Choosing Professional later upgrades on the spot: the new invoice credits the unused part of the Starter month. Starter's limits (3 properties, 300 units, 10 staff seats) are enforced in the same transaction as the insert; automation, the API, webhooks and integrations show what plan they need.
2. **API → webhook.** An admin creates an API key limited to a few permissions and a webhook endpoint for work-order events (*Organization → Developers*). Their system calls `POST /api/v1/work-orders` with an `Idempotency-Key`. The request goes through the app's own maintenance service: triage rules, SLA targets, notifications and automation rules apply, and the audit row records the key. Moments later the endpoint receives a signed `work_order.created` event; the delivery log shows the attempt, its status and timing, and the event can be sent again.
3. **Lapse → read-only → back.** A cancelled subscription keeps working until the period ends. The worker then marks it cancelled and the organization becomes read-only: every record stays readable, every change (forms, assistant actions, automation, API writes) is refused with the reason, the billing page still works, and choosing a plan restores everything. Nothing is deleted for non-payment.

**Plans and entitlements** (`src/config/plans.ts`, `src/lib/billing.ts`, `src/server/billing/entitlements.ts`)
- **Plans as configuration:** Starter / Professional / Enterprise, each a CAD base price with included units plus a per-unit price above that, a yearly option (ten months for twelve), limits (properties, units, staff seats, assistant requests per month) and included features (assistant, automation, property health & insights, REST API, webhooks, integrations). Pages and services never hard-code prices or limits.
- **One entitlement check** combines the subscription (plan, status, per-organization limit overrides) with feature flags. It's used by form actions (read-only guard), plan limits (properties, units including bulk generation, staff-seat invitations — residents and vendors are free), the assistant (plan allowance on top of the org's own cap; actions blocked when read-only), automation (matching, schedules and each run), the API, webhook fan-out, integrations and the analytics health score.
- **Subscription states → access:** trial, active, past due (7-day grace), cancelled/expired (read-only). A banner tells billing managers about trial days left and grace periods, and tells everyone when the organization is read-only.

**Billing providers** (`src/server/billing/{service,providers/*}.ts`)
- A provider interface with normalized events, applied **idempotently** (each `provider + event_id` once, row-locked, failed events retried on resend).
- **Development provider:** a signed, expiring checkout token and a local checkout page; invoices computed from the plan and unit count; upgrades now with proration; downgrades scheduled for the period end (refused when current usage wouldn't fit); cancel / resume; renewals by the worker at period end (also applying scheduled downgrades). Labelled on every billing screen and refused in production unless explicitly allowed for a demo deployment.
- **Stripe adapter:** Checkout Sessions (base price + optional per-unit price), subscription item updates for plan changes, cancel at period end, the Customer Portal for payment methods and receipts, per-unit quantity sync, and `POST /api/billing/webhook/stripe` with signature verification and event mapping (checkout, subscription created/updated/deleted, invoice finalized/paid/failed/voided/uncollectible).
- **Trials:** created with every organization; one "trial ending" notice three days before; expiry to read-only by the worker.
- **Usage metering:** an hourly snapshot (properties, units, active residents, staff seats, month-to-date assistant requests) plus live counters (API requests, webhook deliveries), shown on the billing page against limits.
- **Billing page:** subscription, renewal date and next-invoice estimate, scheduled changes, usage meters, plan cards priced at the organization's own unit count with what wouldn't fit, invoices with their lines.

**REST API v1** (`src/server/api/*`, `/api/v1/*`)
- **API keys:** `ak_<prefix>_<secret>`, only the hash stored, shown once; scopes are a subset of the creator's own permissions (12 API scopes), optionally limited to properties, optional expiry, revocable. A key acts for its creator and is re-evaluated on every request, so removing the person or their permission removes the key's use.
- **19 endpoints:** `GET /me`; properties (with buildings), units, residents (with their units), vendors, work orders (list/get, create, change status, assign), incidents (list/get, create), complaints, bookings, packages.
- **Pipeline:** key → per-key rate limit (headers; 429 with `Retry-After`; failed authentication limited per IP) → plan and flag → read-only check for writes (402) → key permission → strict validation of query and body (unknown fields refused, field-level details) → `Idempotency-Key` (24 hours, request hash checked) → the same domain services as the UI → JSON with `X-Request-Id`.
- **Lists** use cursor (keyset) pagination with filters; records outside the key's reach are 404; one error shape everywhere.
- **OpenAPI 3.1** at `/api/v1/openapi.json` and a public reference at `/developers/api`, both generated from the route table's Zod schemas.

**Webhooks** (`src/server/webhooks/*`, `src/server/net/safe-fetch.ts`)
- 8 public events (`work_order.created|status_changed|assigned|sla_breached`, `incident.created`, `complaint.created`, `booking.created`, `package.arrived`) fanned out from the outbox (a third consumer) with the payload frozen at that moment, in the same shape as the API.
- HMAC-SHA256 signatures with a timestamp (secret encrypted at rest, shown once, rotatable).
- 8 attempts over about two days with jitter. Every attempt is logged with status, timing and a response snippet. An endpoint is switched off after 20 failures in a row and the admins are told; waiting deliveries resume when it's switched back on. Test events and replays.
- **SSRF-safe delivery:**
  - only public addresses: IPv4 and IPv6 private, loopback, link-local/metadata, CGNAT, ULA, multicast, documentation and mapped forms are refused;
  - every DNS answer is checked and the connection is pinned to the checked address;
  - redirects aren't followed; requests time out after 10 s and responses are capped.
- **Developers page:** keys, endpoints, a per-endpoint delivery log with payload and attempt detail, and verification instructions.

**Integrations** (`src/server/integrations/*`, `src/lib/integrations.ts`)
- Slack and Microsoft Teams (incoming webhook / workflow URLs, validated per provider, sent through the SSRF-safe client), with a new automation action **Post to Slack or Teams** (dry run included).
- Twilio SMS (test message).
- Email through Resend or SendGrid (`MAIL_PROVIDER`).
- Credentials are encrypted (AES-256-GCM), only masked hints are shown and secrets never reach the audit log; the last use and the last error are recorded.
- Google/Outlook calendars, QuickBooks, Xero and access control are listed as planned, not connectable. The `CalendarSync` contract is defined.

**Feature flags** (`src/config/flags.ts`): `public_api`, `webhooks`, `integrations`, `advanced_analytics`, `self_serve_billing`. Resolved as organization override → global override → environment → default; checked together with the plan.

**Platform console** (`/admin`, `/admin/orgs/{id}`)
- Organizations with plan and subscription state.
- Estimated monthly revenue from plan prices and unit counts.
- Trials ending soon, past-due and lapsed counts.
- Assistant, API and webhook activity, and failed billing events.
- Global flags, and per-organization flags, plan, trial extensions and limit overrides — each audited.

## Files created / modified

- **Schema / migrations:** `src/server/db/schema.ts`, `drizzle/0020_billing_platform.sql`, `drizzle/0021_rls_billing_platform.sql` (RLS, API-key lookup policy, backfills), `drizzle/0022_work_order_api_source.sql` (+ snapshots)
- **Config / shared:** `src/config/{plans,flags}.ts`, `src/lib/{billing,api-scopes,integrations}.ts`
- **Billing:** `src/server/billing/{entitlements,service,admin}.ts`, `src/server/billing/providers/{types,mock,stripe}.ts`
- **API:** `src/server/api/{keys,maintenance}.ts`, `src/server/api/v1/{routes,resources,serializers,handler,errors,openapi}.ts`, `src/app/api/v1/[...path]/route.ts`, `src/app/api/billing/webhook/stripe/route.ts`
- **Webhooks / integrations / network:** `src/server/webhooks/{catalog,signing,service}.ts`, `src/server/integrations/{adapters,service}.ts`, `src/server/net/safe-fetch.ts`
- **Pages:**
  - `src/app/o/[orgSlug]/settings/billing/{page.tsx,actions.ts,checkout/page.tsx}`
  - `src/app/o/[orgSlug]/settings/developers/{page.tsx,actions.ts,webhooks/[endpointId]/page.tsx,deliveries/[deliveryId]/page.tsx}`
  - `src/app/o/[orgSlug]/settings/integrations/{page.tsx,actions.ts}`, `src/app/developers/api/page.tsx`
  - `src/app/admin/{page.tsx,actions.ts,orgs/[orgId]/page.tsx}`
- **Components:** `src/components/billing/{billing-bits,admin-bits}.tsx`, `src/components/developers/developer-forms.tsx`, icons, navigation
- **Modified:**
  - plumbing: `form-action`, `after-change`, `worker`, `audit`, `env`, `db/client`, `modules/context`;
  - services: organizations (trial), members (seat limit), portfolio (property/unit limits), notifications (billing and developer notices);
  - automation: engine, actions, service, `lib/automation`, rule builder;
  - assistant: orchestrator, approvals, analytics tools;
  - mail: mailer;
  - pages: org layout (banner), settings, analytics, automations.
- **Seed:** `scripts/seed-billing.ts`, `scripts/seed.ts`
- **Tests:**
  - unit: `src/lib/billing.test.ts`, `src/config/flags.test.ts`, `src/server/net/safe-fetch.test.ts`, `src/server/webhooks/signing.test.ts`, `src/server/billing/providers/providers.test.ts`, `src/server/api/keys.test.ts`, `src/server/integrations/adapters.test.ts`;
  - integration: `tests/integration/{billing,developer-platform}.test.ts`, `tenant-isolation.test.ts`;
  - E2E: `tests/e2e/billing.spec.ts`, `playwright.config.ts`.
- **Docs:** `README.md`, `.env.example`, `docs/{architecture,ai-architecture,database-schema,roadmap}.md`, this report

## Database changes

- **Migration `0020`, 11 tables:**
  - billing: `subscriptions`, `invoices`, `usage_records`, `billing_events`;
  - API: `api_keys`, `api_idempotency`;
  - webhooks: `webhook_endpoints`, `webhook_deliveries`, `webhook_attempts`;
  - `integrations`, `feature_flags`.
- **Migration `0020`, new columns:** `outbox_events.webhooks_at` (+ partial pending index) and `audit_logs.api_key_id`. The `organizations.plan_key` default became `professional` (it now mirrors the subscription).
- **Migration `0021`:**
  - RLS on all new tables (standard tenant rule);
  - `api_key_lookup` (a request that knows only a key's hash sees exactly that key);
  - `billing_events` written by the system context;
  - `feature_flags` readable globally and per organization, writable only by platform admins;
  - backfills: existing organizations get an active, support-managed Professional subscription, and historical outbox events are marked as already fanned out.
- **Migration `0022`:** `work_orders.source` accepts `api`.

## APIs added

- **REST API v1** (bearer API keys; see `/developers/api`):
  - `GET /api/v1/me`;
  - `GET /properties`, `GET /properties/{id}`, `GET /units`, `GET /units/{id}`;
  - `GET /residents`, `GET /residents/{id}`, `GET /vendors`, `GET /vendors/{id}`;
  - `GET|POST /work-orders`, `GET /work-orders/{id}`, `POST /work-orders/{id}/status`, `POST /work-orders/{id}/assignment`;
  - `GET|POST /incidents`, `GET /incidents/{id}`;
  - `GET /complaints`, `GET /complaints/{id}`, `GET /bookings`, `GET /packages`;
  - `GET /api/v1/openapi.json` (public).
- `POST /api/billing/webhook/stripe` (Stripe-signed).
- **Server actions:**
  - plan change, cancel/resume, billing portal, development checkout;
  - API key create/revoke;
  - endpoint create/update/enable/disable/rotate/delete, test event, replay;
  - integration connect/test/disconnect;
  - platform subscription updates and feature flags.
- **Outgoing webhook events:** `work_order.created`, `work_order.status_changed`, `work_order.assigned`, `work_order.sla_breached`, `incident.created`, `complaint.created`, `booking.created`, `package.arrived`, plus `ping` (tests).

## AI capabilities added

- **The plan's monthly assistant allowance** applies alongside the organization's own cap, and the refusal says which limit was reached.
- **Read-only organizations:** read tools keep working; actions return a policy denial before anything is prepared, and approving an existing plan is blocked (re-checked at approval).
- `property_health` respects the *Property health & insights* plan feature.
- Automation rules (including the assistant-draft step) run only on plans with automation, and can now **post to Slack or Teams**.

## Tests added

- **Unit (+69, 304 total):**
  - **pricing:** quotes, yearly billing, proration, month-end period arithmetic, limit overrides, downgrade fit, change classification, every access state;
  - **flags:** resolution order;
  - **SSRF:** 27 address cases, URL shape, mixed DNS answers, a live local server for redirects, size cap and timeout;
  - **signatures:** webhook signatures and the retry schedule;
  - **development provider:** token tampering and expiry, checkout events, proration credit, scheduled downgrade, renewal and cancellation idempotency;
  - **Stripe:** form encoding, signature verification and tolerance, event mapping fixtures, checkout and plan-change requests;
  - **API keys:** format, permission intersection, property-limited keys, no widening;
  - **routes:** route matching;
  - **adapters:** integration validation, Slack/Teams/Twilio and Resend/SendGrid request shapes.
- **Integration (+57):**
  - **trials:** a new organization's trial; a one-time trial notice, then expiry to read-only;
  - **checkout:** checkout applied once; foreign or altered tokens refused; upgrade with credit; downgrade scheduled and applied at renewal (and refused when too small);
  - **lapse:** cancel → read-only → restore;
  - **access:** billing permission;
  - **limits:** property, unit (bulk) and seat limits including overrides; automation gated by plan; flags global vs per-organization and admin-only;
  - **provider events:** a failed payment → grace → read-only → paid; unknown events ignored;
  - **usage:** the usage snapshot;
  - **API keys:** creation rules and hashing;
  - **API:** authentication; cursor paging with no gaps or repeats; cross-tenant 404; property-limited keys; missing-scope 403; create through the service with idempotency, audit and outbox; status change; validation details; flag off → `feature_unavailable`; read-only → 402 for writes only; expired, revoked and creator-removed keys; rate limiting; OpenAPI shape;
  - **webhooks:** permission, one-time secret, encryption; signed delivery verified with the documented algorithm; no duplicate fan-out; retry backoff and attempt log; auto-disable with notice; held while off; replay keeps the event id; no cross-tenant deliveries;
  - **integrations:** validation, encryption, masked hints, no secrets in audit;
  - **tenant isolation:** 10 new tables in the read sweep; plant/modify attempts on subscriptions, invoices, API keys and endpoints; API-key lookup; flag writes.
- **E2E (+3):**
  - trial → development checkout → Starter → upgrade with credit line;
  - API key + endpoint → API call → signed webhook verified → delivery log and test event → the work order in the app;
  - integrations validation, API reference, and the platform console (org admin vs platform admin).

## Test results

- **Static checks:** `npx tsc --noEmit` and `npm run lint` are clean.
- **Unit and integration tests:**
  - **Unit: 304** (+69).
  - **Integration: 513** (+57), against real Postgres with pgvector; the S3 adapter is tested against an S3-compatible server.
  - **Total:** 50 files, 817 tests, all passing.
- **Assistant evaluation** (`npm run ai:eval`, demo model): **32/32**.
- **E2E: 63** Playwright runs (+3), all passing with `npm run test:e2e:batched` on a freshly reset database.
  - **Duration:** 30.5 minutes over ten batches, each with its own fresh dev server; the per-batch warm-ups total 13 minutes.
  - **Earlier run:** one billing test timed out on a first page visit (see below), and the billing batch then passed on its own.
- **Production build:** clean (`npm run build`). Smoke test on the production server (port 3100, development billing allowed):
  - **API errors:**
    - the API answers 401 with a clear message when no key is sent;
    - an invalid work order gets 400 with field-level details.
  - **API with the demo key:** it lists properties and pages work orders with a cursor.
  - **OpenAPI:** the document is 3.1 with 19 paths.
  - **Stripe webhook:** it answers 404 when Stripe isn't configured.
  - **Pages:**
    - the API reference renders in 0.37 s;
    - the server held about 206 MB.

## Bugs found and fixed during the iteration

- **Organizations weren't readable from the billing worker or seed in system context.** RLS hides `organizations` without an org — by design. Usage snapshots now enumerate organizations through the platform context, like other worker jobs.
- **Seeding order:** automation and assistant seeds ran before subscriptions existed, so plan checks treated the demo organizations as lapsed. Billing is now seeded first.
- **Month-end periods spilled over** (January 31 + 1 month = March 3). Periods now end on the last day of shorter months; covered by a unit test.
- **Invoices showed the seeding date as their issue date.** They are now issued at their period start.
- **The development checkout page crashed:** it called a client-only class helper from a server component. It now uses the link-button component.
- **The checkout confirmation lost its token:** form echo drops fields named like secrets. The field is now called `session`.
- **Stale route table in the dev server:** running `next typegen` while `next dev` was running left the dev server answering 404 for some existing pages (members, staff, unit detail). It was found by the full E2E run, which had 14 failures. A clean `.next` fixed it, and the type check is no longer run against a live dev server.
- **A new webhook secret could disappear before it was copied.** After the first endpoint (or API key) was created, the page refresh closed the panel that was showing the secret, because the panel's open state came from the server ("open when there are none"). The panel now owns its open state, so a refresh can't close it. Found by E2E.
- **The dev server was killed for running out of memory during E2E runs** (12 times while investigating). This container limits the shell's processes to about 5.8 GB. Turbopack's persistent development cache (2.9 GB on disk here) takes several GB of memory when it snapshots after compiling — reproduced by asking the assistant one question on an idle dev server: memory went from 2.5 GB to 5.7 GB in 30 seconds. With the cache off, the server stays around 1–2 GB, but compiling all 113 routes still reaches about 5 GB.
  - **E2E now runs in memory-limited setups:** Playwright's server sets `DEV_FS_CACHE=off` (read in `next.config.ts`), and `npm run test:e2e:batched` runs the suite in ten batches. Each batch gets a fresh dev server, and the warm-up compiles only that batch's routes (`E2E_WARMUP_ONLY`).
  - **The warm-up also compiles route handlers** (the assistant stream, the API, CSV exports), so the first assistant question no longer waits on a compile.
  - **The production server is unaffected:** about 240 MB while answering assistant questions.
  - **One timing failure in the first full batched run.** A billing test timed out after 10 s waiting for the webhook endpoint page; the same batch then passed on its own. The cause wasn't pinned down.
    - **Server reuse was a suspect but is ruled out:** the script now waits for the previous batch's server to exit (and stops if it doesn't), yet the warm-up compile count in the next full run was just as low.
    - **What fixed it:** that first visit to the dynamic page now waits up to 30 s, like other first-visit pages on a dev server.
- **E2E selectors:** plan cards and one-time secrets got test ids; details panels open only when closed.

## Known issues

- **Stripe** is implemented against its documented REST API and verified with signed fixtures and a mocked HTTP layer, not against Stripe's servers (no network access from this environment). Stripe downgrades take effect immediately in Stripe, with the lower price from the next invoice; with the development provider they're scheduled for the period end.
- **Twilio, Resend, SendGrid, Slack and Teams** are tested by request shape only for the same reason.
- **SMS:** Twilio is connectable and testable, but notifications aren't delivered by SMS yet — that needs per-person phone numbers, opt-in and quiet hours (planned with the privacy work in Iteration 11).
- **The rate limiter is in memory,** so the per-key API limits are per instance. The Redis adapter comes in Iteration 11.
- **Mid-period unit changes:**
  - **Plan limit checks** count current rows; a race between two simultaneous bulk unit generations could exceed a limit by one batch (each insert checks in its own transaction).
  - **Unit-count increases mid-period** are billed at the next renewal (development provider) or by Stripe's quantity sync, not prorated immediately.
- **API coverage:**
  - The API exposes the main resources but not every module: no write endpoints for bookings, packages or complaints, and no visitors, parking, inspections, tasks, documents or announcements.
  - There is no `resident.created` webhook (residents don't emit outbox events yet).
- **Plans are code configuration;** the platform console shows them and handles per-organization deals through overrides, but there is no plan editor.
- **Payment collection** for amenity fees and deposits isn't built.
- **Development-server memory:**
  - Next's dev server with Turbopack's persistent cache can briefly need several GB. On machines with 8 GB or less, start it with `DEV_FS_CACHE=off` and run E2E with `npm run test:e2e:batched`.
  - The full suite takes about 30 minutes that way, versus about 20 minutes in one batch on a larger machine.
  - The production server is not affected.

## Next iteration

**Iteration 11 — Security hardening** (details in `docs/roadmap.md`):
- a threat model and route-by-route review;
- a pen-test style suite (IDOR sweeps, privilege escalation, CSRF, XSS, injection, upload abuse, SSRF bypasses);
- Redis rate limiting;
- OIDC SSO with organization-enforced SSO/MFA;
- session and key rotation;
- privacy export/deletion and retention;
- strict security headers;
- a tamper-evident audit log;
- dependency and secret scanning.
