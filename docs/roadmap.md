# Implementation Roadmap

Each iteration must end runnable, building, tested, documented, with demo data. Status is updated at the end of every iteration.

| # | Iteration | Status | Exit criteria (summary) |
|---|---|---|---|
| 0 | Discovery + architecture | ✅ Done | Research, requirements, architecture, AI architecture, schema, roadmap docs |
| 1 | Application foundation | ✅ Done | Register → verify → create org → enter; login with MFA; invitations; RBAC + scopes; RLS tenant isolation proven by tests; settings; audit log; seed; Docker |
| 2 | Property / portfolio core | ✅ Done | CRUD for portfolios, properties, buildings, floors, units, residents (occupancy), staff, vendors; search + filters; detail pages; Cmd/Ctrl-K navigation |
| 3 | Operations core | ⏭ Next | Maintenance state machine + SLA, vendor assignment + vendor portal, tasks, inspections (templates, checklists), incidents, complaints; outbox events; notifications (in-app + email) |
| 4 | Community + resident experience | | Resident dashboard (mobile-first), amenities + booking rules engine, packages, announcements, messaging, documents + file storage |
| 5 | Concierge + facility | | Concierge console, visitors + QR passes, parking permits/violations, shifts + handoff notes, assets, preventive maintenance, downtime |
| 6 | AI foundation | | Provider abstraction (incl. demo mode), tool registry, read-only tools, conversations, AI logs, chat UI with status states |
| 7 | Agentic AI | | Mutation tools, policy engine, dry-run plans, approvals, verification, AI eval suite |
| 8 | RAG + knowledge base | | pgvector, ingestion, chunking, permission-aware retrieval, citations, KB admin UI |
| 9 | Analytics + automation | | KPI dashboards from real data, reports + CSV, property health score, workflow engine (WHEN/IF/THEN), SLA monitor, daily brief |
| 10 | Billing + integrations | | Config-driven plans, trial, mock + Stripe billing adapter, API keys, versioned REST API docs, outgoing webhooks (HMAC, retries, SSRF-safe) |
| 11 | Security hardening | | Threat model review, pen-test style tests, SSO/OAuth, org-enforced MFA, privacy export/deletion, rate limits on Redis |
| 12 | UX polish | | Loading/empty/error states, accessibility audit, mobile passes, PWA, voice input |
| 13 | Production readiness | | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

## Iteration 3 — detailed plan (operations core)

Vertical slice first: **resident submits a request → manager triages → assigns staff or vendor → vendor sees only their job → status updates notify the resident → completion with cost and resolution notes.**

1. **Schema:** `work_orders` (number per org, property/building/unit/area, category, priority, emergency flag, status state machine, submitted_by, assigned membership / vendor, SLA due timestamps, scheduled window, completed_at, cost, resolution), `work_order_events` (timeline: status changes, comments, assignments), `sla_policies` (per org/property × priority: respond-within, resolve-within), `tasks` (+ checklist items, recurrence rule, dependencies), `inspection_templates` / `inspections` / `inspection_items` (pass/fail/N/A, severity, notes), `incidents` (+ events, people involved), `complaints`, `outbox_events`, `notifications`, `notification_preferences`. RLS + isolation tests for every table.
2. **Rules, not AI:** configurable emergency keywords and category → team routing per property (the AI in Iteration 7 will call these same rules).
3. **Services:** state machine with allowed transitions per role; vendor principals (`vendorId`) see only their assigned work orders (`workorder.read.assigned`); residents see only their own (`.own`); SLA due dates computed from policy; every change writes a timeline event + audit log + outbox event.
4. **Notifications:** outbox worker (in-process, polling) delivering in-app notifications and email through the existing mailer; notification bell + inbox; per-user preferences.
5. **UI:** maintenance board (list + filters + status tabs), work order detail with timeline and actions, resident "submit a request" mobile-first form, vendor portal job list, tasks, inspections (run a checklist on mobile), incidents, complaints. Dashboard KPIs from real data: open, overdue, by category, avg response/resolution time.
6. **File attachments:** photos on requests/inspections/incidents via S3-compatible storage (MinIO in Docker), signed URLs, type/size validation — moved up from Iteration 4 because maintenance needs photos.
7. **Tests:** state-machine unit tests, SLA math, vendor/resident record-level visibility, cross-tenant attempts on every new table, E2E for the full vertical slice.
