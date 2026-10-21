# Database Schema

PostgreSQL 16. UUID primary keys (`gen_random_uuid()`), `timestamptz` everywhere, enumerations as `text` + `CHECK`. Source of truth: `src/server/db/schema.ts` → SQL migrations in `drizzle/`.

**Legend:** 🔒 = row-level security (tenant-owned), 🌐 = global table (no org), ⏳ = planned (not yet created).

## Implemented (Iterations 1–10)

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

### Front desk & facility (🔒, Iteration 5)

| Table | Purpose / key columns |
|---|---|
| `visitors` | property/building, unit (null for common-area contractors), host resident, `invited_by_user_id`, name, company, phone, `kind` guest/delivery/contractor/service/other, purpose, `expected_from`/`expected_until` (pass window, `until > from`), `status` expected/checked_in/checked_out/cancelled/denied, **`pass_token_hash`** (SHA-256 of the QR token; unique; cleared when the visit ends, is cancelled or the pass is reissued), plate, `needs_parking`, linked `work_order_id`, checked in/out at/by, denied reason |
| `parking_spaces` | property (optional building), `code` (upper-case, unique per property), level, `kind` resident/visitor/accessible/ev/loading/motorcycle/reserved, `assigned_unit_id`, `status` available/out_of_service |
| `vehicles` | property, unit, resident, `plate` (normalised letters+digits), region, make/model/colour, `active`; **one active record per plate per org** (partial unique index) |
| `parking_permits` | per-org `number`, `kind` resident/visitor/contractor/staff, plate, vehicle, unit, space, visitor, `valid_from`, `valid_until` (null = open-ended), `status` active/revoked, issued/revoked by |
| `parking_violations` | per-org `number`, property/building/space, plate, location, `kind`, description, `observed_at`, **`source` staff/resident/detection** with `confidence` for detections, `status` reported → confirmed/dismissed → warned → resolved, matched `vehicle_id`/`unit_id` and `had_valid_permit` (facts at report time), reviewer + note, warning text/time, resolution |
| `shifts` | property (optional building), membership, `position`, `starts_at`/`ends_at`, `on_call`, notes, `status` scheduled/cancelled, `clocked_in_at`/`clocked_out_at` |
| `shift_handoffs` | property/building, shift, author, notes, **`snapshot` jsonb** (open items at the time, limited to what the author could see), acknowledged by/at |
| `assets` | property/building/unit, location, name, `tag` (unique per org), `category`, make/model/serial, installed, warranty, expected life, `criticality`, `status` operational/needs_attention/down/retired, service vendor, replacement cost |
| `pm_schedules` | asset, property, title, instructions, `interval_unit` day/week/month/year × `interval_count`, `next_due_on`, `lead_days`, priority, vendor or staff assignee, `active`, last generated work order |
| `asset_downtime` | asset, `started_at`/`ended_at` (null = ongoing; **one open record per asset**), reason, linked work order |

Also added: `work_orders.asset_id` (equipment involved; PM work orders have `source = 'system'`, `source_type = 'pm_schedule'`), per-org counters `parking_permit` and `parking_violation`, and `organizations.settings.parkingSecondReviewer`.

**Constraints that hold under concurrency** (migration `0011`, `btree_gist`):

```sql
-- a space has one live permit at a time
EXCLUDE USING gist (space_id WITH =, tstzrange(valid_from, valid_until, '[)') WITH &&) WHERE (status = 'active' AND space_id IS NOT NULL)
-- nobody is scheduled for two overlapping shifts
EXCLUDE USING gist (membership_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status = 'scheduled')
```

Visitor check-in issues the parking permit in a savepoint, so "space just taken" (`23P01`) leaves the visitor untouched and shows a friendly error.

### AI assistant (🔒, Iteration 6)

| Table | Purpose / key columns |
|---|---|
| `ai_conversations` | owner `user_id`, `title` (first question), `mode` property/maintenance/frontdesk/facility/resident, `last_message_at`, `archived_at` (soft delete from the history list) |
| `ai_messages` | provider-neutral transcript: `turn_id` (correlation id of one question), `seq` (unique per conversation), `role` user/assistant/tool, `content`, assistant `tool_calls` jsonb `[{id, name, input}]`, tool `tool_call_id`/`tool_name`/`is_error`, `provider`/`model` of assistant messages. `user_id` is denormalised so RLS can restrict rows to their author |
| `ai_tool_calls` | the action log: user, conversation, `turn_id`, provider `call_id` (`…:run` for the execution of an approved step), `tool`, `risk_class` 1–5, validated `args`, `outcome` ok/denied/invalid/not_found/ambiguous/error/unknown_tool/**pending/executed/policy_denied**, error, `summary`, `result_count`, `display` jsonb (the record cards the UI showed), `duration_ms`, **`approval_id`** → the plan (Iteration 7, indexed) |
| `ai_usage` | one row per question (`turn_id` unique): provider, model, input/output/cached tokens, `model_calls`, `tool_calls`, `est_cost_usd` (null when the model has no price), `latency_ms`, `outcome` ok/error/timeout/step_limit/cap_reached/disabled. Indexed by `(org_id, created_at)` for the monthly cap |

| `ai_approvals` (Iteration 7) | a **plan**: the changes prepared in one turn. `conversation_id` (set null on delete), `turn_id`, `requested_by_user_id`, `mode` confirm (a person approves) / auto (an org rule let a step run), `status` pending/executing/executed/partially_failed/failed/rejected/expired/superseded, `steps` jsonb `[{id, callId, tool, riskClass, policyKeys, propertyId, input, resolved, title, details, effects, draft?}]`, `results` jsonb `[{stepId, status, summary, record, verified, check, warning}]`, `decided_by_user_id`/`decided_at`, `executed_at`, `expires_at` (24 h). Indexed by `(org_id, requested_by_user_id, status, created_at)` and conversation |
| `ai_policies` (Iteration 7) | what the assistant may do: `action` (a policy key such as `task.create`, `communication.send`), optional `property_id` (cascade), `mode` auto/confirm/deny, `updated_by_user_id`. Unique per org+action where `property_id` is null, and per org+property+action otherwise (partial unique indexes) |

### Knowledge base & retrieval (🔒, Iteration 8)

| Table | Purpose / key columns |
|---|---|
| `knowledge_entries` | what admins teach the assistant in their own words: optional `property_id` (cascade) / `building_id`, `title`, `body` (light markdown; `##` headings become citable sections), `category` (rules, amenities, procedures, emergency, maintenance, moving, parking, policy, general), `audience` staff / residents / owners, `status` active / disabled, current `version`, created/updated by |
| `knowledge_entry_versions` | every saved version (title, body, category, audience, change note, author); unique per entry + version |
| `kb_sources` | one row per indexable source — a document **or** an entry (check constraint), unique per document and per entry (partial unique indexes). It *is* the indexing queue: `status` queued / indexing / indexed / failed / unsupported / empty, the `version` to index and the `indexed_version`, `chunk_count`, `char_count`, `embedding_model`, `error`, `attempts`, queued/started/indexed timestamps. Indexed by `(status, queued_at)` for the worker |
| `kb_chunks` | passages, the unit of retrieval and citation: source, document or entry, `version`, `ordinal`, `context` ("Title › Section"), `heading`, `page`, `content`, `token_count`, `embedding vector(512)`, `embedding_model`. Migration `0017` adds a generated, weighted `search tsvector` (English: context A, content B) with a GIN index, and an **HNSW** index on `embedding` (cosine) |

Requires the **pgvector** extension (migration `0016` runs `CREATE EXTENSION IF NOT EXISTS vector`). Embeddings are fixed at 512 dimensions; every provider is asked for (or checked against) that size.

Organization settings gained `aiEnabled` and `aiMonthlyRequestCap` (in `organizations.settings`). Sensitive reads by the assistant (the resident directory) also write an `audit_logs` row `ai.sensitive_read` with `ai_generated = true`.

### Analytics & automation (🔒, Iteration 9)

| Table | Purpose / key columns |
|---|---|
| `workflows` | an automation rule: optional `property_id` (cascade; null = every property), `name`, `description`, `trigger_type` (11 event triggers or `schedule`, check constraint), `schedule` jsonb `{frequency daily/weekdays/weekly/monthly, time "HH:MM", weekday?, dayOfMonth?}` (present **iff** the trigger is `schedule`, check constraint), `conditions` jsonb `[{field, op, value}]`, `actions` jsonb (ordered, validated by `workflowSchema`), `enabled`, `owner_user_id` (whose permissions runs use — the last person who saved or enabled it), `version` (bumped on every edit; runs record the version they ran), `next_run_at` (scheduled rules), `last_run_at`, `run_count`, `paused_reason` (set when the runaway guard turns it off), created by/at, `updated_at`. Partial indexes: enabled rules by `(org_id, trigger_type)`; enabled schedules by `next_run_at` |
| `workflow_runs` | one execution: `workflow_id` (cascade), `workflow_version`, the triggering `event_id` **or** `scheduled_for` slot — unique per `(workflow_id, event_id)` and per `(workflow_id, scheduled_for)` (partial unique indexes: the idempotency guarantee), `trigger_type`, the subject `entity_type`/`entity_id`/`entity_label`, `property_id`, `status` running / waiting_approval / completed / failed / rejected (check), `depth` (chain depth of the triggering event), `steps` jsonb `[{index, type, label, status pending/done/skipped/failed/waiting, summary, error, record {ref, title, href}, at, action}]`, `approval_role`, `approval_step`, `approval_requested_at`, `decided_by_user_id`/`decided_at`/`decision_note`, `error`, `started_at`, `finished_at`. Indexed by `(org_id, created_at)`, `(workflow_id, created_at)`, `(org_id, entity_type, entity_id)` and waiting runs by `(org_id, status)` |
| `daily_briefs` | a delivered operations brief: `user_id`, `brief_date` (the recipient's organization-local date), `content` jsonb (the sections and insights as built for that person). Unique per `(org_id, user_id, brief_date)`, so the worker delivers at most one per person per day |

New columns:
- `outbox_events.automation_at` (when automation evaluated the event; the backfill in `0018` marks every earlier event as evaluated so new rules never replay history), `caused_by_run_id`, `caused_by_workflow_id`, `chain_depth` (loop protection). Partial index `outbox_automation_pending_idx` on `created_at` where `automation_at is null`.
- `audit_logs.workflow_run_id` — set on every change an automation run made.
- `work_orders.sla_warned_at` — the "due soon" warning was sent (reset when the target changes). Partial index `work_orders_sla_watch_idx` on `resolve_due_at` for open, unwarned requests.
- `tasks.source` accepts `automation`.

Analytics indexes (`0019`): `work_orders (org_id, completed_at)` where completed, `packages (org_id, received_at)`, `bookings (org_id, starts_at)`. Reports, metrics and health-score weights are code and organization settings (`organizations.settings.analytics`: `slaWarningMinutes`, `briefEnabled`, `briefTime`, `healthWeights`), not tables.

### Billing, developer platform & integrations (🔒, Iteration 10)

| Table | Purpose / key columns |
|---|---|
| `subscriptions` | one per organization (unique `org_id`): `plan_key` starter/professional/enterprise, `interval` month/year, `status` trialing/active/past_due/cancelled/expired, `provider` none (trial)/mock/stripe/manual (support-managed), `provider_customer_id`, `provider_subscription_id` (unique per provider), `trial_ends_at`, `trial_notice_sent_at`, `current_period_start/end`, `cancel_at_period_end`, `pending_plan_key`/`pending_interval` (downgrade at period end), `past_due_since` (grace), `limit_overrides` jsonb (per-organization deals), `last_paid_cents` (proration). Indexed for the worker: active periods by end, trials by end |
| `invoices` | `number`, `provider` + `provider_invoice_id` (unique), `status` open/paid/void/uncollectible, `currency`, `total_cents`, `lines` jsonb `[{description, quantity, unitCents, amountCents}]`, `period_start/end`, `hosted_url` (Stripe), `issued_at`, `paid_at` |
| `usage_records` | `(org_id, metric, day)` unique: `properties`, `units`, `active_residents`, `staff_seats`, `ai_requests` (levels, snapshotted hourly) and `api_requests`, `webhook_deliveries` (counters) |
| `billing_events` | every provider event once: unique `(provider, event_id)`, `type`, normalized `payload`, `status` received/processed/ignored/failed, `error`; `org_id` null until matched |
| `api_keys` | `name`, `prefix` (unique, shown), `key_hash` (sha256, unique), `created_by_user_id` (the member the key acts for), `permissions` text[] (API scopes), `property_ids` uuid[] (empty = creator's whole reach), `requests_per_minute`, `expires_at`, `last_used_at`/`last_used_ip`, `revoked_at`/`revoked_by_user_id` |
| `api_idempotency` | `(api_key_id, key)` unique: `request_hash`, `status_code` (null while running), `response_body`; purged after 24 h |
| `webhook_endpoints` | `url`, `description`, `secret_enc` (AES-256-GCM), `events` text[], `status` active/disabled, `disabled_reason`, `consecutive_failures`, `last_success_at`, `last_failure_at` |
| `webhook_deliveries` | `endpoint_id` (cascade), `event_id` (unique per endpoint when present; null for pings and replays), `event_type`, frozen `payload`, `status` pending/succeeded/failed, `attempts`, `next_attempt_at` (also the claim lease), `last_status_code`, `last_error`, `delivered_at`, `replay_of`. Partial index on due pending deliveries |
| `webhook_attempts` | one row per HTTP attempt: `attempt`, `status_code`, `error`, `response_snippet` (≤ 1 KB), `duration_ms` |
| `integrations` | `(org_id, provider)` unique: `status` connected/error, `config` jsonb (non-secret), `credentials_enc` (AES-256-GCM JSON), `last_used_at`, `last_error`, `connected_by_user_id` |
| `feature_flags` | `key`, `org_id` (null = global override; partial unique indexes for each case), `enabled`, `updated_by_user_id` |

New columns: `outbox_events.webhooks_at` (fan-out done; backfilled for history in `0021`) with a partial pending index; `audit_logs.api_key_id`; `work_orders.source` accepts `api` (`0022`); `organizations.plan_key` now mirrors `subscriptions.plan_key` (default `professional`). Migration `0021` gives every organization that existed before billing an active, support-managed Professional subscription.

### Full-text search

Generated `tsvector` columns named `search` (config `simple`, so names, codes and unit numbers aren't stemmed) with GIN indexes on `properties`, `buildings`, `units`, `residents` (name, email, phone digits), `vendors` (name, legal name, email, trades), `documents` (title, description) and `assets` (name, tag, make, model, serial, location, category). Queries use prefix matching built by `toPrefixQuery()`, which strips every tsquery operator from user input; hyphenated codes such as `RTU-4` match either joined (`rtu4`) or by part (`rtu & 4`), the way Postgres indexes them. `immutable_array_join(text[])` exists because `array_to_string` isn't immutable and can't be used in a generated column.

### Indexes

Every tenant table has an index leading with `org_id` (plus the parent key), matching how RLS + services filter. Lookups by token hash, email, and session id are unique indexes.

## Row-level security

Helper functions read transaction-local settings set by `withContext()`:

```sql
app_org()            -- current_setting('app.org_id')
app_user()           -- current_setting('app.user_id')
app_platform_admin() -- current_setting('app.platform_admin') = 'on'
app_system()         -- current_setting('app.system') = 'on'   (background worker only, Iteration 3)
current_setting('app.pass_token_hash')                      (public guest-pass page only, Iteration 5)
app_api_key_hash()   -- current_setting('app.api_key_hash')   (REST API key lookup only, Iteration 10)
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
| Front desk & facility tables (`visitors`, `parking_*`, `vehicles`, `shifts`, `shift_handoffs`, `assets`, `pm_schedules`, `asset_downtime` — 10 tables, migration `0011`) | same rule as the community tables. **Plus** `visitor_pass`: with no org context, a transaction that sets `app.pass_token_hash` may SELECT exactly the visitor row with that hash (the public pass page); it then switches to that org to read the building's public details |
| Knowledge base (migration `0017`) | `knowledge_entries`, `knowledge_entry_versions`, `kb_sources`, `kb_chunks`: the standard tenant rule (`org_id = app_org()`; platform admin / worker system read; writes only in org context). Who may read a passage inside the org (audience, place, active, current version) is applied in SQL by the retrieval service before ranking, using the same rule as the Documents page |
| Automation (migration `0019`) | `workflows`, `workflow_runs`, `daily_briefs`: the standard tenant rule (`org_id = app_org()`; platform admin / worker system read; writes only in org context, so the worker names the organization for every write). Who may see or edit a rule (scope), decide a run (the approval role at that property) or read a brief (its recipient) is enforced in the services |
| AI plans and policies (migration `0015`) | `ai_approvals`, `ai_policies`: the standard tenant rule (`org_id = app_org()`, platform admin / system read). Only the requester can see or decide a plan — enforced in the service (`requested_by_user_id = app user` on every query); policies are changed only by `ai.settings.manage` |
| AI tables (migration `0013`) | `ai_conversations`, `ai_messages`: **owner only** — `org_id = app_org() AND user_id = app_user()` for read and write; no platform-admin or worker bypass. `ai_tool_calls`, `ai_usage`: the standard tenant rule (admins read them through `ai.settings.manage` in the service) |
| Community tables (`amenities`, `bookings`, `packages`, `announcements`, `message_threads`, `messages`, `documents`, … — 12 tables, migration `0009`) | read: `org_id = app_org()` (or platform admin / worker); write: `org_id = app_org()` only. Who-sees-what inside an org (a resident's own unit, audience, internal notes) is enforced in the services and covered by integration tests |

| Billing, API, webhooks, integrations (migration `0021`) | `subscriptions`, `invoices`, `usage_records`, `api_keys`, `api_idempotency`, `webhook_endpoints`, `webhook_deliveries`, `webhook_attempts`, `integrations`: the standard tenant rule. **Plus** `api_key_lookup`: with no org context, a transaction that sets `app.api_key_hash` may SELECT exactly the key with that hash. `billing_events`: read in org context (or platform admin / system); written by the system context (provider webhooks arrive before the organization is known). `feature_flags`: everyone reads global rows and their own organization's; only a platform-admin context may insert, update or delete |

Migration `0002_rls_strict_org_context` fixed a leak found during Iteration 1 testing: inside org A, a user could see their own membership in org B. Covered by a regression test in `tests/integration/tenant-isolation.test.ts`.

## Planned tables

| Iteration | Tables |
|---|---|
| later | `storage_lockers` (not built in Iteration 5) |
