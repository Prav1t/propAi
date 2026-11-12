# Iteration 13 — production readiness, a full review, and the public site

This was the last planned iteration. It did three things:

1. **Production readiness**, as planned in the roadmap.
2. **A review of the whole product against the original brief.** It found two product areas that had never been built (strata meetings and leases), and they were built in this iteration. Everything still missing is listed in [`docs/spec-coverage.md`](../spec-coverage.md).
3. **A new public landing page**, interactive and designed for the subject.

## What was built

**Production readiness:**

- **Start-up safety check.** In production the server and worker refuse to start with an unsafe configuration and list every problem. `npm run config:check` prints the same report without starting.
  - **Stops the start:** a non-HTTPS or localhost address, development switches left on, no real email provider, or the app sharing the database owner's user (which would bypass tenant isolation).
  - **Warns:** twelve weaker settings, such as no Redis, local file storage or mock billing.
- **Health probes.** `/api/health/live` touches nothing. `/api/health` is readiness: it checks the database, the schema, storage, Redis, and that the app's database role can't bypass row-level security. Only a missing database or schema returns 503; anything else is reported as *degraded*.
- **Metrics.** `/api/metrics` in Prometheus format, behind a bearer token: queue depths and the age of the oldest waiting item for six queues, worker health, server errors, API request counts and latency, assistant requests. Totals only, nothing that identifies a customer.
- **Error tracking** behind an interface, with a Sentry-compatible sender (no SDK). Events carry no user, body, cookie or concrete URL.
- **Workers take turns.** A database advisory lock means two workers never run the jobs at once, and a worker that dies gives up its turn when its connection closes. Each worker records a heartbeat. On `SIGTERM` the standalone worker finishes the turn in flight before exiting.
- **CSP violation reports** are received at `/api/csp-report`, rate-limited, and logged without query strings.
- **Backups and a restore drill.** `npm run db:backup` writes a checksummed dump. `npm run db:restore-drill` restores into a scratch database and verifies row counts, row-level security on every tenant table, the app role's privileges, the migration history and every audit hash chain.
- **Load test.** `scripts/load-data.ts` and `npm run load:test`. With 150,258 work orders, one user saw p95 under 400 ms on every page tested; ten users back to back got about 12 pages a second with no errors on 2 shared vCPUs. One index came out of it: `work_orders_open_idx` took open-work queries from 24 ms to 4 ms.
- **Docker.** A `worker` image target, a non-root tools image, a liveness healthcheck, and `docker-compose.prod.yml`: Caddy for TLS, app, worker, migrations as a release step, Postgres and Redis, read-only containers with dropped capabilities.
- **Documentation:** [`deployment.md`](../deployment.md), [`operations.md`](../operations.md) (releases, migrations, backups, restore, incidents, key rotation, scaling), [`observability.md`](../observability.md) (logs, metrics, example alerts), [`security/production-checklist.md`](../security/production-checklist.md), [`demo-script.md`](../demo-script.md) and [`spec-coverage.md`](../spec-coverage.md).

**Strata governance (new module):**

- **Meetings** for a property: council, annual, special and committee meetings, with an agenda.
- **Motions** with the threshold each needs: majority, three-quarters or unanimous, counted on votes cast for or against.
- **Voting:** council members vote in the product, once each, and can change their vote until the result is recorded. Managers run meetings but don't vote. A count taken in the room can be entered instead.
- **Minutes** per agenda item and overall. Approving them needs a held meeting with no open motions, and locks the record.
- **Action items** become tasks linked to the meeting.
- **Assistant:** a `search_meetings` tool (upcoming, past, open motions).

**Leases and rent (new module):**

- **Leases** per unit with a named tenant: fixed term or month to month, rent, deposit held, due day. One lease in force per unit, enforced by the database.
- **Lifecycle:** change terms or renew, record notice with a move-out date, withdraw it, end the lease.
- **Rent:** a charge per month, created by the hourly job; payments recorded in part or in full. Lists for overdue rent and for leases ending within 60 days, with the rent roll and amount overdue.
- **Privacy:** leases are in a person's data export, and erasure respects them.
- **Assistant:** a `search_leases` tool.
- **Not included:** rent is tracked, not collected. No listings, applications, late fees or pro-rated months.

**Public landing page:**

- **A building you can click.** Six spots on a tower at dusk (elevator, a leak, the party room, a package, visitor parking, a rooftop unit). Each shows the plan the assistant would prepare, with the steps that wait for approval marked; **Approve** runs it step by step. It is labelled as a preview with sample data.
- **Example requests** that show what the assistant does with each and whether it asks first; the five approval levels; a view for each of six roles; what's included; the protections in place.
- **A pricing calculator** driven by the same plan configuration and price maths the product bills with: a unit slider, monthly or yearly, and the plan that fits.
- **Design:** one display typeface (Archivo, self-hosted), an evening palette from the subject, the app's own tokens below the hero so it follows light and dark themes. Keyboard-operable, reduced-motion aware, and phone-sized.

**Fixes found by the review:**

- **Notifications count disagreed with the bell.** The page counted unread items among the newest 100 only, so with older unread items it said "All read" and hid *Mark all read* while the bell still showed a number. Both now use the same count.
- **Earlier landing copy claimed features that didn't exist** (meeting minutes and votes). The features were built, and the remaining copy was checked against the product.

## Files created/modified

- **Operations:** `src/server/ops/{config-check,startup,metrics,health,error-tracking}.ts`, `src/app/api/{health,health/live,metrics,csp-report}/route.ts`, `src/server/worker.ts`, `scripts/{worker,config-check,restore-drill,load-data,load-test}.ts`, `scripts/backup.sh`, `src/instrumentation.ts`, `src/proxy.ts`
- **Docker:** `Dockerfile`, `docker-compose.prod.yml`, `docker/caddy/Caddyfile`, `docker-compose.yml`
- **Governance:** `src/server/modules/meetings/service.ts`, `src/lib/governance.ts`, `src/app/o/[orgSlug]/meetings/**`, `src/components/governance/vote-buttons.tsx`
- **Leasing:** `src/server/modules/leases/service.ts`, `src/lib/leasing.ts`, `src/app/o/[orgSlug]/leases/**`
- **Shared by both:** `src/app/o/[orgSlug]/governance-actions.ts`, `src/server/ai/tools/governance.ts`, `scripts/seed-governance.ts`, permissions, system roles, navigation, audit labels, privacy export and erasure
- **Landing page:** `src/app/page.tsx`, `src/components/marketing/{building-demo,sections}.tsx`, `src/components/marketing/landing.module.css`
- **Fix:** `src/components/ops/notification-list.tsx`, the notifications page
- **Tests:** `src/server/ops/ops.test.ts`, `src/lib/{governance,leasing}.test.ts`, `tests/integration/{ops,governance}.test.ts`, `tests/e2e/{marketing,governance}.spec.ts`
- **Docs:** the six new documents above, plus README, `.env.example`, roadmap, architecture, AI architecture, database schema and accessibility

## Database changes

- **`0027`:** `worker_heartbeats` (one row per worker process; not tenant data).
- **`0028`:** `work_orders_open_idx`, a partial index on open work orders.
- **`0029`:** `meetings`, `meeting_agenda_items`, `meeting_motions`, `meeting_votes`, `leases`, `rent_charges`; tasks may now come from a meeting.
- **`0030`:** row-level security on those six tables.
- **Permissions:** `meeting.vote` (council members), `lease.read` and `lease.manage` (managers, accountants).

## APIs added

- `GET /api/health/live`, `GET /api/health` (now a readiness report), `GET /api/metrics`, `POST /api/csp-report`.
- Server actions for meetings (create, agenda, motions, vote, decide, minutes, approve, status, action items) and leases (create, change terms, notice, withdraw, end, record payment).
- New commands: `config:check`, `db:backup`, `db:restore-drill`, `load:test`.
- The REST API is unchanged: meetings and leases are not in it yet.

## AI capabilities added

- Two read tools, `search_meetings` and `search_leases`, with the same permission checks as the pages, and demo-mode phrasings for both ("What motions are still open?", "Who is behind on rent?").
- Four new evaluation cases (36 in total), including a resident being refused lease data.
- No new actions: the assistant can't create meetings, cast votes or record payments.

## Tests added

- **Unit (+41, 403 in total):** the configuration check (each refusal and warning), the metrics format, the error-tracking envelope and delivery, motion thresholds, lease dates and money.
- **Integration (+29, 659 in total):**
  - `ops.test.ts` (8): probes, a degraded dependency, the database role check, worker turn-taking and a dead worker's turn being released, shutdown waiting for the turn in flight, the metrics token and contents.
  - `governance.test.ts` (11): property scope, cross-organization writes refused by the database, one vote each, managers not voting, thresholds, minutes locking, cancelling, rent charges, part payments, new terms, notice and ending.
  - The six new tables joined the cross-organization isolation sweep, which accounts for the rest.
- **E2E (+8):** `marketing.spec.ts` (4: the building preview, example requests and roles by keyboard, pricing maths, accessibility and phone width) and `governance.spec.ts` (4: a meeting from agenda to locked minutes, property scope, recording a rent payment, a new lease through to notice).

## Test results

All of these ran on the final code in this commit.

| Check | Result |
|---|---|
| Type check, lint | clean |
| Vitest (unit + integration + security) | **69 files, 1,062 tests passed** |
| Assistant evaluation | 36/36 (demo mode) |
| Secret scan | no secrets in the 680 files of this commit |
| Dependency gate (production) | 0 advisories |
| Production build | OK |
| E2E (Playwright, 16 batches, fresh database) | **112 passed, 0 failed, 0 flaky** in 40 minutes. The 7 skips are phone-only tests in the desktop project, which run in the phone project |
| Restore drill | 6 checks passed on the development database |
| Accessibility (axe, production build) | landing page and the new pages: no findings in light, dark and phone |
| Compose files | both pass `docker compose config` |

The first full run of this iteration had 2 failures:

- a test that didn't wait for a save to finish (fixed in the test);
- the notifications count bug described above (fixed in the product).

After the last code change (moving Node-only start-up code into its own module, which removed four build warnings) the Vitest suites, the build and the affected E2E specs (UX, PWA, governance and marketing: 17 tests) were run again and passed. The other batches were not rerun after that change.

**Production smoke test** (`next start`): readiness reported every check `ok`; metrics refused a missing token and served 16 series with one; a CSP report was logged without its query string; the landing page loaded its font from the app itself with no console errors or failed requests.

**Not run:**

- `docker build` and `docker compose up`: this environment has no Docker daemon.
- Anything against real outside services: a language model, an email provider, Stripe, push services, an identity provider, Sentry.

## Known issues

- **The Docker images have never been built.** Treat the first build as a test.
- **Meetings and leases are newer than everything else** and have had one iteration of testing. They are not in global search, the calendar, the REST API or webhooks, and residents can't see their own lease.
- **Rent is tracked, not collected**, with whole-month charges only.
- **General meetings:** owner voting, proxies and notices aren't built; voting is for council members.
- **Page latency isn't in the app's metrics**; take it from the reverse proxy.
- **The load test ran on one small shared machine** with synthetic data.
- **Placeholders:** the product is still called "[YOUR PRODUCT NAME]". Change `src/config/brand.ts` before showing it.
- Everything in [`spec-coverage.md`](../spec-coverage.md) marked *Partly* or *Not built*.

## Next iteration

There is no Iteration 14 in the plan. The order of work from here is in [`docs/roadmap.md`](../roadmap.md): deploy to a staging host with real services and walk the demo script, name the product, legal documents, an independent security test, then a pilot with one building.
