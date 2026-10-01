# Iteration 3 — Operations core

_Completed 2026-09-30_

## What was built

**Maintenance (the main vertical slice).** A resident submits a request (with photos) → triage rules set priority, emergency, category and a default vendor, and show configured "what to do now" guidance → SLA targets are stamped → managers are notified → a manager assigns staff and/or an approved vendor → the vendor sees only their company's jobs, schedules, starts and completes the work (resolution notes required, cost recorded) → the resident is notified at each step and sees the outcome.

- 10-state work order machine (new → acknowledged → assigned → scheduled → in progress → awaiting vendor/resident → completed → closed, or cancelled), with transitions limited by role: managers do anything allowed, workers move work along but never cancel/close/reopen, requesters can only withdraw before work starts.
- Per-org request numbers, location by unit / building area / property, permission to enter + entry notes (hidden from residents' view of others and never shown to non-workers).
- **Triage rules** (keywords or category → priority, emergency, category, default vendor/assignee, resident instructions), property rules before org rules. Rule-based, not AI — Iteration 7's assistant will call the same rules.
- **SLA policies** per priority with property overrides; respond/resolve due dates; first-response tracking; recomputed when priority changes; background **SLA monitor** flags breaches once and alerts managers and the assignee.
- Timeline with three visibility levels (public / staff & vendor / internal) for comments, status changes, assignments, scheduling and files.
- Lists with tabs (open, overdue, emergency, unassigned, assigned to me, completed, all), filters (property, category, priority, status) and search by title or number.
- Configuration page (*Organization → Maintenance rules*) for SLA targets and triage rules.

**Tasks:** one-off and recurring (daily/weekly/monthly; completion spawns the next occurrence with its checklist), checklists, dependencies (blocked until the prerequisite is done; completing it unblocks), assignment validated against the property, comments, links back to the record that created them.

**Inspections:** checklist templates ("Section: item" per line) with optional repeat interval; schedule for a building or unit with an inspector; record pass / fail (severity required) / N/A with notes; complete and sign once every item is answered; any failure fails the inspection and alerts managers; one-click follow-up work order per failed item (linked both ways, once only); the next inspection is scheduled automatically for recurring templates.

**Incidents:** typed and severity-rated reports with location, time (in the org's time zone; no future times), people involved and external reference (staff-only), timeline with internal notes; residents can report incidents in their own building and see only the public record; raising severity to high/critical is an escalation that notifies incident managers; resolving requires a resolution.

**Complaints:** residents file from their unit; staff log complaints received by phone or in person; a conversation with internal notes the resident never sees; assignment, priority, related incident, other complaints from the same unit; resolving or dismissing requires an outcome shown to the resident (copy guides staff to state facts, not accusations).

**Notifications:** transactional outbox → worker → in-app notifications + email (preferences per kind), idempotent per event and user, actor excluded, visibility-aware; bell with unread count, inbox, mark read, preferences page. Worker runs in-process (30 s loop + right after each form action) or as `npm run worker`; events are claimed with `FOR UPDATE SKIP LOCKED` so several workers don't double-send.

**Files:** photos/PDF/video on work orders, incidents, complaints and inspections; type detected from file contents, size limits, scanner hook, visibility levels, permission-checked and audited downloads, local disk or S3-compatible storage with presigned URLs.

**Dashboards:** managers get live KPIs (open, overdue, emergencies, SLA met, average first response/resolution, 30-day spend) plus open work by property, category and vendor, complaints/incidents/inspections counts, "assigned to me" and "my tasks". Residents see open requests and complaints with a *Report a problem* button; vendors see their open jobs. Command palette quick actions for every new module.

## Decisions and assumptions

- Residents can't set priority; their emergency checkbox and the rules decide. Staff choices win over rules.
- A request's default vendor from a rule is applied only if that vendor is active and approved for the property.
- Vendor users see only jobs assigned to their company, and only public + vendor-level comments and files; entry notes are visible to them because they need access.
- "Assigned to me" means open work assigned to me or my company.
- Inspection templates are org-wide and managed by org-wide roles or people with `workorder.configure`.
- Completion requires resolution notes from staff/vendors (not from a requester withdrawing).
- Times are entered and shown in the organization's time zone and stored in UTC.

## Database changes

- `0005_operations`: `org_counters`, `sla_policies`, `triage_rules`, `work_orders`, `timeline_events`, `tasks`, `task_checklist_items`, `inspection_templates`, `inspections`, `inspection_items`, `incidents`, `complaints`, `files`, `notifications`, `notification_preferences`, `outbox_events` (+ indexes, per-org unique numbers, idempotency index).
- `0006_rls_operations`: `app_system()`; tenant policies on all 13 record tables; own-user policies on notifications and preferences; outbox policies.
- `0007_notifications_insert`: a request context can only create notifications for its own user; only the worker notifies others.
- Permission `workorder.configure` (facility, portfolio and property managers, org admin).
- Seed: SLA targets, 9 triage rules, ~175 work orders over 90 days with timelines, tasks, templates and inspections, incidents, complaints, notifications; a small ops dataset in the second tenant for isolation tests.

## Routes and server actions

Pages under `/o/{org}/`: `maintenance`, `maintenance/new`, `maintenance/{id}`, `tasks`, `tasks/new`, `tasks/{id}`, `inspections`, `inspections/new`, `inspections/templates`, `inspections/{id}`, `incidents`, `incidents/new`, `incidents/{id}`, `complaints`, `complaints/new`, `complaints/{id}`, `notifications`, `settings/maintenance`.
Route handler: `GET /o/{org}/files/{fileId}` (permission-checked download).
Server actions (`src/app/o/[orgSlug]/ops-actions.ts`): create/transition/assign/schedule/comment/edit work orders, upload attachments, SLA and rule configuration, task create/status/checklist/assign/comment, inspection templates/schedule/record item/complete/follow-up, incident create/update, complaint create/update/comment, notifications mark read/open/preferences. The versioned public REST API is still Iteration 10.

## Tests

- Unit: 68 (incl. maintenance rules: transitions by role, triage precedence, SLA math, overdue; time-zone conversion).
- Integration: 169 against real Postgres (new `operations.test.ts`: triage, numbering, resident/vendor/scoped-manager visibility, comment visibility, role-limited transitions, completion requirements, notification delivery and idempotency, SLA monitor, KPIs, configuration scope, file sniffing/visibility/audit/cross-tenant, task dependencies and recurrence, inspections → follow-ups, incident and complaint privacy, notification preferences). Tenant isolation now covers all 16 new tables, plus notification and outbox policies.
- E2E: 21 Playwright runs (desktop + mobile), including the full resident → manager → vendor → resident slice with a photo upload, an inspection to follow-up work order, resident/vendor restrictions, and mobile submission.

## Bugs found and fixed during the iteration

- **Status form could submit the wrong status:** after a failed submit, React's form reset reverted the radio buttons in the page while the component still showed "Complete", so the next submit posted the first option. The value is now posted from a hidden input (same fix in inspection items).
- Incident notifications read the *current* severity instead of the severity at the time of the event.
- Seed: "assigned" work orders without anyone assigned; staff-submitted requests at properties the submitter doesn't manage.
- System roles in an existing database need `npm run db:migrate` to pick up new permissions (documented; migrate syncs them).

## Known issues / limits

- S3 adapter compiles and follows the AWS SDK presigning API but wasn't run against a real bucket here; Docker wasn't available in the build environment (Dockerfile and compose updated, not executed).
- Emails go through the existing mailer (console/SMTP); SMS/push are not implemented.
- Emergency routing doesn't know who is on call yet (needs shifts, Iteration 5).
- No calendar view yet for scheduled visits/inspections (Iteration 5/9).
- Malware scanning is a no-op hook; HEIC images are stored but not previewed.
- Success messages disappear when an action removes its own form (e.g., completing a job); the page state (badges, timeline) shows the result instead.
