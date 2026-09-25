# Database Schema

PostgreSQL 16. UUID primary keys (`gen_random_uuid()`), `timestamptz` everywhere, enumerations as `text` + `CHECK`. Source of truth: `src/server/db/schema.ts` → SQL migrations in `drizzle/`.

**Legend:** 🔒 = row-level security (tenant-owned), 🌐 = global table (no org), ⏳ = planned (not yet created).

## Implemented (Iteration 1)

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

### Full-text search

Generated `tsvector` columns named `search` (config `simple`, so names, codes and unit numbers aren't stemmed) with GIN indexes on `properties`, `buildings`, `units`, `residents` (name, email, phone digits) and `vendors` (name, legal name, email, trades). Queries use prefix matching built by `toPrefixQuery()`, which strips every tsquery operator from user input. `immutable_array_join(text[])` exists because `array_to_string` isn't immutable and can't be used in a generated column.

### Indexes

Every tenant table has an index leading with `org_id` (plus the parent key), matching how RLS + services filter. Lookups by token hash, email, and session id are unique indexes.

## Row-level security

Helper functions read transaction-local settings set by `withContext()`:

```sql
app_org()            -- current_setting('app.org_id')
app_user()           -- current_setting('app.user_id')
app_platform_admin() -- current_setting('app.platform_admin') = 'on'
```

| Policy | Rule |
|---|---|
| Simple tenant tables | `org_id = app_org()` for read and write (platform admin may read) |
| `memberships`, `organizations`, `roles` | org context → that org only. **No** org context → the current user's own memberships/orgs (used to list "my organizations" and resolve an org by slug) |
| `invitations` | org context, or (no org context) the single row matching `app.invite_token_hash` |
| `audit_logs` | read: org context (or own personal rows with no org); insert: org context or own personal rows; no update/delete grants |

Migration `0002_rls_strict_org_context` fixed a leak found during Iteration 1 testing: inside org A, a user could see their own membership in org B. Covered by a regression test in `tests/integration/tenant-isolation.test.ts`.

## Planned tables

| Iteration | Tables |
|---|---|
| 3 | `work_orders`, `work_order_events`, `sla_policies`, `tasks`, `task_checklist_items`, `inspection_templates`, `inspections`, `inspection_items`, `incidents`, `incident_events`, `complaints`, `outbox_events`, `notifications`, `notification_preferences` |
| 4 | `amenities`, `amenity_rules`, `bookings`, `packages`, `announcements`, `message_threads`, `messages`, `documents`, `document_versions`, `files` |
| 5 | `parking_spaces`, `storage_lockers`, `visitors`, `visitor_passes`, `vehicles`, `parking_permits`, `parking_violations`, `shifts`, `shift_handoffs`, `assets`, `pm_schedules`, `asset_downtime` |
| 6–7 | `ai_conversations`, `ai_messages`, `ai_action_logs`, `ai_approvals`, `ai_policies`, `ai_usage` |
| 8 | `document_chunks` (pgvector `embedding`, HNSW index), `knowledge_items` |
| 9 | `workflows`, `workflow_runs`, `reports`, `scheduled_jobs` |
| 10 | `plans`, `subscriptions`, `invoices`, `usage_records`, `api_keys`, `webhooks`, `webhook_deliveries`, `integrations`, `feature_flags` |
