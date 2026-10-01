# Implementation Roadmap

Each iteration must end runnable, building, tested, documented, with demo data. Status is updated at the end of every iteration.

| # | Iteration | Status | Exit criteria (summary) |
|---|---|---|---|
| 0 | Discovery + architecture | ✅ Done | Research, requirements, architecture, AI architecture, schema, roadmap docs |
| 1 | Application foundation | ✅ Done | Register → verify → create org → enter; login with MFA; invitations; RBAC + scopes; RLS tenant isolation proven by tests; settings; audit log; seed; Docker |
| 2 | Property / portfolio core | ✅ Done | CRUD for portfolios, properties, buildings, floors, units, residents (occupancy), staff, vendors; search + filters; detail pages; Cmd/Ctrl-K navigation |
| 3 | Operations core | ✅ Done | Maintenance state machine + SLA, vendor assignment + vendor portal, tasks, inspections (templates, checklists), incidents, complaints; outbox events; notifications (in-app + email) |
| 4 | Community + resident experience | ⏭ Next | Resident dashboard (mobile-first), amenities + booking rules engine, packages, announcements, messaging, documents + file storage |
| 5 | Concierge + facility | | Concierge console, visitors + QR passes, parking permits/violations, shifts + handoff notes, assets, preventive maintenance, downtime |
| 6 | AI foundation | | Provider abstraction (incl. demo mode), tool registry, read-only tools, conversations, AI logs, chat UI with status states |
| 7 | Agentic AI | | Mutation tools, policy engine, dry-run plans, approvals, verification, AI eval suite |
| 8 | RAG + knowledge base | | pgvector, ingestion, chunking, permission-aware retrieval, citations, KB admin UI |
| 9 | Analytics + automation | | KPI dashboards from real data, reports + CSV, property health score, workflow engine (WHEN/IF/THEN), SLA monitor, daily brief |
| 10 | Billing + integrations | | Config-driven plans, trial, mock + Stripe billing adapter, API keys, versioned REST API docs, outgoing webhooks (HMAC, retries, SSRF-safe) |
| 11 | Security hardening | | Threat model review, pen-test style tests, SSO/OAuth, org-enforced MFA, privacy export/deletion, rate limits on Redis |
| 12 | UX polish | | Loading/empty/error states, accessibility audit, mobile passes, PWA, voice input |
| 13 | Production readiness | | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md)

## Iteration 4 — detailed plan (community + resident experience)

Vertical slice first: **a resident books the party room from their phone → booking rules are checked (window, duration, capacity, blackout dates, approval, deposit) → manager approves → resident is notified; a package arrives → concierge logs it → resident is notified → pickup is signed for.**

1. **Schema:** `amenities` (per property/building, capacity, hours, booking window, min/max duration, approval required, deposit/fee config, active), `amenity_rules` (blackout dates, per-unit limits, resident eligibility), `bookings` (status machine: requested → approved/declined → cancelled/completed; conflict-safe with an exclusion constraint on `tstzrange`), `packages` (carrier, tracking, recipient unit/resident, shelf location, photo, received_by, picked_up_at + signature/name), `announcements` (property/building audience, publish/expire, pinned), `message_threads` + `messages` (resident ↔ management), `documents` + `document_versions` (category, audience, visibility) reusing `files`. RLS + isolation tests on every table.
2. **Booking rules engine (pure, unit-tested):** availability, overlap, booking window, max per unit per period, blackout dates, approval and deposit requirements → a decision with reasons. Iteration 7's AI will call the same engine.
3. **Resident experience (mobile-first):** home screen with requests, bookings, packages, announcements and messages; book an amenity; see and cancel bookings; package list with pickup codes; message management; documents library.
4. **Staff:** amenity setup, booking approvals queue and calendar (day/week/agenda), package log with fast intake (unit lookup, carrier, shelf), bulk pickup, overdue-package view; announcement composer with audience preview; inbox for resident messages; document library with versions.
5. **Notifications:** new kinds (booking requested/approved/declined, package arrived/reminder, announcement published, new message) through the existing outbox.
6. **Tests:** rules-engine unit tests, overlap constraint integration test, resident/staff visibility, cross-tenant checks, E2E: resident books → manager approves → resident notified; concierge logs package → resident sees it.

Carried over from Iteration 3: S3/MinIO verified in Docker (the adapter exists but wasn't run against a real bucket in the build environment), shift-aware on-call routing for emergencies (Iteration 5 with shifts).
