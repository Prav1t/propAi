# Implementation Roadmap

Each iteration must end runnable, building, tested, documented, with demo data. Status is updated at the end of every iteration.

| # | Iteration | Status | Exit criteria (summary) |
|---|---|---|---|
| 0 | Discovery + architecture | ✅ Done | Research, requirements, architecture, AI architecture, schema, roadmap docs |
| 1 | Application foundation | ✅ Done | Register → verify → create org → enter; login with MFA; invitations; RBAC + scopes; RLS tenant isolation proven by tests; settings; audit log; seed; Docker |
| 2 | Property / portfolio core | ⏭ Next | CRUD for portfolios, properties, buildings, floors, units, residents (occupancy), staff, vendors; search + filters; detail pages; Cmd/Ctrl-K navigation |
| 3 | Operations core | | Maintenance state machine + SLA, vendor assignment + vendor portal, tasks, inspections (templates, checklists), incidents, complaints; outbox events; notifications (in-app + email) |
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

## Iteration 2 — detailed plan

1. **Schema:** add `vendors`, `vendor_contacts`, `staff_profiles` (skills, properties), `parking_spaces`/`storage_lockers` placeholders only if used by UI; extend `units` with `status`, `sq_ft`; residents = users with `unit_occupancies` + contact-only residents (no login) via `people` table.
2. **Services:** `portfolios`, `properties`, `buildings`, `floors`, `units`, `occupancies`, `vendors`, `staff` with Zod schemas, `authorize()` on every call, audit logs on every mutation.
3. **UI:** list pages with server-side pagination, filters and sort in URL params; detail pages with relationship navigation (property → buildings → floors → units → occupants); create/edit forms; delete with confirmation and audit.
4. **Search:** Postgres full-text (`tsvector` generated columns) across properties, units, residents, vendors, staff — permission-aware.
5. **Command bar:** Cmd/Ctrl-K with navigation + entity search.
6. **Tests:** service unit tests, scope tests (PM of Property A cannot see Property B units), isolation tests for every new table, E2E create-property → building → unit → assign resident.
