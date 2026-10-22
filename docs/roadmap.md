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
| 12 | UX polish | ⏭ Next | Loading/empty/error states, accessibility audit, mobile passes, PWA, voice input |
| 13 | Production readiness | | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md) · [4](iterations/iteration-04.md) · [5](iterations/iteration-05.md) · [6](iterations/iteration-06.md) · [7](iterations/iteration-07.md) · [8](iterations/iteration-08.md) · [9](iterations/iteration-09.md) · [10](iterations/iteration-10.md) · [11](iterations/iteration-11.md) · Security: [threat model](security/threat-model.md)

## Iteration 12 — detailed plan (UX and product polish)

Goal: the product feels commercially credible on desktop and phones, every screen handles loading, empty and error states, and an accessibility audit finds no serious issues.

1. **Accessibility audit:**
   - automated axe checks on every page in E2E (zero serious/critical violations);
   - keyboard-only passes through the main flows (resident request, booking, front desk intake, approvals, the assistant);
   - focus management in dialogs and drawers;
   - colour contrast in both themes;
   - screen-reader labels on charts, status badges and icon buttons.
2. **States:** skeletons for slow pages (dashboard, analytics, assistant history), consistent empty states with the next action, recoverable error pages (`error.tsx` per area) with request ids, optimistic updates where safe (marking notifications read, ticking checklists).
3. **Mobile passes:**
   - resident app, front desk, staff task list and inspections on 360–414 px widths;
   - bottom navigation for residents and staff;
   - touch targets of at least 44 px;
   - photo capture from the camera;
   - tables that reflow into cards.
4. **PWA:**
   - a service worker with an offline shell;
   - offline drafts for maintenance requests and inspection evidence, sent when back online;
   - installability;
   - web push for the notification engine (VAPID keys, per-device subscriptions, preferences), using the consent records from Iteration 11.
5. **Assistant experience:**
   - **voice input:** the browser's speech recognition where available, otherwise a provider speech-to-text adapter behind the model abstraction;
   - suggested follow-ups;
   - a clearer plan card diff when a plan is edited;
   - keyboard shortcuts.
6. **Navigation and tables:**
   - saved filters and column choices per user;
   - bulk actions on work orders and packages;
   - the command palette learns recent records;
   - breadcrumbs on deep pages.
7. **Automation:** a visual flow view of WHEN → IF → THEN rules, next to the existing sentence builder.
8. **Administration:**
   - a custom role editor (permission picker with scope level; the F-03 scope rules already constrain who can grant what);
   - organization-wide session list and sign-out for admins;
   - the security and privacy pages polished from usability testing.
9. **Dashboards:** role-specific dashboard refinements (property manager, facility, front desk, resident) with the health score and insights where they help.

Carried over (outside Iteration 12):

- **SMS notification delivery:** consent records exist now; it still needs per-person phone numbers and quiet hours.
- **Google/Outlook calendar sync:** the `CalendarSync` contract exists; the implementation doesn't.
- **Payment collection** for amenity fees and deposits.
- **OCR** for scanned PDFs.
- **Camera / licence-plate integration** beyond `ingestDetection`.
- **The `resident.created` webhook.**
- **Running Docker Compose on a machine with Docker.**
- **GitHub Actions pinned to commit SHAs.**
- **An external penetration test.**
- **Live verification of SSO** against real Google, Entra and Okta tenants, and of DNS domain verification.
