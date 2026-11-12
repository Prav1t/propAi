# What is and isn't built

A section-by-section check of the product against the original build brief, written at the end of Iteration 13. **Built** means it works on real data, is covered by automated tests, and is in the demo. **Partly** says what is missing. **Not built** means exactly that.

Use this before a sales conversation: it is the list of things you can show, and the list of things to say "not yet" to.

## Product areas

| Area (brief section) | Status | Notes |
|---|---|---|
| Portfolio hierarchy (4) | Built | Organization → portfolio → property → building → floor → unit, with assets, parking spaces and amenities. **Storage lockers are not a separate record** (a unit type can stand in) |
| Roles and permissions (5) | Built | 16 system roles, custom roles, scope by organization, portfolio, property and building, record-level rules for residents and vendors. Enforced on the server and by database row-level security |
| Sign-in (6) | Built | Email and password, verification, reset, sessions, two-step verification with recovery codes, invitations, deactivation, sign-in history with new-device alerts, single sign-on with OpenID Connect. SSO was not verified against live Google, Entra or Okta tenants |
| Resident experience (7) | Built | Requests with photos, complaints, incidents, bookings, packages, guests, parking, announcements, documents, messages, the assistant. **A resident can't see their own lease or rent** |
| Property management (8) | Built | Dashboards with KPIs computed from records |
| Maintenance (9) | Built | Full lifecycle, triage rules, SLAs, duplicates, vendors, costs, bulk changes, offline drafts |
| Vendors (10) | Partly | Records, contacts, categories, service areas, property approvals, SLA, scorecards, hourly rate, licence number and insurance expiry. **No contract records, and no document uploads on the vendor record** |
| Inspections (11) | Partly | Templates, recurring schedules, checklists, pass or fail with severity, photos, follow-up tasks. **No signature capture** |
| Amenities (12) | Partly | Calendars, rules, booking windows, approvals, blackouts, deposits and fees recorded. **Fees and deposits are not collected** |
| Packages (13) | Built | Log, notify, release with the recipient's name and signature, reminders, tracking-number scan where the browser supports it |
| Front desk (14) | Built | One screen for packages, visitors, incidents, parking, tasks and shift handoffs |
| Visitors (15) | Built | Pre-registration, QR passes, check-in and out, visitor parking. No access-control hardware integration |
| Parking (16) | Partly | Spaces, permits, vehicles, violations with evidence, a review queue for detections. **No camera or vision model is connected**: detections arrive only through `ingestDetection` |
| Incidents (17), complaints (18) | Built | Timelines, people involved, evidence, escalation, links between them |
| Tasks (19) | Built | Recurring, checklists, one blocking dependency per task, sources (inspection, incident, automation, meeting) |
| Staff and shifts (20) | Built | Profiles, skills, schedules, on call, clock-in, handoffs |
| Communication (21) | Partly | Announcements, messages, templates, email, in-app and push. **SMS is not a notification channel** (Twilio is connected for test messages and automation steps only) |
| Documents (22) | Built | Versions, categories, permissions, search, indexing for the assistant. **No OCR**: scanned PDFs aren't readable |
| Strata and HOA (23) | Partly | Built in Iteration 13: meetings, agendas, motions, council votes with thresholds, minutes that lock, action items. **Not built: owner voting at general meetings, proxies, meeting notices, and the assistant drafting agendas or minutes** |
| Rental (24) | Partly | Built in Iteration 13: leases, renewals, notice, move-out, monthly rent charges, recorded payments, overdue and ending-soon views. **Not built: listings, applications and applicants, online payment, late fees, pro-rated rent** |
| Facility management (25) | Built | Asset register, preventive schedules, downtime, cost per asset, repeat-failure insights |
| Calendar (26) | Partly | Day, week, month and agenda views across sources. **Meetings are not on the calendar yet. No Google or Outlook sync** |
| Notifications (27) | Built | Central engine, per-person preferences per kind and channel |
| Search (28) | Built | Permission-aware, full text, across the main record types. **Meetings and leases are not in global search** |

## The assistant

| Area | Status | Notes |
|---|---|---|
| Tool-based agent, no direct database access (29, 30) | Built | 44 typed tools; every call logged with user, organization, arguments, outcome, approval and correlation id |
| Action classes and approvals (31, 32) | Built | Five classes, organization policy, plan card with approve, edit and cancel |
| Specialised modes (33) | Built | Property, maintenance, front desk, facility, resident. No separate strata mode: the governance tools are in the property mode |
| Memory and context (34) | Partly | Conversation memory and organizational knowledge. **No per-user long-term memory beyond role and permissions** |
| Document answers with citations (35, 74) | Built | Permission-aware retrieval with pgvector and full text, cited answers, a knowledge-base screen |
| Model abstraction (36) | Built | Anthropic, OpenAI, OpenAI-compatible; a labelled demo mode without a key. **No Google provider** |
| Voice (37) | Partly | Voice input. **No spoken replies** |
| Analytics answers (38) | Built | Numbers come from a metric catalogue, never from the model |
| Custom policies (75), cost tracking (76) | Built | Per-organization policy, usage and cost dashboards, monthly caps |
| Model routing (77) | Partly | A provider abstraction and a setting for a cheaper model. **Requests are not routed between models** |
| Proactive insights (89), daily brief (90), shift handoff (91), message drafting with tones (92) | Built | All computed from recorded data |
| Evaluation (65) | Built | 36 scripted cases; they pass in demo mode. **They have not been run against a real model in this environment** |

## Platform

| Area | Status | Notes |
|---|---|---|
| Automation (39) and events (40) | Built | Rule builder with conditions, approval steps, schedules, a flow view, run logs; a transactional outbox |
| Database and multi-tenancy (41, 42) | Built | PostgreSQL, UUIDs, row-level security on every tenant table, isolation tests |
| Reports and analytics (47, 48) | Built | Ten reports with CSV export and print; charts from real data. PDF is the browser's print-to-PDF |
| Health score (88) | Built | Explainable, with each factor's data |
| Audit log (49) | Built | Hash-chained, with checkpoints |
| Security (50, 51) | Built | See `security/threat-model.md`. **Uploads are not malware-scanned** (the hook exists). **No independent penetration test** |
| Privacy (52) | Built | Export, erasure with legal holds, retention, consent records. No legal documents and no compliance claims |
| Billing (53) | Partly | Plans, trials, usage, invoices, upgrades and downgrades. **Stripe was tested with signed fixtures, not a live account** |
| Admin console (54) | Built | Organizations, subscriptions, flags, limits |
| Integrations (55) | Partly | Framework, Slack, Teams, Twilio, Stripe, email providers. **No calendar sync, QuickBooks, Xero, access control or accounting connectors** |
| REST API (56) and webhooks (57) | Built | Versioned, scoped keys, idempotency, OpenAPI; signed webhooks with retries. The `resident.created` event is not sent |
| Mobile (58) | Built | Installable web app, offline requests, push. No native apps |
| Command palette (87), shortcuts | Built | |
| Feature flags (78) | Built | |
| Product analytics events (79) | Not built | The audit log and assistant usage records exist; there is no separate product-analytics event stream |
| Observability (63) | Built | Logs with request ids, metrics, health probes, error tracking. No distributed tracing |
| Tests (64–66) | Built | 1,000+ unit and integration tests, 100+ end-to-end tests, isolation and security suites |
| Docker (68) | Partly | Dockerfile and two compose files written and validated. **Never built or run in the development environment** |
| Documentation (67, 69) | Built | README, architecture, AI architecture, schema, deployment, operations, observability, security, accessibility |

## What has never happened to this product

These are not gaps in the code. They are things only a real deployment can provide.

- It has not run in production, and no customer has used it.
- No real language model has been connected in the environment it was built in: every assistant test ran in demo mode.
- No email has been delivered through a real provider, no payment through Stripe, no push through a browser vendor, no SSO against a real identity provider.
- The Docker images have not been built.
- No independent security test, and no testing with screen-reader users.
- The pricing is a proposal, not something a customer has agreed to pay.
