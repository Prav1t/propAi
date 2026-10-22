# Architecture

_Iteration 0 design, updated each iteration with what is actually built (last: Iteration 8). Sections marked **(planned)** are not implemented yet._

## 1. Decisions at a glance

| Concern | Decision | Why |
|---|---|---|
| Shape | **Modular monolith** in one Next.js app, with domain modules under `src/server/modules/*` | One deployable, one DB, clear module seams. Split out workers/services when load demands, not before |
| Web framework | **Next.js 16 (App Router) + React 19 + TypeScript** | Server Components for data-heavy screens, Server Actions for forms, Route Handlers for the public REST API |
| Styling | **Tailwind CSS v4** + in-house component library in `src/components/ui` | No generic dashboard kit; consistent, accessible primitives |
| Forms | Server Actions + `useActionState` + **Zod** (shared schemas) | Progressive enhancement, one validation source. React Hook Form / TanStack Query are introduced where client-heavy interaction needs them (AI chat, calendars) |
| Database | **PostgreSQL 16** + **pgvector** (required from Iteration 8) | Relational core, RLS, JSONB, full-text search, vectors in one engine |
| ORM / migrations | **Drizzle ORM** + drizzle-kit SQL migrations | Pure TypeScript (no engine binaries), SQL-transparent, first-class raw SQL for RLS, FTS and pgvector. Chosen over Prisma for RLS/`set_config` ergonomics and zero native-binary downloads |
| Auth | Session-cookie auth built on vetted primitives: **argon2id** (`@node-rs/argon2`), CSPRNG tokens, SHA-256 token hashing, **TOTP** via `otplib`, AES-256-GCM for MFA secrets | Follows the OWASP session-management and Lucia-style guidance; no home-made crypto. OAuth/SSO adapters slot in beside the password provider (Iteration 11) |
| Jobs / events | Transactional **outbox table** + worker; queue = **pg-boss** (Postgres) first, Redis/BullMQ if throughput requires **(planned, Iteration 9)** | Keeps ops to one datastore early; outbox guarantees events are never lost on commit |
| Cache / rate limit | In-process limiter behind a `RateLimiter` interface now; Redis adapter when running >1 instance **(planned)** | Honest about current scale; interface avoids rewrite |
| Files | `BlobStore` interface: local disk or S3-compatible object storage (AWS S3, MinIO, R2) with presigned URLs and a scanning hook (§9) | Portable across AWS/GCP/Azure/on-prem |
| Email | `Mailer` interface: `console` (dev outbox table) and `smtp` providers; Resend/SendGrid adapters later | Works with zero config in dev; Mailpit in Docker |
| AI | `ChatModel` provider abstraction (Anthropic, OpenAI, any OpenAI-compatible server, demo) + typed, permission-filtered tool registry over the domain services + streamed orchestrator (Iteration 6); action tools, policy engine and approval plans (Iteration 7); see `ai-architecture.md` | The model never touches the database; it can only call tools that run the same service code as the UI |
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
                               ├─ ai/             providers, tool registry, orchestrator, policies, approvals, eval
                               └─ kb/             extraction, chunking, embeddings, indexing queue, retrieval
                                      │
                      ┌───────────────┼──────────────────┐
                 PostgreSQL 16     Object storage     SMTP / providers
              (RLS, FTS, pgvector)  (local disk / S3)   (LLM, embeddings, SMS…)
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
| Search / AI / files | all go through the same tenant-scoped services. Retrieval passages (`kb_chunks`) are under RLS and filtered by the reader's audience and place before ranking; files are re-authorized on every download |

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
| What the assistant can change | the asking user's own permissions, **after their approval** | action tools only prepare steps; the requester approves a plan (server action, row-locked, expires in 24 h), which re-checks the role and the org's AI policies, then runs the domain services as that user with `ai_generated` + `approval_id` in the audit log. Org admins (`ai.settings.manage`) set per-org/per-property rules (`ai_policies`): low-risk internal changes may run without asking; anything that contacts residents always needs approval |

## 7. Security baseline

Implemented in Iteration 1 unless marked planned:

- argon2id password hashing (memory 19 MiB, t=2, p=1 — OWASP minimum), common-password rejection.
- Session cookie `HttpOnly`, `Secure` (prod), `SameSite=Lax`, `__Host-` prefix in production; tokens hashed at rest.
- CSRF: Server Actions are POST-only with Next's built-in Origin/Host check; JSON API route handlers require same-origin `Origin` for cookie-authenticated mutations; API keys (Iteration 10) are header-based and CSRF-immune.
- Rate limiting on login, registration, password reset, MFA (per IP and per identifier).
- Security headers: HSTS (prod), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, and (Iteration 11) a strict per-request **nonce CSP** set in `src/proxy.ts`. Every page renders per request so its scripts carry the nonce.
- All input validated with Zod at the boundary; all SQL parameterised via Drizzle.
- Generic auth errors (no account enumeration on login / reset).
- Audit log for auth, membership and settings changes.
- File uploads: magic-byte type detection, size limits, scanning hook, permission-checked and audited downloads (§9).
- SSRF-safe fetcher for webhooks, integrations and OpenID Connect (Iteration 10/11).
- Planned: a real malware scanner adapter (ClamAV) (Iteration 13).

**Iteration 11 hardening** (threat model and finding log: [`docs/security/threat-model.md`](security/threat-model.md)):

- **Client address:** from trusted proxies only (`TRUSTED_PROXY_HOPS` / `CLIENT_IP_HEADER`, `src/server/client-ip.ts`).
- **Rate limits:** shared across instances through Redis (sliding window), with a per-instance fallback.
- **Sessions:**
  - record how they were established (`amr`: pwd, otp, recovery, sso, sso_mfa);
  - slide, with an absolute limit;
  - other sessions end on password and MFA changes.
- **TOTP:** each code is accepted once.
- **Re-confirmation:** sensitive actions call `requireRecentAuth()` (`src/server/reauth.ts`): a sign-in or confirmation from the last 10 minutes, otherwise *Confirm it's you* and back.
- **Cross-site writes:** the proxy refuses cookie-authenticated writes whose Fetch Metadata or Origin says another site (API and provider webhooks are exempt).
- **Single sign-on:** OpenID Connect per organization (`src/server/sso/*`):
  - authorization code + PKCE, state and nonce;
  - ID token signatures checked against the provider's keys;
  - DNS-verified domains, optional just-in-time membership;
  - discovery and token calls through the SSRF-safe fetch.
- **Organization policy:** MFA for staff/everyone, and SSO for staff, decided per request in `orgPrincipalForSession()` (`src/lib/security-policy.ts`). Applied in `getOrgContext()` and in every cookie-authenticated route handler.
- **Secrets at rest:** a keyring (`src/server/keyring.ts`, `v2.<keyId>.…` with the id bound as AAD); `npm run keys:rotate` re-seals.
- **Audit log:** a per-organization SHA-256 hash chain maintained by a trigger, `audit_verify()`, an immutability trigger, and daily checkpoints written to a table and to the logs (`src/server/audit-integrity.ts`).
- **Privacy:** per-person export and erasure, legal holds, retention and consent history (`src/server/privacy/service.ts`); the worker applies retention daily.
- **Membership changes:** member management is limited to the manager's own scope, and resident deletion only touches resident access.

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
- **Indexing queue (Iteration 8):** documents and knowledge entries mark their `kb_sources` row queued in the same transaction as the change; the request's `after()` hook and the worker tick both run `processIndexQueue()` (claims with `FOR UPDATE SKIP LOCKED`, three attempts, stale claims recovered after 10 minutes). Extraction and embedding run outside any transaction; passages are swapped in one transaction.
- **Automation (Iteration 9)** consumes the same outbox a second time: `processed_at` marks notification delivery, `automation_at` marks rule evaluation, so neither consumer can starve or double-process the other (§9d). New event types: `workorder.sla_approaching`, `document.uploaded`, `workflow.notify` (notifications sent by a rule, including approval requests) and `brief.ready`. New worker jobs: the due-soon monitor, scheduled rules, automation runs, daily briefs and a sweep for runs interrupted by a restart.
- **Webhooks (Iteration 10)** are the outbox's third consumer: `webhooks_at` marks fan-out (§10). New event types: `billing.trial_ending|trial_ended|payment_failed|subscription_ended` (to people with `billing.manage`) and `webhook.endpoint_disabled` (to people with `api.manage`). New worker jobs: billing (trial notices and expiry, development-provider renewals, support-managed period roll-over), webhook fan-out and due deliveries, and an hourly usage snapshot plus clean-up of 24-hour idempotency records.

## 9. File storage (Iteration 3)

- `BlobStore` interface with two adapters: **local disk** (`FILE_STORAGE=local`, path-traversal-safe keys) and **S3-compatible** (`FILE_STORAGE=s3`: AWS S3, MinIO, R2).
- Keys are `{orgId}/{entity}/{uuid}`; the `files` row stores the owner record, sniffed MIME type, size, SHA-256, visibility (`public`/`vendor`/`internal`, the same levels as the timeline) and scan status.
- **Upload:** the real type is detected from magic bytes (JPEG, PNG, WebP, GIF, HEIC, PDF, MP4, MOV; for documents also DOCX/XLSX/PPTX, recognised as ZIP packages containing `[Content_Types].xml`, and UTF-8 TXT/CSV); the browser's claim is ignored. Each owner type has its own allow-list (media for work orders, `DOCUMENT_TYPES` for the library). Per-type size limits; at most 5 files per upload; a `FileScanner` hook (no-op by default) can block files. Blobs are deleted if the database insert fails.
- **Download:** `/o/{org}/files/{id}` re-checks access to the owning record and the file's visibility, writes a `file.downloaded` audit entry, then streams bytes (local) or redirects to a 60-second presigned URL (S3). Responses carry `nosniff`, a sandboxing CSP and `Content-Disposition` (only raster images render inline). Storage URLs are never stored or shown.
- **Owners added in Iteration 4:** `package` (intake photo visible to the resident; pickup signature internal) and `document` (each version is a file; superseded versions become internal, so residents only ever download the current one). Document views are audited (`document.viewed`) as well as downloads.
- **S3 options:** `S3_SSE=none` turns off SSE-S3 for MinIO without a KMS; `S3_PUBLIC_ENDPOINT` signs download URLs for the host the browser can reach (e.g. `localhost:9000`) while the app talks to `minio:9000`. The adapter is tested against a real S3-compatible server when `S3_TEST_ENDPOINT` is set.

## 9a. Community modules (Iteration 4)

- **Booking rules engine** (`amenities/rules.ts`, pure and unit-tested): given the amenity's rules, the proposed slot (in the property's time zone, DST-safe), existing bookings, closures, the resident's role and recent bookings, `evaluateBooking()` returns every problem at once (outside hours, off the slot grid, too short/long, too little notice, too far ahead, not eligible, too many people, fully booked — `max_concurrent` bookings at once, closed, over the per-unit limit) plus the resulting status (`requested` when approval is required, otherwise `approved`) and the fee/deposit due. Staff bookings skip notice, advance window, eligibility and per-unit limits and are approved directly, but never bypass hours, closures or capacity. The assistant's `create_booking` action calls the same function (through `previewBooking`) before preparing a plan.
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

- **Flow:** `POST /o/{org}/assistant/stream` (same-origin check, session, membership) → `runAssistantTurn()` streams newline-delimited JSON events (`start`, `status`, `tool_start`/`tool_end`, `text`, `plan`, `notice`/`error`, `done`).
- **Actions (Iteration 7):** action tools `prepare` a step (resolve references, dry-run the real rules, no writes); the policy engine decides per step and property whether it runs now (`auto`, class 2 only), waits in the turn's **plan** (`ai_approvals`) or is refused. Approve / Edit / Cancel are server actions on the plan card; approving re-authorizes and executes each step through the same services as the UI with `TenantCtx.ai = { approvalId }`, verifies by re-reading, stops at the first failure, and drains the outbox so notifications go out. The orchestrator checks the per-user rate limit and the organization's enable switch and monthly cap, stores the question, then loops model ↔ tools (step limit, timeout, one retry on overload) and writes the transcript, every tool call and a usage row.
- **Tools** (`src/server/ai/tools/*`) are thin adapters over the module services, typed with Zod and converted to JSON Schema for providers. Free-text references (a property, building, unit, amenity or vendor name) are resolved only among records the user can see; several matches come back as `AMBIGUOUS` with options, so the assistant asks. Results carry a factual summary, compact items with links, and separately a *display* (record cards, metrics) that the UI renders from the data — never from model text.
- **Providers:** fetch-based adapters for the Anthropic Messages API and Chat Completions (OpenAI and compatible servers), both streamed; selection by environment. Without a key the **demo model** plans tool calls with fixed rules and answers from tool results, and every answer is labelled.
- **Knowledge (Iteration 8):** `src/server/kb/*` indexes documents and knowledge-base entries into passages (extract → heading-aware chunks → embeddings through an `EmbeddingModel` adapter: Voyage, OpenAI, OpenAI-compatible, or a local hashing embedder without a key). `searchKnowledge()` filters passages by organization, audience, place, active status and current version in SQL, then fuses vector and full-text rankings; the `search_knowledge` / `retrieve_policy` tools return passages with citation links. Admins manage entries, see index status and test questions on *Knowledge base* (`knowledge.manage`).
- **UI:** the *Assistant* page (history, modes, suggestions, streamed answer with a lookup trail and record cards, safe markdown with in-app links only), Cmd/Ctrl-K "Ask …", and an ask box on the dashboards. See `ai-architecture.md`.

## 9d. Analytics & automation (Iteration 9)

**Metric catalog** (`src/server/analytics/metrics.ts`). One typed definition per metric — 24 of them across work orders, complaints, incidents, inspections, downtime, bookings, packages and tasks. Each is a SQL expression over one *source* (the table, its date column, its dimensions and a scope condition), so every number is a query over recorded rows; nothing is estimated or cached in application code.
- **Scope first:** every query is restricted to the reader's visible properties (`visiblePropertyIds`) inside `withContext`, and RLS still pins the organization. Reading analytics needs `analytics.read`; the dashboard's operational tiles use the same definitions with `{ operational: true }` for roles that manage work orders.
- **Periods** are whole local days in the organization's time zone (`period.ts`): presets (7/30/90 days, month/quarter/year to date) or custom dates, DST-safe, with the comparison period being the same number of days immediately before (or the same span of last quarter). Series buckets follow Postgres `date_trunc` (weeks start Monday) and are filled so empty buckets show as zero.
- **Breakdowns** by property, building, category, priority, vendor, type, severity, amenity, carrier or assignee, labelled from the same label maps the UI uses.
- **Formatting** (`fmtValue`, `fmtChange`) is shared by pages, CSV and the assistant, so a number reads the same everywhere; a change is coloured by whether *up* is good for that metric.

**Reports** (`reports.ts`): 10 reports built from the catalog plus per-row detail queries, each with a CSV export (`/analytics/reports/{key}/csv`: RFC 4180 quoting, a UTF-8 BOM for spreadsheets, cells starting with `= + - @` neutralised against formula injection, every export audited as `report.exported`) and a print layout (navigation and filters are hidden with `data-print-hide`).

**Property health score** (`health.ts`): eight factors — resolved within SLA, responded within SLA, overdue share of the backlog, open backlog per 100 units, complaints per 100 units, serious incidents, inspection failure rate and equipment availability. Each factor is scored 0–100 by a fixed, documented rule (`scoreFactor`), weighted by the organization's weights (*Settings → Analytics & automation*), and factors without data are left out with the rest re-weighted (`combineHealth`). The page shows each factor's raw value, score, weight, points contributed and a link to the records behind it — the score is never shown without its explanation. Grades: Healthy ≥ 80, Watch ≥ 60, otherwise Needs attention.

**Insights and the daily brief** (`insights.ts`, `brief.ts`): insights are rule-based comparisons over recorded data (requests close to their target, a category rising at a building vs. its 4-week average, vendors missing SLA, inspection failures rising, booking volume change, assets with repeated repairs), each with the rows behind it. The brief (new and overdue requests, today's incidents, inspections, scheduled vendor visits, bookings, packages, approvals waiting, insights) is built per manager with *their* principal, delivered by the worker at the organization's brief time (`daily_briefs`, one per person per local day, plus an in-app/email notification), and also built on request on the *Brief* page or by the assistant.

**Workflow engine** (`src/server/automation/*`, shared catalog in `src/lib/automation.ts`).
- **Rules** (`workflows`): a trigger (11 outbox event types or a schedule — daily, weekdays, weekly, monthly at a local time), optional property scope, conditions (all must hold; typed per trigger: emergency, category, priority, status, building, assignment, source, text contains, failed items, severity, amenity…), and ordered actions: set priority, change status (never to completed or cancelled), assign (staff, vendor, or whoever is on call), escalate, notify (roles at the property, named people, on call, the submitter, the assignee), create a task, draft an announcement (saved as a draft for a person to publish), **ask for approval** (a role), an **assistant draft** (an internal note written by the model, or a fixed template in demo mode), and send a report. `workflowSchema` rejects anything that couldn't run as written (fields or actions that don't apply to the trigger, unknown values, more than one approval, approval as the last step, a schedule on a non-scheduled rule).
- **Matching** (`processAutomationEvents`): for each outbox event with `automation_at` null, one transaction claims it (`FOR UPDATE SKIP LOCKED`), loads the subject record, evaluates every enabled rule for that trigger and property, and inserts the runs — so the decision and the claim commit together. Runs are unique per `(workflow_id, event_id)` and per `(workflow_id, scheduled_for)`, so a retry or a second worker can't run a rule twice for the same thing. Scheduled rules run the latest due slot once (a server that was down doesn't replay a backlog) and compute the next slot in the organization's time zone.
- **Execution** (`executeRun`): steps run in order **as the rule's owner**, whose principal is loaded fresh and re-authorized for `automation.manage` at the rule's scope on every run — a rule whose owner lost access fails with a clear message instead of acting with stale rights. Actions call the same module services as the UI (so booking rules, assignment rules and SLA recalculation apply), with `TenantCtx.automation = { workflowId, runId, depth }`: audit rows carry `workflow_run_id`, and events the actions raise carry `caused_by_run_id`, `caused_by_workflow_id` and `chain_depth + 1`. A step failure stops the run and marks the rest skipped; the run log keeps each step's outcome and links to the records it created.
- **Loop protection:** a rule never fires on events its own actions raised; chains stop at depth 3; a rule that runs 100 times in an hour is paused with a reason shown on the rule. Runs left "running" by a crash are closed after 15 minutes with an honest message (steps marked done did happen).
- **Approvals:** at an approval step the run waits (`waiting_approval`) and the people who hold that role *at that property* (`membersWithRoleAt`, the same scope rules as everywhere else) are notified. Approve → the remaining steps run immediately as the owner; decline → they're skipped. Only those approvers can decide; other automation managers are told who decides, and anyone else gets a 404. Decisions are audited (`automation.approved` / `automation.declined`) with the note.
- **Who can do what:** `automation.manage` (organization admins, portfolio managers and property managers by default). A property manager can create and edit rules for their properties; organization-wide rules are read-only to anyone not scoped to the whole organization. Saving or turning a rule on makes the saver its owner, so it always runs with the permissions of the last person who approved its contents.
- **Builder** (`/automations/new`, `/automations/{id}/edit`): templates, WHEN → IF → THEN cards, a plain-language summary of the whole rule (names, not ids), and **Run test**, which evaluates the rule against a recent real event (or "now" for schedules) and describes what each step *would* do — `planAction` only reads.
- **Triggering:** `afterChange()` (used by form actions and the assistant) drains notifications, runs matching automations up to the chain limit, drains again and indexes, so a rule's effects are visible right after the change that triggered it; the worker tick does the same for anything else.

**SLA "due soon"** (`checkSlaApproaching`): open work orders whose resolution target falls within the organization's lead time (default 120 minutes) get `sla_warned_at` set once and a `workorder.sla_approaching` event (notifications + the trigger for rules); changing the target resets the warning.

## 10. Billing, API, webhooks and integrations (Iteration 10)

```
                     ┌──────────── entitlements(org) ────────────┐
 subscriptions ─────▶│ plan (src/config/plans.ts) + overrides     │──▶ features: ai_assistant, automation, advanced_analytics,
 feature_flags ─────▶│ access state (trial/active/grace/read-only)│            api, webhooks, integrations
                     └────────────────────────────────────────────┘    limits: properties, units, staff seats, AI requests/month
```

**Entitlements** (`src/server/billing/entitlements.ts`) are the single answer to "may this organization do X now?". A plan feature is on only if the plan includes it *and* its rollout flag is on (`public_api`, `webhooks`, `integrations`, `advanced_analytics`; `self_serve_billing` gates plan changes). Checked at: every form action (`runOrgForm` → `assertWritable`, except billing forms), plan limits inside the same transaction as the insert (`assertWithinLimit` for properties, units incl. bulk generation, staff-seat invitations), the assistant (plan's monthly request allowance on top of the org's own cap; AI actions blocked when read-only), automation (matching, schedules and each run), API requests, webhook fan-out, integrations and the analytics health score.

**Subscription states → access** (`src/lib/billing.ts accessFor`, pure and unit-tested): trialing (until `trial_ends_at`), active, past_due (7-day grace, then read-only), cancelled/expired (read-only). Read-only blocks changes everywhere but keeps every record readable and the billing page usable. **Data is never deleted for non-payment.**

**Billing providers** (`server/billing/providers/`) translate their world into normalized events (`checkout.completed`, `subscription.updated|deleted`, `invoice.updated`) that `applyBillingEvents()` applies in one transaction per event: the `billing_events` row (unique `provider + event_id`) is inserted and locked first, so repeats are skipped, concurrent deliveries wait, and a failed event is retried when the provider resends it.
- **Development provider** (`mock.ts`, labelled everywhere): checkout is a signed, expiring token for a local page; confirming produces the same events a payment would (ids derived from the token, so double-submits apply once). Upgrades apply now with a proration credit; downgrades are scheduled for the period end; the worker renews at period end (event ids derived from the period) — invoices are real rows computed by `quote()`.
- **Stripe** (`stripe.ts`, REST via fetch): Checkout Sessions (base price + optional per-unit price), subscription item updates for plan changes, `cancel_at_period_end`, Customer Portal, per-unit quantity sync, and `POST /api/billing/webhook/stripe` with `Stripe-Signature` verification (5-minute tolerance). Verified with signed fixtures in unit tests; not exercised against Stripe's servers from this environment.
- Usage: `usage_records` per org/metric/day — levels snapshotted hourly (properties, units, active residents, staff seats, month-to-date assistant requests) and counters incremented live (API requests, webhook deliveries).

**API keys and REST API v1** (`server/api/`): a key (`ak_<prefix>_<secret>`, only sha256 stored) acts for its creator, narrowed to the key's scopes (a subset of `API_SCOPES`, each an existing permission) and optionally to properties — re-evaluated on every request, so a deactivated creator or a lost permission disables the key's use. RLS lets an unauthenticated request see exactly one `api_keys` row (`key_hash = app.api_key_hash`). Pipeline (`handler.ts`): route match → key → per-key rate limit (`X-RateLimit-*`, 429 + `Retry-After`; repeated auth failures limited per IP) → plan + flag → read-only check for writes (402) → key permission → strict Zod validation of query/body → optional `Idempotency-Key` (24 h, request-hash checked, in-flight requests refused, 5xx results not stored) → the same domain services as the UI (`source = 'api'`, audit rows carry `api_key_id`) → JSON. Reads use keyset pagination on `(created_at, id)`. Records outside a key's reach are 404. The OpenAPI 3.1 document and `/developers/api` are generated from the route table's Zod schemas. Bearer-only (no cookies), so CSRF doesn't apply; after a successful write the route runs `afterChange()` like a form action.

**Outgoing webhooks** (`server/webhooks/`): fan-out claims outbox events (`webhooks_at`, `FOR UPDATE SKIP LOCKED`), maps them to public types (`work_order.created|status_changed|assigned|sla_breached`, `incident.created`, `complaint.created`, `booking.created`, `package.arrived`), and freezes one payload per subscribed active endpoint (`{ id, type, created_at, api_version, data: { object } }`, the object serialized exactly like the API). Deliveries (unique per endpoint + event) are claimed with a 2-minute lease, signed (`Webhook-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`, secret AES-GCM encrypted at rest), and sent through `net/safe-fetch.ts`: https only, every resolved address must be public (loopback, RFC1918, link-local/metadata, CGNAT, ULA, multicast, documentation, IPv4-mapped/NAT64 forms refused), the socket is pinned to the vetted address (no DNS rebinding), redirects aren't followed, 10 s timeout, response capped. Retries after 1 m, 5 m, 30 m, 2 h, 6 h, 12 h, 24 h (±10 %); 8 attempts, then `failed`. Every attempt is a `webhook_attempts` row. After 20 consecutive failures the endpoint is switched off and admins are notified; pending deliveries wait until it's switched on. Replays create a new delivery with the same event id.

**Integrations** (`server/integrations/`): `integrations` rows hold non-secret config and AES-GCM-encrypted credentials (only masked hints leave the server; audit entries never include secrets). Slack and Teams post through the SSRF-safe client (also as the automation action *Post to Slack or Teams*); Twilio sends SMS (test message today; notification delivery by SMS needs per-person phone numbers and consent — Iteration 11/12). Email providers are deployment-level (`MAIL_PROVIDER=resend|sendgrid`). `CalendarSync` is defined; Google/Outlook adapters, accounting and access control are listed as planned, not connectable.

**Platform console** (`/admin`, platform admins only, re-checked server-side): organizations with plan and subscription state, estimated monthly revenue (from plan prices × unit counts of active subscriptions), trials ending soon, platform AI/API/webhook activity, global and per-organization feature flags, and per-organization subscription changes (plan, trial extension, limit overrides — "support-managed" subscriptions) with an audit entry for each.

## 11. Deployment

- **Dev:** `docker compose up` → Postgres (pgvector image), Mailpit, app; add `--profile s3` with `FILE_STORAGE=s3` for MinIO. Or run Postgres yourself and `npm run dev`.
- **Prod:** build image with `Dockerfile` (multi-stage, `output: "standalone"`, non-root user). Run `npm run db:migrate` as a release step with the owner URL; run app with the least-privilege URL. Put behind a TLS-terminating proxy/load balancer. Managed Postgres with PITR backups.
- Health: `GET /api/health` (liveness + DB check).
