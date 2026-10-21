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
| 9 | Analytics + automation | ✅ Done | Metric catalog (24 metrics, SQL, scoped), analytics page with accessible charts, 10 reports + CSV + print, explainable property health score, workflow engine (11 event triggers + schedules, conditions, 10 actions, role-based approvals, loop protection, idempotent runs), rule builder with dry run and run log, "due soon" SLA warnings, daily brief, insights, assistant analytics tools |
| 10 | Billing + integrations | ✅ Done | Plans as configuration with entitlements and limits, 14-day trials, read-only mode on lapse, usage metering, billing provider abstraction (labelled development provider + Stripe adapter, idempotent events), scoped API keys, REST API v1 with OpenAPI + reference page, signed webhooks with retries/auto-disable/replay (SSRF-safe), Slack/Teams/Twilio/Resend/SendGrid, feature flags, platform console |
| 11 | Security hardening | ⏭ Next | Threat model review, pen-test style tests, SSO/OAuth, org-enforced MFA, privacy export/deletion, rate limits on Redis |
| 12 | UX polish | | Loading/empty/error states, accessibility audit, mobile passes, PWA, voice input |
| 13 | Production readiness | | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md) · [4](iterations/iteration-04.md) · [5](iterations/iteration-05.md) · [6](iterations/iteration-06.md) · [7](iterations/iteration-07.md) · [8](iterations/iteration-08.md) · [9](iterations/iteration-09.md) · [10](iterations/iteration-10.md)

## Iteration 11 — detailed plan (security hardening)

Goal: every critical/high finding fixed and proven by a test; the controls an enterprise security review asks for exist.

1. **Threat model and review** (`docs/security/threat-model.md`): assets, trust boundaries (browser, API keys, provider webhooks, worker, AI tools, outbound fetches), STRIDE per boundary, with a finding log. Review every route handler, server action and service for authorization on the record (not just the page), and every `system`/`platformAdmin` context use.
2. **Pen-test style suite** (`tests/security/*`): IDOR sweeps (every `[id]` route and API path with another org's and another property's ids), privilege escalation (role change to a higher role, inviting with a role above your own, editing your own membership), mass assignment on forms and API bodies, CSRF on server actions (Origin checks), open redirects (`next=`), XSS through markdown/notes/filenames/webhook descriptions, SQL injection probes on search and filters, file upload abuse (polyglots, oversized, path names), webhook SSRF bypasses (DNS rebinding, IPv6 forms, redirects), API key brute force and timing, rate-limit evasion.
3. **Rate limits on Redis** (`REDIS_URL`): the `RateLimiter` interface gets a Redis adapter (sliding window); sign-in, MFA, invitations, the assistant and per-key API limits become correct across instances. Lift the single-instance note.
4. **SSO / OAuth**: OpenID Connect sign-in (Google, Microsoft Entra ID, Okta) with domain verification and just-in-time membership; an organization setting to require SSO and/or MFA for staff roles; session invalidation when enforcement changes.
5. **Sessions and secrets**: list and revoke sessions per user and org-wide on deactivation (already partly done), re-auth for sensitive changes (MFA reset, API keys, billing), `APP_ENCRYPTION_KEY` rotation with key ids on ciphertexts (MFA secrets, webhook secrets, integration credentials).
6. **Privacy (PIPEDA/GDPR principles)**: per-person data export (JSON + files) and deletion/anonymisation workflows with legal holds, retention settings for messages, visitor logs, parking evidence and audit logs, consent records for SMS/email; documented, not claimed as certification.
7. **Headers and transport**: strict CSP (nonce-based scripts), HSTS, frame-ancestors, referrer policy, permissions policy; tests assert them.
8. **Audit completeness**: document-access logging, permission changes, API key use summaries; a tamper-evidence hash chain on `audit_logs`.
9. **Dependency and secret scanning** in CI (npm audit gate, gitleaks), SBOM.

Carried over: SMS notification delivery (needs per-person phone numbers and consent — with privacy work above), Google/Outlook calendar sync implementation (`CalendarSync` contract exists), payment collection for amenity fees and deposits, OCR for scanned PDFs, voice input (Iteration 12), web push (Iteration 12), camera / licence-plate integration beyond `ingestDetection`, a visual flow view of automation rules (Iteration 12), Docker compose run on a machine with Docker, the `resident.created` webhook (needs a resident event in the outbox).
