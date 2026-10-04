# Architecture

_Iteration 0 design, updated each iteration with what is actually built (last: Iteration 6). Sections marked **(planned)** are not implemented yet._

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
| Files | `BlobStore` interface: local disk or S3-compatible object storage (AWS S3, MinIO, R2) with presigned URLs and a scanning hook (§9) | Portable across AWS/GCP/Azure/on-prem |
| Email | `Mailer` interface: `console` (dev outbox table) and `smtp` providers; Resend/SendGrid adapters later | Works with zero config in dev; Mailpit in Docker |
| AI | `ChatModel` provider abstraction (Anthropic, OpenAI, any OpenAI-compatible server, demo) + typed, permission-filtered tool registry over the domain services + streamed orchestrator (Iteration 6, read-only); policy engine and approvals in Iteration 7; see `ai-architecture.md` | The model never touches the database; it can only call tools that run the same service code as the UI |
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
                               └─ ai/             providers, tool registry, orchestrator, usage/caps, eval
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
- **List queries** apply `scopeCondition(principal, columns)` (in `src/server/modules/scope.ts`), which turns the principal's scope into a SQL predicate on `property_id` / `building_id` / `unit_id`. Resident lists use an `EXISTS` over current occupancies in scope.
- **Record-level rules added in Iteration 2:** residents only see their own unit (and household names, not neighbours' contact details); scoped managers only see residents with a current occupancy in their scope; vendor users carry `vendorId` for assigned-work visibility; vendors are an org-wide directory with management limited to vendors serving the manager's properties.

### Search

Postgres full-text search over generated `tsvector` columns (config `simple`) with GIN indexes. User input goes through `toPrefixQuery()`, which strips all tsquery operators and builds a prefix `AND` query, so typed text can never inject query syntax. Global search runs one query per entity type the principal can read, each with the same scope predicate as the list pages. The Cmd/Ctrl-K palette calls it through a server action.

### Operations records (Iteration 3)

Each record type has one access function used by its list query (as SQL), its detail page and every mutation:

| Viewer | Work orders | Timeline / files they see |
|---|---|---|
| Manager (`workorder.manage` on the property) | all in scope; triage, assign, schedule, any transition | public + vendor + internal |
| Staff reader (`workorder.read`) | all in scope, read-only | public + vendor + internal |
| Assignee / vendor user (`workorder.read.assigned`) | only work assigned to them or their company; schedule and move work along, never cancel/close/reopen | public + vendor |
| Requester (`workorder.read.own`) | only their own requests (or their resident record's); withdraw before work starts | public only; entry notes and vendor phone hidden |

Incidents, complaints, tasks and inspections follow the same pattern (scoped staff, assignee, reporter/submitter), with internal notes never shown to residents and `people_involved` hidden from non-staff reporters. Status rules live in pure functions (`maintenance/rules.ts`) with unit tests.

### Community records (Iteration 4)

| Record | Staff (permission on the property) | Residents |
|---|---|---|
| Amenities | `amenity.manage` configures rules and closures | see active amenities of their property (and their building, for building-only amenities) |
| Bookings | `booking.manage` approves/declines, books for any unit, records fees/deposits and damage | book for their own unit if eligible (role list on the amenity); see and cancel only their unit's bookings, up to the cancellation cut-off |
| Packages | `package.manage` logs, releases (pickup code or signature), returns | see their unit's packages and pickup codes; staff lists never show codes |
| Announcements | `announcement.manage` drafts, schedules, publishes, archives; read counts | see published, unexpired posts whose property, buildings and audience include them |
| Messages | `message.manage` works the inbox, assigns, closes, writes internal notes, uses templates | start and reply to their own threads; internal notes are filtered out server-side |
| Documents | `document.manage` uploads, versions, archives | `audience` residents/owners, matched to their unit, building, property or org-wide; only the current version |

The access rules are one function per record (`canReadDocument`, `documentVisibleWhere`, …) used by the list query, the detail page and every mutation, as in Iteration 3.

### Front desk & facility records (Iteration 5)

| Record | Staff | Residents |
|---|---|---|
| Visitors | `visitor.manage` on the building: register, walk-in, scan, check in/out, turn away, see the log | `visitor.invite`: invite guests to their own unit, see/cancel those visits, reissue the pass link |
| Parking | `parking.manage`: spaces, permits, vehicles, plate lookup, violation reports, review, notices | `parking.use`: their unit's spaces, permits, vehicles (register/remove, max 4) and notices actually issued to them — never reports, evidence or who reported |
| Shifts | `shift.manage` schedules staff whose role scope covers the property; `shift.read` sees the team schedule (building-scoped staff also see property-wide shifts), clocks in/out of their own shifts, writes and acknowledges handoffs | — |
| Assets | `asset.manage` registers assets, schedules PM, changes status; `asset.read` (e.g. maintenance staff) reads within scope | none; the equipment link is hidden on residents' requests |

New permissions: `visitor.invite`, `parking.use`, `shift.read` (59 total).

### Assistant records (Iteration 6)

| Record | Who | Rule |
|---|---|---|
| Conversations and transcripts (`ai_conversations`, `ai_messages`) | the author only | RLS requires both `org_id = app_org()` **and** `user_id = app_user()`; not even org admins or platform admins can read someone else's conversation |
| Tool-call log (`ai_tool_calls`), usage (`ai_usage`) | org admins with `ai.settings.manage` | tenant RLS; shown on *Organization → AI assistant* |
| What the assistant can read | the asking user's own permissions | `ai.use` gates the assistant; each tool declares the permissions it needs and the services re-check every record. Residents, staff without directory access and vendors (no `ai.use`) are never offered tools they can't use |

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
- File uploads: magic-byte type detection, size limits, scanning hook, permission-checked and audited downloads (§9).
- Planned: SSRF-safe fetcher for webhooks (Iteration 10), a real malware scanner adapter (ClamAV) and secret rotation guide (Iteration 13).

## 8. Events, notifications and the worker (Iteration 3)

```
service (one transaction)                 worker (system context)
  update work_orders ...                     drainOutbox()
  insert timeline_events ...                   for each pending outbox_events row:
  insert audit_logs ...                          claim it (SELECT … FOR UPDATE SKIP LOCKED)
  insert outbox_events (type, payload) ──▶      deliveriesFor(event) → recipients + message
                                                 insert notifications (unique per event+user)
                                                 mark processed; commit; then send emails
```

- **Transactional outbox:** `emit()` writes an `outbox_events` row in the same transaction as the change, so an event exists if and only if the change committed (`emitSystem()` does the same from worker jobs). Event types so far: `workorder.created|assigned|status_changed|commented|sla_breached`, `task.assigned`, `incident.created|escalated`, `complaint.created|status_changed|commented`, `inspection.failed`, and from Iteration 4 `booking.created|decided|cancelled`, `package.arrived|reminder|released`, `announcement.published`, `message.posted` (community deliveries live in `notifications/community.ts`), and from Iteration 5 `visitor.checked_in|denied`, `parking.violation_reported|notice_issued`, `shift.handoff_created`, `asset.down` (`notifications/facility.ts`).
- **Delivery** (`src/server/modules/notifications/service.ts`): recipients are resolved from live data (managers whose role and scope cover the property; the assignee; the vendor's users; the requester), the actor is excluded, and a comment's visibility limits who hears about it. Notifications are unique per `(event_id, user_id)`, so re-processing is harmless; emails go out only after commit. Per-user, per-kind preferences control in-app and email.
- **Triggers:** right after a form action (`after()` in `runOrgForm`), on an in-process 30-second loop started from `src/instrumentation.ts`, or a separate `npm run worker` process (set `DISABLE_INPROCESS_WORKER=true` on app instances when you run it).
- **System context:** the worker sets `app.system = 'on'`, which lets RLS read across orgs to find pending work. Writes still require naming the org (`WITH CHECK (org_id = app_org())`), and a request context can only notify its own user.
- **Worker jobs per tick**, then the outbox is drained:
  - **SLA monitor:** flags open work orders past `resolve_due_at` once (`sla_breached_at`), adds an internal timeline entry, and emits `workorder.sla_breached`.
  - **Scheduled announcements:** publishes those whose `publish_at` has passed and emits `announcement.published` (notifies the audience if the author asked to).
  - **Package reminders:** one reminder per package waiting `PACKAGE_REMINDER_DAYS` (default 3; perishables after 1 day).
  - **Preventive maintenance:** opens a work order for each schedule whose lead window has started (in the property's time zone), assigns the schedule's vendor/staff if still valid, and moves `next_due_on` on. Missed occurrences are skipped (one work order for the latest, never a backlog); the schedule row is locked with `FOR UPDATE SKIP LOCKED`, so concurrent workers can't double-generate.
  - `npm run worker -- --once` runs a single tick for cron-style schedulers.
- **Next:** the workflow engine (Iteration 9), webhooks (10) and AI insights subscribe to the same outbox.

## 9. File storage (Iteration 3)

- `BlobStore` interface with two adapters: **local disk** (`FILE_STORAGE=local`, path-traversal-safe keys) and **S3-compatible** (`FILE_STORAGE=s3`: AWS S3, MinIO, R2).
- Keys are `{orgId}/{entity}/{uuid}`; the `files` row stores the owner record, sniffed MIME type, size, SHA-256, visibility (`public`/`vendor`/`internal`, the same levels as the timeline) and scan status.
- **Upload:** the real type is detected from magic bytes (JPEG, PNG, WebP, GIF, HEIC, PDF, MP4, MOV; for documents also DOCX/XLSX/PPTX, recognised as ZIP packages containing `[Content_Types].xml`, and UTF-8 TXT/CSV); the browser's claim is ignored. Each owner type has its own allow-list (media for work orders, `DOCUMENT_TYPES` for the library). Per-type size limits; at most 5 files per upload; a `FileScanner` hook (no-op by default) can block files. Blobs are deleted if the database insert fails.
- **Download:** `/o/{org}/files/{id}` re-checks access to the owning record and the file's visibility, writes a `file.downloaded` audit entry, then streams bytes (local) or redirects to a 60-second presigned URL (S3). Responses carry `nosniff`, a sandboxing CSP and `Content-Disposition` (only raster images render inline). Storage URLs are never stored or shown.
- **Owners added in Iteration 4:** `package` (intake photo visible to the resident; pickup signature internal) and `document` (each version is a file; superseded versions become internal, so residents only ever download the current one). Document views are audited (`document.viewed`) as well as downloads.
- **S3 options:** `S3_SSE=none` turns off SSE-S3 for MinIO without a KMS; `S3_PUBLIC_ENDPOINT` signs download URLs for the host the browser can reach (e.g. `localhost:9000`) while the app talks to `minio:9000`. The adapter is tested against a real S3-compatible server when `S3_TEST_ENDPOINT` is set.

## 9a. Community modules (Iteration 4)

- **Booking rules engine** (`amenities/rules.ts`, pure and unit-tested): given the amenity's rules, the proposed slot (in the property's time zone, DST-safe), existing bookings, closures, the resident's role and recent bookings, `evaluateBooking()` returns every problem at once (outside hours, off the slot grid, too short/long, too little notice, too far ahead, not eligible, too many people, fully booked — `max_concurrent` bookings at once, closed, over the per-unit limit) plus the resulting status (`requested` when approval is required, otherwise `approved`) and the fee/deposit due. Staff bookings skip notice, advance window, eligibility and per-unit limits and are approved directly, but never bypass hours, closures or capacity. Iteration 7's AI booking tool will call the same function.
- **Concurrency:** booking creation locks the amenity row, re-reads overlapping bookings and evaluates capacity inside that transaction; exclusive amenities are also protected by the `bookings_no_overlap` exclusion constraint, so two simultaneous requests can never both succeed.
- **Packages:** carrier detection from the tracking number (`packages/carrier.ts`), recipient matched to the unit's occupants, a random 6-digit pickup code shown only to the resident, release by code or on-screen signature (stored as an internal PNG), bulk release, returns, reminders.
- **Announcements:** property + building list + audience targeting resolved to users at publish time (`audienceUserIds`), schedule/expiry, read receipts, `{{property}}`/`{{org_name}}`/`{{today}}` placeholders.
- **Messaging:** one thread per resident conversation, unread tracking per user, assignment, internal notes, and reply templates rendered per thread with `{{resident_name}}`, `{{unit}}`, … (`src/lib/template.ts`); unknown variables are rejected when a template is saved and flagged if data is missing when it's inserted.
- **Resident app:** a mobile-first home (package banner with pickup codes, unread replies, quick actions, announcements, requests, bookings, important documents, emergency contacts), a bottom tab bar on phones, nav badges, and a web app manifest (installable to the home screen; push notifications are not implemented yet).

## 9b. Front desk & facility modules (Iteration 5)

- **Guest passes:** a pass is a 192-bit random token; only its SHA-256 is stored. The QR code encodes `APP_URL/pass/{token}`; the guest needs no account. The public page reads the single matching row through the `visitor_pass` RLS policy and shows only the guest's first name and initial, the building and the window — never the host or unit. It's rate-limited per IP, `noindex`, `no-referrer`. The link is shown to the inviter once (pass card with copy/share); "Get a new pass link" replaces it, and check-out, cancellation or denial clears it. The desk scans with the device camera (`BarcodeDetector`) or a handheld scanner typing into the box, or searches by name/unit. Check-in outside the window (an hour early to the end) requires an override with a reason, kept in the audit log.
- **Visitor parking:** at check-in the desk can pick a free visitor space; a visitor permit is issued for the visit and ended at check-out. The exclusion constraint makes double assignment impossible even with two desks.
- **Parking enforcement is human-reviewed:** staff reports and camera detections (`ingestDetection`, the entry point for a future licence-plate-recognition integration) land as `reported`. Nothing reaches a resident until a person **confirms** it; then a notice can be issued, which notifies the residents of the matched unit. Detections are labelled with their confidence everywhere. Organizations can require a second staff member to review a report (`parkingSecondReviewer`). The plate lookup returns facts for a person to act on, not a verdict.
- **Shifts and on-call routing:** shifts can be repeated weekly, and `on_call` marks after-hours coverage. When a maintenance request is an emergency and triage didn't assign anyone, it is assigned to the person on call at that property right now (a role that can work requests), with a timeline note. With nobody on call it stays with the managers (who are always notified of emergencies).
- **Handoffs:** writing a handoff stores the notes plus a snapshot of open items at that moment (emergencies, incidents, visitors on site, packages, messages needing a reply, bookings, parking reports, tasks) built only from what the author can see; people on shift now or starting within three hours are notified, and someone other than the author acknowledges it.
- **Assets, PM and downtime:** a work order can name the equipment and mark it out of service, which opens a downtime record and sets the asset `down`. Completing, closing or cancelling that work order closes the downtime and returns the asset to service. The asset page shows recorded facts only: reactive requests in 90 days, downtime hours, cost over 12 months, PM history.
- **Unified calendar** (`calendar/service.ts`): merges scheduled work orders, inspections, PM due dates, bookings, visitors, shifts and task due dates into day/week/month/agenda views. Each source applies its own list visibility rule (the same predicates as the module pages), so residents see only their own bookings, guests and scheduled visits.
- **Front desk console** (`/desk`, and the dashboard for concierge and security roles): pass scanner, expected and on-site visitors, packages, messages needing a reply, bookings, open incidents, the current shift with clock in/out and the last handoff, parking status with plate lookup.

## 9c. Assistant (Iteration 6)

- **Flow:** `POST /o/{org}/assistant/stream` (same-origin check, session, membership) → `runAssistantTurn()` streams newline-delimited JSON events (`start`, `status`, `tool_start`/`tool_end`, `text`, `notice`/`error`, `done`). The orchestrator checks the per-user rate limit and the organization's enable switch and monthly cap, stores the question, then loops model ↔ tools (step limit, timeout, one retry on overload) and writes the transcript, every tool call and a usage row.
- **Tools** (`src/server/ai/tools/*`) are thin adapters over the module services, typed with Zod and converted to JSON Schema for providers. Free-text references (a property, building, unit, amenity or vendor name) are resolved only among records the user can see; several matches come back as `AMBIGUOUS` with options, so the assistant asks. Results carry a factual summary, compact items with links, and separately a *display* (record cards, metrics) that the UI renders from the data — never from model text.
- **Providers:** fetch-based adapters for the Anthropic Messages API and Chat Completions (OpenAI and compatible servers), both streamed; selection by environment. Without a key the **demo model** plans tool calls with fixed rules and answers from tool results, and every answer is labelled.
- **UI:** the *Assistant* page (history, modes, suggestions, streamed answer with a lookup trail and record cards, safe markdown with in-app links only), Cmd/Ctrl-K "Ask …", and an ask box on the dashboards. See `ai-architecture.md`.

## 10. Integrations (planned, Iteration 10)

`src/server/integrations/<kind>/<provider>.ts` implementing interfaces (`Mailer`, `SmsSender`, `PaymentProvider`, `CalendarSync`, `AccessControl`). Selection by env + per-org config. Credentials encrypted with the app encryption key.

## 11. Deployment

- **Dev:** `docker compose up` → Postgres (pgvector image), Mailpit, app; add `--profile s3` with `FILE_STORAGE=s3` for MinIO. Or run Postgres yourself and `npm run dev`.
- **Prod:** build image with `Dockerfile` (multi-stage, `output: "standalone"`, non-root user). Run `npm run db:migrate` as a release step with the owner URL; run app with the least-privilege URL. Put behind a TLS-terminating proxy/load balancer. Managed Postgres with PITR backups.
- Health: `GET /api/health` (liveness + DB check).
