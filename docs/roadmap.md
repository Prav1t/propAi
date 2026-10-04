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
| 6 | AI foundation | ⏭ Next | Provider abstraction (incl. demo mode), tool registry, read-only tools, conversations, AI logs, chat UI with status states |
| 7 | Agentic AI | | Mutation tools, policy engine, dry-run plans, approvals, verification, AI eval suite |
| 8 | RAG + knowledge base | | pgvector, ingestion, chunking, permission-aware retrieval, citations, KB admin UI |
| 9 | Analytics + automation | | KPI dashboards from real data, reports + CSV, property health score, workflow engine (WHEN/IF/THEN), SLA monitor, daily brief |
| 10 | Billing + integrations | | Config-driven plans, trial, mock + Stripe billing adapter, API keys, versioned REST API docs, outgoing webhooks (HMAC, retries, SSRF-safe) |
| 11 | Security hardening | | Threat model review, pen-test style tests, SSO/OAuth, org-enforced MFA, privacy export/deletion, rate limits on Redis |
| 12 | UX polish | | Loading/empty/error states, accessibility audit, mobile passes, PWA, voice input |
| 13 | Production readiness | | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md) · [4](iterations/iteration-04.md) · [5](iterations/iteration-05.md)

## Iteration 6 — detailed plan (AI foundation, read-only)

Vertical slice first: **a property manager asks "Show me all overdue maintenance requests across my properties" → the assistant calls a typed, permission-filtered tool → the answer lists real work orders with links → the conversation, tool calls, tokens and cost are logged. A resident asking for other people's data gets a refusal that leaks nothing.** No AI action changes data in this iteration; mutations, approvals and the policy engine are Iteration 7.

1. **Model abstraction** (`src/server/ai/providers/*`): one `ChatModel` interface (messages + tool definitions → text and/or tool calls, streamed) with adapters for Anthropic, OpenAI and an OpenAI-compatible endpoint (local / self-hosted), selected by `AI_PROVIDER` / `AI_MODEL`; plus a **clearly labelled demo provider** that works without an API key by routing a fixed set of intents to the same tools (so the product is explorable offline and E2E tests are deterministic). A `routeModel(task)` seam for cheap vs advanced models (only one tier wired at first).
2. **Tool registry** (`src/server/ai/tools/*`): `defineTool({ name, description, input: zod, permission(s), riskClass, execute })` where `execute` calls the existing domain services with the user's `TenantCtx` — never SQL. Tools exposed to the model are filtered by the principal's permissions. First tools (read-only): `search_work_orders`, `get_work_order`, `search_units`, `search_residents` (staff only), `search_vendors`, `vendor_performance`, `search_bookings`, `check_amenity_availability`, `search_packages`, `search_visitors`, `search_incidents`, `search_complaints`, `asset_history` (recurring failures, downtime, cost), `whos_on_shift`, `shift_summary` (handoff snapshot), `ops_kpis` (the dashboard numbers), `calendar_range`.
3. **Orchestrator:** load conversation → build system prompt (role, properties in scope, time zone, rules: answer only from tool results, say when data is missing, never invent numbers) → model ↔ tool loop with a step limit and timeout → final answer with record links. Ambiguity ("which Tower B?") is surfaced as a question, not a guess.
4. **Storage + logging:** `ai_conversations`, `ai_messages` (role, content, tool calls/results summarised), `ai_tool_calls` (tool, args, outcome, duration, correlation id), `ai_usage` (provider, model, input/output tokens, estimated cost, org, user). RLS + isolation tests on all of them. Audit entries for tool calls that read sensitive data (resident directory, files).
5. **UI:** an assistant panel (page + Cmd/Ctrl-K "Ask [YOUR AI ASSISTANT NAME]") with streamed answers, visible status states (Thinking → Looking up work orders → Done / Failed), tool-result cards that link to records, conversation history, a "demo mode" badge when no provider key is set. Mobile layout for residents and the front desk.
6. **Specialised modes (prompts + tool subsets):** Property, Maintenance, Front desk, Resident, Facility — same infrastructure.
7. **AI evaluation suite (first cut):** scripted conversations run against the demo provider (and against a real provider when a key is present) checking tool choice, argument shape, permission compliance (resident asks for another building → refused, no data in the answer), "no fabricated numbers" (every number in the answer appears in a tool result), and ambiguity handling.
8. **Admin:** AI usage per org/user (requests, tokens, estimated cost) on the org settings page; a per-org monthly request cap enforced before calling the provider.

Carried over: web push notifications (manifest exists; service worker + VAPID in Iteration 12), payment collection for amenity fees/deposits (Iteration 10), Google/Outlook calendar sync (Iteration 10 integrations), camera / licence-plate-recognition integration beyond the `ingestDetection` entry point (later, behind a feature flag), Docker compose run on a machine with Docker.
