# Database Schema

PostgreSQL 16. UUID primary keys (`gen_random_uuid()`), `timestamptz` everywhere, enumerations as `text` + `CHECK`. Source of truth: `src/server/db/schema.ts` → SQL migrations in `drizzle/`.

**Legend:** 🔒 = row-level security (tenant-owned), 🌐 = global table (no org), ⏳ = planned (not yet created).

## Implemented (Iterations 1–4)

### Identity & auth (🌐)

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `users` | One identity per email across all orgs | `email` unique + must be lower-case; `password_hash` (argon2id); `email_verified_at`; `status` active/deactivated; `is_platform_admin`; `mfa_enabled`, `mfa_secret_enc` (AES-256-GCM) |
| `sessions` | Server-side sessions | `id` = SHA-256 of the cookie token (raw token never stored); `expires_at` (30-day sliding); ip, user agent |
| `email_tokens` | Email verification + password reset | `token_hash` unique; `purpose`; single-use (`used_at`); expiry |
| `mfa_challenges` | Pending second factor after password | hashed id; 5-minute TTL; attempt counter (max 5) |
| `mfa_recovery_codes` | 10 one-time codes per user | `code_hash`; `used_at` |
| `login_events` | Login history + suspicious-login flags | success, reason, `suspicious`, ip, user agent |
| `email_outbox` | Record of every email sent (body redacted in prod for auth emails) | status queued/sent/failed/logged |
| `permissions` | Catalog of permission keys, synced from code | `key` PK, module, description |

### Tenancy & access (🔒)

| Table | Purpose | Notes |
|---|---|---|
| `organizations` | Tenant root | `slug` globally unique; `status` active/suspended; `kind`; `timezone`; `plan_key`; `settings` jsonb |
| `roles` | Role → permission set | `org_id` NULL = system role (seeded, immutable); `scope_level` org/scoped/occupant/assigned; `category` staff/resident/external; `permissions text[]`; unique (org, key) |
| `memberships` | User ∈ org with one role | unique (org_id, user_id); `status` |
| `membership_scopes` | Limits scoped roles | exactly one of portfolio / property / building (`CHECK num_nonnulls = 1`) |
| `invitations` | Email invitations | `token_hash` unique; role; optional property scope; expiry, accepted/revoked timestamps |
| `audit_logs` | Append-only audit trail | before/after jsonb (secrets redacted), ip, UA, request id, `ai_generated`, `approval_id`. App role has no UPDATE/DELETE |

### Portfolio (🔒)

| Table | Parent | Notes |
|---|---|---|
| `portfolios` | organization | |
| `properties` | organization, optional portfolio | unique (org, code); `type` residential/commercial/mixed_use/strata/rental/industrial; address; timezone |
| `buildings` | property | unique (property, code) |
| `floors` | building | unique (building, level) |
| `units` | building (+ denormalized `property_id` for fast scoping) | unique (building, number); `type`; `status` occupied/vacant/notice/renovation/unavailable |
| `residents` | organization | person record; `user_id` nullable (residents without logins) |
| `unit_occupancies` | unit × resident | `relationship` resident/tenant/owner/occupant; `is_primary`; start/end dates |

### People & vendors (🔒, Iteration 2)

| Table | Purpose | Notes |
|---|---|---|
| `vendors` | Contractor / service company directory | name unique per org (case-insensitive); `categories text[]` (fixed trade list); `service_areas text[]`; status active/inactive/blocked; licence, insurance expiry, hourly rate, response SLA hours |
| `vendor_contacts` | People at a vendor | one `is_primary` per vendor (enforced in service) |
| `vendor_properties` | Properties a vendor is approved to work at | unique (vendor, property) |
| `staff_profiles` | Directory details for a staff membership | unique per membership; phone, `skills text[]`, employment type |

Also added in Iteration 2: `memberships.vendor_id` (links vendor users to their company → `Principal.vendorId`), `invitations.resident_id` / `invitations.vendor_id` (resident-app and vendor-portal invitations), `residents.notes`.

### Operations (🔒, Iteration 3)

| Table | Purpose / key columns |
|---|---|
| `org_counters` | per-org sequences (`work_order`, `incident`, `complaint`) for human-friendly numbers; upserted with `ON CONFLICT … RETURNING` |
| `sla_policies` | respond/resolve minutes per priority; `property_id` null = org default; unique per (org, property, priority) |
| `triage_rules` | keywords and/or category → priority, emergency flag, category, default assignee/vendor, resident instructions; `position` orders evaluation; property rules beat org rules |
| `work_orders` | `number` (unique per org), property/building/unit/area, category, priority, `is_emergency`, `status` (10-state machine), source (`resident`/`staff`/`inspection`…), submitter/resident, assigned membership, vendor, `respond_due_at`/`resolve_due_at`, `first_response_at`, `sla_breached_at`, scheduled window, completed/closed/cancelled timestamps, cost, resolution notes, permission to enter + entry notes, `triage_rule_id`, `source_type`/`source_id` |
| `timeline_events` | shared activity log for work orders, tasks, inspections, incidents, complaints: kind, from/to status, body, `visibility` (`public`/`vendor`/`internal`), actor |
| `tasks`, `task_checklist_items` | title, property/building, priority, due, assignee, status (`open`/`in_progress`/`blocked`/`done`/`cancelled`), recurrence (`daily`/`weekly`/`monthly`), `blocked_by_task_id`, source link |
| `inspection_templates` | name, kind, checklist `items` (jsonb `[{section,label}]`), `repeat_every_days`, active |
| `inspections`, `inspection_items` | scheduled date, inspector, status, result, summary, signature name; items with result (`pass`/`fail`/`na`), severity, notes, linked follow-up `work_order_id` |
| `incidents` | number, type, severity, status, location, occurred_at, reporter, people involved (staff-only), external reference, resolution |
| `complaints` | number, category, subject, description, unit, submitter/resident, assignee, priority, status, related incident, resolution |
| `files` | owner (`entity_type`, `entity_id`), storage key, sniffed content type, size, sha256, visibility, scan status, uploader |
| `notifications` | user, kind, title, body, link, entity, `event_id` (unique with user → idempotent delivery), read/emailed timestamps |
| `notification_preferences` | per user × kind: in-app, email |
| `outbox_events` | type, payload, actor, attempts, last error, processed_at (partial index on unprocessed rows) |

### Community & resident experience (🔒, Iteration 4)

| Table | Purpose / key columns |
|---|---|
| `amenities` | property (optionally one building), name, kind, description, location, house rules text; booking rules as columns: `opens_at_minute`/`closes_at_minute` (minutes after local midnight; 1440 = midnight), `slot_minutes`, min/max duration, `min_notice_hours`, `max_advance_days`, `capacity` (people), `max_concurrent` (1 = exclusive), per-unit `limit_count` per `limit_period_days`, `cancellation_hours`, `requires_approval`, `fee_cents`, `deposit_cents`, `eligible_roles text[]` (empty = any resident), active |
| `amenity_blackouts` | closures for an amenity: `starts_at`/`ends_at`, reason, creator |
| `bookings` | per-org `number`; amenity, property/building/unit, resident, booker; `starts_at`/`ends_at`; guests, purpose; `status` requested/approved/declined/cancelled; `exclusive` (copied from the amenity when booked); fee/deposit amounts and statuses (fee: none/due/paid/waived; deposit: none/due/held/refunded/withheld); decision note/by/at; cancellation; damage notes + `damage_work_order_id` |
| `packages` | property/building/unit, matched resident, recipient name, carrier, tracking, size, perishable, shelf, notes, `status` waiting/picked_up/returned, 6-digit `pickup_code`, received at/by, picked up at/by name, released by, `reminder_sent_at`, return reason (photos and signatures live in `files`) |
| `announcements` | property (null = every property), `building_ids uuid[]` (empty = whole property), `audience` everyone/residents/staff, title, body, category, pinned, `notify`, `status` draft/scheduled/published/archived, `publish_at`, `published_at`, `expires_at` |
| `announcement_reads` | read receipts per announcement × user (unique) |
| `message_threads` | resident ↔ management conversation: property/building/unit, resident, `resident_user_id`, subject, category, status open/closed, assigned membership, `last_message_at`, `last_message_preview`, `last_from_staff` |
| `messages` | thread, author, `from_staff`, `internal` (staff-only note), body |
| `message_reads` | per thread × user `last_read_at` (unread badges) |
| `message_templates` | reusable replies with `{{variables}}`; property null = org-wide |
| `documents` | property/building/unit scope (all null = org-wide), title, description, category, `audience` staff/residents/owners, `important`, status active/archived, `current_version` |
| `document_versions` | document × version (unique), `file_id` → `files`, notes, uploader; older versions' files are moved to internal visibility |

Also added: `properties.emergency_phone`, `emergency_info`, `office_hours` (shown to residents); `files` owners `package` and `document`.

**Double-booking is impossible at the database level.** `bookings_no_overlap` is an exclusion constraint (needs `btree_gist`):

```sql
EXCLUDE USING gist (amenity_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (exclusive AND status IN ('requested', 'approved'))
```

The service also locks the amenity row (`SELECT … FOR UPDATE`) before evaluating capacity for shared amenities, and maps the constraint error (`23P01`) to "someone has just booked that time".

### Full-text search

Generated `tsvector` columns named `search` (config `simple`, so names, codes and unit numbers aren't stemmed) with GIN indexes on `properties`, `buildings`, `units`, `residents` (name, email, phone digits), `vendors` (name, legal name, email, trades) and `documents` (title, description). Queries use prefix matching built by `toPrefixQuery()`, which strips every tsquery operator from user input. `immutable_array_join(text[])` exists because `array_to_string` isn't immutable and can't be used in a generated column.

### Indexes

Every tenant table has an index leading with `org_id` (plus the parent key), matching how RLS + services filter. Lookups by token hash, email, and session id are unique indexes.

## Row-level security

Helper functions read transaction-local settings set by `withContext()`:

```sql
app_org()            -- current_setting('app.org_id')
app_user()           -- current_setting('app.user_id')
app_platform_admin() -- current_setting('app.platform_admin') = 'on'
app_system()         -- current_setting('app.system') = 'on'   (background worker only, Iteration 3)
```

| Policy | Rule |
|---|---|
| Simple tenant tables | `org_id = app_org()` for read and write (platform admin may read) |
| `memberships`, `organizations`, `roles` | org context → that org only. **No** org context → the current user's own memberships/orgs (used to list "my organizations" and resolve an org by slug) |
| `invitations` | org context, or (no org context) the single row matching `app.invite_token_hash` |
| `audit_logs` | read: org context (or own personal rows with no org); insert: org context or own personal rows; no update/delete grants |

| Operations tables (`work_orders`, `tasks`, `incidents`, `complaints`, `files`, …) | read: `org_id = app_org()` (or platform admin / worker system context); write: `org_id = app_org()` only |
| `notifications` | read/update: own rows in the current org (worker: any user in the org it names); insert: own user, or the worker |
| `notification_preferences` | own rows only |
| `outbox_events` | insert in org context; read in org context or by the worker; update only by the worker inside the named org |
| Community tables (`amenities`, `bookings`, `packages`, `announcements`, `message_threads`, `messages`, `documents`, … — 12 tables, migration `0009`) | read: `org_id = app_org()` (or platform admin / worker); write: `org_id = app_org()` only. Who-sees-what inside an org (a resident's own unit, audience, internal notes) is enforced in the services and covered by integration tests |

Migration `0002_rls_strict_org_context` fixed a leak found during Iteration 1 testing: inside org A, a user could see their own membership in org B. Covered by a regression test in `tests/integration/tenant-isolation.test.ts`.

## Planned tables

| Iteration | Tables |
|---|---|
| 5 | `parking_spaces`, `storage_lockers`, `visitors`, `visitor_passes`, `vehicles`, `parking_permits`, `parking_violations`, `shifts`, `shift_handoffs`, `assets`, `pm_schedules`, `asset_downtime` |
| 6–7 | `ai_conversations`, `ai_messages`, `ai_action_logs`, `ai_approvals`, `ai_policies`, `ai_usage` |
| 8 | `document_chunks` (pgvector `embedding`, HNSW index), `knowledge_items` |
| 9 | `workflows`, `workflow_runs`, `reports`, `scheduled_jobs` |
| 10 | `plans`, `subscriptions`, `invoices`, `usage_records`, `api_keys`, `webhooks`, `webhook_deliveries`, `integrations`, `feature_flags` |
