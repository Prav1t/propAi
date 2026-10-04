# Implementation Roadmap

Each iteration must end runnable, building, tested, documented, with demo data. Status is updated at the end of every iteration.

| # | Iteration | Status | Exit criteria (summary) |
|---|---|---|---|
| 0 | Discovery + architecture | ✅ Done | Research, requirements, architecture, AI architecture, schema, roadmap docs |
| 1 | Application foundation | ✅ Done | Register → verify → create org → enter; login with MFA; invitations; RBAC + scopes; RLS tenant isolation proven by tests; settings; audit log; seed; Docker |
| 2 | Property / portfolio core | ✅ Done | CRUD for portfolios, properties, buildings, floors, units, residents (occupancy), staff, vendors; search + filters; detail pages; Cmd/Ctrl-K navigation |
| 3 | Operations core | ✅ Done | Maintenance state machine + SLA, vendor assignment + vendor portal, tasks, inspections (templates, checklists), incidents, complaints; outbox events; notifications (in-app + email) |
| 4 | Community + resident experience | ✅ Done | Resident dashboard (mobile-first), amenities + booking rules engine, packages, announcements, messaging, documents + file storage |
| 5 | Concierge + facility | ⏭ Next | Concierge console, visitors + QR passes, parking permits/violations, shifts + handoff notes, assets, preventive maintenance, downtime |
| 6 | AI foundation | | Provider abstraction (incl. demo mode), tool registry, read-only tools, conversations, AI logs, chat UI with status states |
| 7 | Agentic AI | | Mutation tools, policy engine, dry-run plans, approvals, verification, AI eval suite |
| 8 | RAG + knowledge base | | pgvector, ingestion, chunking, permission-aware retrieval, citations, KB admin UI |
| 9 | Analytics + automation | | KPI dashboards from real data, reports + CSV, property health score, workflow engine (WHEN/IF/THEN), SLA monitor, daily brief |
| 10 | Billing + integrations | | Config-driven plans, trial, mock + Stripe billing adapter, API keys, versioned REST API docs, outgoing webhooks (HMAC, retries, SSRF-safe) |
| 11 | Security hardening | | Threat model review, pen-test style tests, SSO/OAuth, org-enforced MFA, privacy export/deletion, rate limits on Redis |
| 12 | UX polish | | Loading/empty/error states, accessibility audit, mobile passes, PWA, voice input |
| 13 | Production readiness | | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md) · [4](iterations/iteration-04.md)

## Iteration 5 — detailed plan (concierge + facility management)

Vertical slices first:
1. **Front desk:** a resident pre-registers a guest from their phone → the guest gets a QR pass → the concierge scans or searches it, checks the guest in (visitor parking assigned if requested) → the resident is notified → check-out closes the visit; contractors are checked in against an open work order.
2. **Facility:** an asset (e.g. HVAC unit 4) has a preventive-maintenance schedule → the worker generates the work order when it falls due → the technician completes it → downtime and cost roll up on the asset, and repeated failures are visible.

Planned work:

1. **Schema (all with RLS + isolation tests):** `visitors` (host unit/resident, name, kind guest/delivery/contractor/service, expected window, status expected/checked_in/checked_out/cancelled/denied, QR token hash, checked in/out by and at, linked work order), `parking_spaces` (property/building, code, type assigned/visitor/accessible/EV/loading, assigned unit), `vehicles` (resident/unit, plate normalised, make/model/colour), `parking_permits` (vehicle, space or zone, valid from/to, visitor flag), `parking_violations` (plate, space, evidence files, status reported/warned/resolved/escalated — human review required; detections are never conclusions), `storage_lockers`, `shifts` (property, membership, start/end, role on shift), `shift_handoffs` (notes, open items snapshot), `assets` (property/building/unit/area, category, make/model/serial, install date, warranty, criticality, status), `pm_schedules` (asset, interval days or monthly rule, checklist template, lead days, next due), `asset_downtime` (asset, started/ended, reason, linked work order).
2. **Concierge console:** one screen for packages, expected visitors, checked-in visitors, open resident messages, today's bookings, incidents and tasks for the desk's building; fast search by unit or name; QR scan with the device camera (BarcodeDetector, manual fallback).
3. **Visitors:** resident pre-registration (single and recurring), staff walk-in registration, QR pass page (signed token, expiry, no personal data in the URL), check-in/out, visitor log with filters and CSV-ready export, notification to the host.
4. **Parking:** spaces map/list per building, resident vehicles, permits (assigned and visitor, with expiry), violations with evidence upload and a mandatory human review step before any warning goes out; plate search.
5. **Shifts + handoffs:** staff schedule (week view), who's on now, a handoff note built from live data (open tasks, new incidents, packages waiting, visitors on site, unanswered messages) — the AI shift summary in Iteration 6 will read the same query. Emergency work orders route to the on-call/on-shift staff for the property (closes the Iteration 3 gap).
6. **Assets + preventive maintenance:** asset registry with detail page (work order history, cost, downtime, files), PM schedules generated by the worker into work orders with `source_type = 'pm_schedule'`, downtime tracking from work orders flagged "asset down", a facility dashboard (assets by status, PM due/overdue, downtime hours, top repeat-failure assets).
7. **Unified calendar (first cut):** day/week/agenda view combining bookings, scheduled work orders, inspections, PM due dates, expected visitors and shifts — permission-filtered per source.
8. **Tests:** QR token tamper/expiry, visitor visibility (resident sees own guests only), parking review gate, PM generation idempotency, downtime math, on-call routing, isolation for every new table; E2E: resident registers a guest → concierge checks them in by pass → resident notified; PM schedule produces a work order.

Carried over: web push notifications (manifest exists; service worker + VAPID in Iteration 12), payment collection for amenity fees/deposits (Iteration 10 billing adapters; statuses are tracked manually today), Docker compose verified on a machine with Docker (not available in the build environment).
