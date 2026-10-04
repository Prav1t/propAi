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
| 7 | Agentic AI | ⏭ Next | Mutation tools, policy engine, dry-run plans, approvals, verification, eval cases for actions |
| 8 | RAG + knowledge base | | pgvector, ingestion, chunking, permission-aware retrieval, citations, KB admin UI |
| 9 | Analytics + automation | | KPI dashboards from real data, reports + CSV, property health score, workflow engine (WHEN/IF/THEN), SLA monitor, daily brief |
| 10 | Billing + integrations | | Config-driven plans, trial, mock + Stripe billing adapter, API keys, versioned REST API docs, outgoing webhooks (HMAC, retries, SSRF-safe) |
| 11 | Security hardening | | Threat model review, pen-test style tests, SSO/OAuth, org-enforced MFA, privacy export/deletion, rate limits on Redis |
| 12 | UX polish | | Loading/empty/error states, accessibility audit, mobile passes, PWA, voice input |
| 13 | Production readiness | | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md) · [4](iterations/iteration-04.md) · [5](iterations/iteration-05.md) · [6](iterations/iteration-06.md)

## Iteration 7 — detailed plan (agentic AI: actions with approvals)

Vertical slice first: **a manager says "Create a maintenance request for the broken elevator in Tower B and assign Summit Elevator" → the assistant checks for duplicates, resolves the building and vendor, and shows a dry-run plan ("Create WO … at Fraser Towers · Tower B, priority urgent; assign Summit Elevator Services") with [Approve] [Edit] [Cancel] → on approval it runs the same `createWorkOrder` / `assignWorkOrder` services as the UI, re-reads the record to verify, reports the result with a link, and the audit log shows `ai_generated` with the approval id.** A resident asking the assistant to book the party room gets the same flow for their own booking; nothing external (messages, announcements) is ever sent without the user's confirmation.

1. **Action tools** (risk classes 2–4) with `preview(args) → plain-language step`, `execute` through existing services, `verify` (re-read): `create_work_order`, `assign_work_order`, `update_work_order_status`, `comment_on_work_order`, `create_task`, `assign_task`, `schedule_inspection`, `create_booking`, `cancel_booking`, `log_package` (resident notified through the outbox), `register_visitor`, `create_incident`, `draft_announcement` (class 2) / `publish_announcement` (class 3), `send_resident_message` (class 3).
2. **Policy engine** (`src/server/ai/policy.ts`): `(principal, tool, args, riskClass, org + property policy) → allow | require_approval | deny`; defaults from `ai-architecture.md` §14; `ai_policies` per org/property ("AI may create internal tasks automatically", "AI must ask before contacting residents") that can only tighten class 5. Admin UI under *Organization → AI assistant*.
3. **Plans and approvals:** `ai_approvals` (plan steps with validated args and previews, status pending/approved/rejected/expired/executed/failed, decided by/at, expiry). Approval cards in the chat; **Edit** re-validates arguments; approval **re-authorizes** at execution (permissions may have changed); each step its own transaction with per-step results; expired plans can't run.
4. **Audit:** services write `ai_generated = true` and `approval_id` when called on the assistant's behalf (through `TenantCtx`), so the audit log separates AI actions from clicks.
5. **Communication drafts:** tone options (professional, friendly, concise, urgent, formal) for announcements and messages; always shown for review before anything is sent.
6. **Demo model:** "create/book/assign/send" phrasings produce real plans in demo mode too, so the approval UX is explorable and E2E-testable without a key.
7. **Eval cases for actions:** class ≥ 3 never executes without an approval record; edits are re-validated; a permission removed between plan and approval blocks execution; no duplicate execution on double-approve; the assistant reports exactly what ran.
8. **UI:** pending approvals list, approval state in the lookup trail ("Waiting for approval → Executing → Completed / Failed"), links to created records.

Carried over: voice input for the assistant (Iteration 12), web push notifications (manifest exists; service worker + VAPID in Iteration 12), payment collection for amenity fees/deposits (Iteration 10), Google/Outlook calendar sync (Iteration 10 integrations), camera / licence-plate-recognition integration beyond the `ingestDetection` entry point (later, behind a feature flag), Docker compose run on a machine with Docker.
