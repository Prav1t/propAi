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
| 13 | Production readiness | ✅ Done | Start-up configuration check, health probes, metrics, error tracking, worker turn-taking and clean shutdown, CSP reports, backup and restore drill, load test and index, production compose with TLS, deployment / operations / observability docs, security checklist. Also: strata meetings and votes, leases and rent tracking, the public landing page |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md) · [4](iterations/iteration-04.md) · [5](iterations/iteration-05.md) · [6](iterations/iteration-06.md) · [7](iterations/iteration-07.md) · [8](iterations/iteration-08.md) · [9](iterations/iteration-09.md) · [10](iterations/iteration-10.md) · [11](iterations/iteration-11.md) · [12](iterations/iteration-12.md) · [13](iterations/iteration-13.md) · [What is and isn't built](spec-coverage.md) · [Accessibility audit](accessibility.md) · Security: [threat model](security/threat-model.md)

## After Iteration 13

The planned iterations are done. What stands between this and a paying customer is mostly not code. In order:

1. **Run it for real once:** build the Docker images, deploy to a staging host with a real domain, real email, a real model key and Stripe in test mode, and walk the demo script end to end.
2. **Name it:** replace the placeholders in `src/config/brand.ts`, the logo and the icons.
3. **Legal:** terms, privacy notice, data processing agreement, and a decision on where data is hosted.
4. **An independent security test** before holding real resident data.
5. **A pilot** with one building, with screen-reader and phone testing by real users.

Then the product gaps, listed in [`spec-coverage.md`](spec-coverage.md).

Carried over (not built):

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
- **Rental listings and applications**, online rent payment, late fees, pro-rated rent, and a resident's view of their own lease.
- **Owner voting at general meetings**, proxies and meeting notices; the assistant drafting agendas and minutes.
- **Storage lockers**, product analytics events, and text-to-speech.
- **Distributed tracing**, and page-latency metrics from inside the app.
- **Malware scanning of uploads** (the hook exists; no scanner is connected).
