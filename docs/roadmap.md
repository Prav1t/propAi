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
| 11 | Security hardening | ✅ Done | Threat model + finding log (13 findings fixed, each with a test), IDOR/escalation/tenant/injection suites, OIDC SSO (verified domains, JIT, PKCE, signature checks), org-enforced MFA/SSO, recent-auth for sensitive changes, one-time TOTP, absolute sessions, trusted-proxy IPs, Redis rate limits, nonce CSP + cross-site write guard, tamper-evident audit chain, key rotation, privacy export/erasure/legal holds/retention/consent, dependency + secret scanning, SBOM |
| 12 | UX polish | ✅ Done | Axe audit of every page per role (0 serious/critical, desktop + phone), keyboard and focus fixes, skeletons, streamed dashboard sections, error pages with references, real 404s, phone tab bars, 44 px targets, list cards, camera capture, installable app with offline page, offline maintenance drafts sent once, web push (VAPID, per device, per kind), voice input (speech-to-text provider or browser), assistant follow-ups and plan diff, saved views, bulk work order changes, palette recents, shortcuts, rule flow view, custom role editor, signed-in members |
| 13 | Production readiness | ⏭ Next | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md) · [4](iterations/iteration-04.md) · [5](iterations/iteration-05.md) · [6](iterations/iteration-06.md) · [7](iterations/iteration-07.md) · [8](iterations/iteration-08.md) · [9](iterations/iteration-09.md) · [10](iterations/iteration-10.md) · [11](iterations/iteration-11.md) · [12](iterations/iteration-12.md) · [Accessibility audit](accessibility.md) · Security: [threat model](security/threat-model.md)

## Iteration 13 — detailed plan (production readiness)

Goal: someone other than the authors can deploy, operate, back up, restore and monitor the platform from the documentation, and the production configuration is safe by default.

1. **Build and run:**
   - the production Docker image checked on a machine with Docker (image size, non-root user, read-only filesystem where possible, healthcheck);
   - `docker compose` for a single-host deployment with the worker as its own service;
   - a release step that runs migrations before the new version takes traffic.
2. **Configuration:** start-up validation that refuses unsafe production settings, covering:
   - development flags;
   - missing keys;
   - HTTP origins;
   - mock billing without its override;
   - missing VAPID or trusted-proxy settings, reported as warnings.

   Every variable is documented in one place.
3. **Database operations:**
   - a migrations runbook (forward-only, expand/contract for risky changes, rollback by restore);
   - backup and point-in-time recovery guidance for managed Postgres;
   - a restore drill script that restores into a scratch database and runs the integrity checks: the audit-chain verify, RLS on every tenant table, row counts.
4. **Observability:**
   - structured logs with request ids end to end, including the worker and the assistant;
   - a metrics endpoint for request latency, error rates, queue depth (outbox, notifications, webhooks, indexing), worker lag and AI usage;
   - example dashboards and alerts;
   - an error-tracking adapter (Sentry-compatible) behind an interface.
5. **Health and resilience:**
   - liveness and readiness checks (database, Redis, storage), graceful shutdown that finishes in-flight work, and worker leases that survive restarts;
   - load tests on the busiest pages and the API with a large seeded portfolio, with the slowest queries indexed.
6. **Security configuration:**
   - a production checklist (TLS, HSTS preload decision, cookie settings, CSP report endpoint, secret manager, key rotation schedule, admin MFA);
   - dependency update policy.
7. **Documentation:** a deployment guide (single host, and a managed-cloud reference), an operations runbook (incidents, rotating keys, restoring, scaling the worker) and an upgrade guide.

Carried over (outside Iteration 13 unless listed above):

- **SMS notification delivery:** consent records exist now; it still needs per-person phone numbers and quiet hours.
- **Google/Outlook calendar sync:** the `CalendarSync` contract exists; the implementation doesn't.
- **Payment collection** for amenity fees and deposits.
- **OCR** for scanned PDFs.
- **Camera / licence-plate integration** beyond `ingestDetection`.
- **The `resident.created` webhook.**
- **GitHub Actions pinned to commit SHAs.**
- **An external penetration test.**
- **Live verification of SSO** against real Google, Entra and Okta tenants, and of DNS domain verification.
- **Offline inspection evidence** and offline caching of recently viewed pages.
- **Bulk actions on packages**, and column choices in saved views.
- **Streaming the analytics page** section by section.
