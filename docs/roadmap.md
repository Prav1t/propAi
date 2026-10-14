# Implementation Roadmap

Each iteration must end runnable, building, tested, documented, with demo data. Status is updated at the end of every iteration.

| # | Iteration | Status | Exit criteria (summary) |
|---|---|---|---|
| 0 | Discovery + architecture | ✅ Done | Research, requirements, architecture, AI architecture, schema, roadmap docs |
| 1 | Application foundation | ✅ Done | Register → verify → create org → enter; login with MFA; invitations; RBAC + scopes; RLS tenant isolation proven by tests; settings; audit log; seed; Docker |
| 2 | Property / portfolio core | ✅ Done | CRUD for portfolios, properties, buildings, floors, units, residents (occupancy), staff, vendors; search + filters; detail pages; Cmd/Ctrl-K navigation |
| 3 | Operations core | ✅ Done | Maintenance state machine + SLA, vendor assignment + vendor portal, tasks, inspections (templates, checklists), incidents, complaints; outbox events; notifications (in-app + email) |
| 4 | Community + resident experience | ✅ Done | Resident dashboard (mobile-first), amenities + booking rules engine, packages, announcements, messaging, documents + file storage |
| 5 | Concierge + facility | ✅ Done | Concierge console, visitors + QR passes, parking permits/violations, shifts + handoff notes, assets, preventive maintenance, downtime |
| 6 | AI foundation | ✅ Done | Provider abstraction (Anthropic, OpenAI, compatible, demo), 22 read-only permission-filtered tools, orchestrator, private conversations, tool-call log, usage + caps, chat UI with status states, eval suite |
| 7 | Agentic AI | ✅ Done | 13 action tools (prepare → execute → verify), policy engine (org + property rules, risk classes, hard limits), approval plans with Approve / Edit / Cancel, re-authorization, AI-marked audit, tone-aware drafts, demo-mode actions, eval cases for actions |
| 8 | RAG + knowledge base | ✅ Done | pgvector passages from documents (PDF, Word, text) and versioned knowledge entries, indexing queue, embedding providers (+ offline demo embedder), permission-aware hybrid retrieval, cited answers, knowledge base admin with index status and "try a question", policy grounding for actions |
| 9 | Analytics + automation | ⏭ Next | KPI dashboards from real data, reports + CSV, property health score, workflow engine (WHEN/IF/THEN), SLA monitor, daily brief |
| 10 | Billing + integrations | | Config-driven plans, trial, mock + Stripe billing adapter, API keys, versioned REST API docs, outgoing webhooks (HMAC, retries, SSRF-safe) |
| 11 | Security hardening | | Threat model review, pen-test style tests, SSO/OAuth, org-enforced MFA, privacy export/deletion, rate limits on Redis |
| 12 | UX polish | | Loading/empty/error states, accessibility audit, mobile passes, PWA, voice input |
| 13 | Production readiness | | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md) · [4](iterations/iteration-04.md) · [5](iterations/iteration-05.md) · [6](iterations/iteration-06.md) · [7](iterations/iteration-07.md) · [8](iterations/iteration-08.md)

## Iteration 9 — detailed plan (analytics + automation)

Vertical slice first: **an admin builds a rule "WHEN a maintenance request is marked emergency at Fraser Towers → set priority urgent, notify the property manager and whoever is on call, create an escalation task due in 1 hour, and ask the manager to approve dispatching Summit Elevator Services if the category is elevator" → a resident reports a stuck elevator → the run log shows each step, the approval lands in the manager's queue, and the analytics page counts the run.** Every number on a dashboard comes from a query over recorded rows, and the assistant answers numeric questions from the same metric definitions.

1. **Metric catalog** (`src/server/analytics/*`): one typed definition per metric (work-order volume, response and resolution time, SLA compliance, backlog age, complaint and incident trends, vendor scorecard, maintenance spend, asset downtime, amenity utilisation, package volume and dwell time, staff workload), each scoped by the reader's properties and computed in SQL with period-over-period comparison. Unit-tested against hand-built fixtures.
2. **Analytics pages:** portfolio and property dashboards (filters: period, property, building), drill-down to the records behind each number, accessible charts with a table view, CSV export of every report, a PDF-ready print layout.
3. **Property health score:** a configurable weighted score per property from backlog, SLA compliance, complaint and incident rates, inspection failures, downtime and vendor performance — every factor shown with its value, weight and the records behind it; no opaque number.
4. **AI analytics:** `query_metrics` (any catalog metric by period, property, category, vendor) and `compare_periods` tools, so "How much did maintenance spending change this quarter?" is answered from a query result; eval cases check that every number in the answer comes from the tool.
5. **Workflow engine:** `workflows` (trigger, conditions, ordered actions, scope, enabled), `workflow_runs` + per-step results, consuming the existing outbox events (request created/emergency/status changed, SLA approaching/breached, booking created, package received, inspection failed, complaint/incident created, document uploaded) and schedules (cron-like, in the org's time zone). Actions: assign, set priority/status, notify (people, roles, on call), create task, escalate, send a templated communication (always as a draft needing approval), **request approval from a named role** (the second-person approval carried over from Iteration 7), and run an assistant step whose output is a draft. Loop protection, idempotent runs, audit entries marked automated.
6. **Builder UI:** WHEN → IF → THEN cards with plain-language summaries, a dry run against a past event ("this would have…"), enable/disable, run history.
7. **SLA monitoring:** "approaching SLA" warnings (configurable lead time) alongside breaches, feeding both notifications and workflows.
8. **Daily operations brief:** a scheduled per-manager brief (new and overdue requests, critical incidents, inspections, vendor visits, bookings, packages, anomalies) delivered in-app and by email, also on request ("Give me my morning briefing"); proactive insights (e.g. "water-related requests in Tower B doubled vs. the 4-week average") computed from recorded data with the rows behind them.
9. **Tests:** metric definitions vs. fixtures, scope leaks in analytics, workflow trigger → run → actions end to end, loop protection, approval routing, schedules across DST, E2E for the builder and dashboards.

Carried over: routing approvals to a second person (manager sign-off) moves to the workflow engine's "request approval" action (Iteration 9); text recognition (OCR) for scanned PDFs and images, and indexing spreadsheets/slides (later, behind a flag); voice input for the assistant (Iteration 12), web push notifications (manifest exists; service worker + VAPID in Iteration 12), payment collection for amenity fees/deposits (Iteration 10), Google/Outlook calendar sync (Iteration 10 integrations), camera / licence-plate-recognition integration beyond the `ingestDetection` entry point (later, behind a feature flag), Docker compose run on a machine with Docker.
