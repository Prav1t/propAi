# Competitive Research

_Last updated: 2026-09-25 · Iteration 0_

This document records what we learned about Buildiveo and comparable products, and turns it into a product requirements matrix. It is research, not a copy target: we use publicly observable **capabilities** only. No Buildiveo branding, copy, code, or visual identity is reused.

## 1. Method and confidence

| Source type | How it was used | Confidence |
|---|---|---|
| Buildiveo public marketing pages (home, features, pricing, about, security, 6 solution pages, integrations) | Fetched and read 2026-09-25 | High that the claim is **made**; unknown whether it is **implemented** as described |
| Third-party comparison articles (Aug–Sep 2026) | Competitor pricing and AI features | Medium — secondary sources, verify before quoting to customers |
| General industry knowledge (Condo Control, MRI, Propertyware) | Filled gaps where no fetch was done this iteration | Low–medium — marked _(unverified)_ |

Not inspected: Buildiveo's logged-in app (`app.buildiveo.com`), App Store listings (none found via search), public API docs (none found), demo video content.

Marketing numbers like "50% faster work order completion" or "35% reduction in downtime" are **customer-outcome claims** and were not treated as product facts.

## 2. Buildiveo — what is publicly visible

**Positioning.** "Agentic AI" for end-to-end property and facility operations. Canadian company founded 2023; claims hundreds of properties, "36 integrated apps", 99.9% uptime, multi-property support added in 2025. The AI agent is branded "Bleo".

**Segments named:** property management companies, strata/HOA, facility management, rental operators, commercial buildings, student housing, senior living, mixed-use, security companies, concierge services.

**Pricing:** No public pricing. Quote-based ("custom pricing") on portfolio size, features, onboarding and integrations. No trial mentioned.

**Security claims:** TLS 1.3 in transit, AES-256 at rest, AWS hosting, MFA available for all accounts, activity history, daily backups with point-in-time recovery, geo-separated backups, "designed to help meet PIPEDA, GDPR". No SOC 2 / ISO 27001 claim found. No stated data residency.

**Integrations page:** generic ("accounting, access control, resident systems, vendor tools"). **No named integrations** on that page. The rental page names SingleKey and TransUnion for tenant screening.

### 2.1 Module inventory (as publicly listed)

| Area | Modules / features claimed |
|---|---|
| Communication | Announcements, direct messages (threaded), memorandums (formal notices with archive), forums, broadcasts, read receipts / acknowledgement tracking |
| Resident services | Service requests with SLA + assignment, complaints, packages (log + notify), parking (resident + visitor passes, daily access codes) |
| Facility ops | Amenity bookings, maintenance work orders, incidents, inspections (recurring, compliance follow-up, move-in/move-out), tasks, shifts (templates, handover notes) |
| Community | Surveys, documents, digital voting/polling |
| Governance (strata) | Meetings with attendance, agenda builder/templates, automated minutes, motions/voting records, action-item dashboard, bylaw enforcement (evidence, timeline, notices, escalation) |
| Rental | Vacancy view, public listings + syndication, online applications with fees, screening (SingleKey, TransUnion), lease templates with merge fields + e-signature, renewals/amendments, rent invoices, card payments + autopay, late fees, deposits, aging, owner statements |
| Vendors | RFQs, quotes, work orders, "trade logs", visit planning, trades visit calendar |
| Calendars | Trades visits, amenity bookings, building yearly planner, tasks, shifts |
| Admin | Unit profiles + resident assignments, user management with RBAC, staff role-based permissions by property |
| AI ("Bleo") | Routes maintenance requests to vendors, manages bookings with rule-based conflict resolution, package notifications, schedules inspections + pre-inspection tasks, "learns building policies", escalation, audit trails |

**Roles visible:** property manager, facility manager, resident / owner / tenant, vendor, concierge, security, inspector, strata council.

### 2.2 Observations and gaps we can exploit

1. **AI is claimed only on the homepage.** None of the six solution pages or the features page mentions AI. This suggests the agent is new or thin relative to the modules. → Our AI must be demonstrably real, auditable and visible in every workflow.
2. **No public pricing.** Small stratas and independent landlords can't self-serve. → Transparent, config-driven plans with a self-serve trial.
3. **No named integrations or public API docs.** → API-first, documented REST API and outgoing webhooks from early on.
4. **No explainability story** for AI decisions (why routed, what policy applied). → Dry-run plans, approval cards, cited policies, action logs visible to customers.
5. **No analytics depth visible** beyond "advanced analytics". → Property health score with visible contributing factors, vendor scorecards, anomaly surfacing grounded in data.
6. **Governance claims (AI minutes, bylaw enforcement)** carry legal risk. → Ground anything legal in uploaded documents; human review before notices of violation.

## 3. Comparable products

| Product | Focus | Pricing (public signal) | AI (as reported) | Notes |
|---|---|---|---|---|
| **Buildium** | SMB residential PM, accounting-first | Essential $62 / Growth $192 / Premium $400 per month + usage fees (per 2026-09 comparison article) | "Lumina" assistant, Premium only | No portfolio minimum |
| **AppFolio** | Mid/large residential | Quote-only in 2026, ~$280–298/mo minimum, ~50-unit floor, onboarding $400–5,000 (reported) | Realm-X assistant + Flows automation, higher tiers only | Strong accounting |
| **DoorLoop** | SMB landlords | Starter $69 / Pro $149 / Premium $209 per month, scaling with units; AI is a 15–25% add-on (reported) | AI add-on | Fees step down with tier |
| **Yardi** (Breeze / Voyager) | Everything, enterprise | Quote | "Virtuoso" agents: maintenance, invoicing, compliance; LLM connectors for live data | Heavy, complex |
| **Entrata** | Multifamily | Quote | "ELI" — leasing, maintenance triage, collections, renewals (acquired Colleen AI) | |
| **RealPage** | Enterprise multifamily | Quote | "Lumina" agentic workforce announced 2025 | Revenue-mgmt litigation risk in the category |
| **BuildingLink** | Condo/co-op front desk | Quote-only, no trial | Not a focus | 5,800+ communities; packages, key tracking (KeyLink), shift logs, amenities; reviews cite dated UI and mobile crashes |
| **Condo Control** _(unverified)_ | Canadian condo/strata, security & concierge | Quote | Limited | Amenity booking, packages, parking, e-voting; direct overlap with Buildiveo in Canada |
| **HappyCo, Property Meld, Lula** | Maintenance ops | Quote | AI intake/triage, technician matching | Point solutions for our most important workflow |
| **EliseAI, Funnel, BetterBot** | Leasing conversations | Quote | Conversational leasing agents | Adjacent; integration candidates, not core |

**Takeaways**

* Accounting-first incumbents (Buildium, AppFolio, Yardi) gate AI behind top tiers. Operations-first tools (BuildingLink, Condo Control) have little AI and dated UX. Buildiveo sits between, without public pricing.
* The space where nobody clearly leads: **operations + resident experience + governed agentic AI** that is transparent and cheap for small buildings.
* We should **not** compete on accounting / general ledger in the near term. Integrate with QuickBooks/Xero instead.
* Avoid rent-pricing / revenue-management features (active litigation and regulatory risk in the category).

## 4. Product requirements matrix

Legend: **V** = verified public claim (Buildiveo), **I** = strongly inferred, **B** = we should build because it makes the product better, **X** = needs third-party integration, **O** = optional / feature-flagged. Iteration = planned delivery (see `roadmap.md`).

| Capability | V | I | B | X | O | Iteration |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Multi-org tenancy, org → portfolio → property → building → floor → unit | V (multi-property) | I (portfolio) | B (portfolio + floor) | | | 1–2 |
| RBAC by property, module and record | V | | B (record-level, scoped roles) | | | 1 |
| Email/password, MFA | V (MFA) | | B (TOTP, recovery codes, login history, new-device alerts) | | | 1 |
| SSO (Google/Microsoft/Okta) | | | B | X | O | 11 |
| Audit trail | V | | B (before/after, AI flag, approval ref) | | | 1 |
| Units, residents, owners, tenants | V | | | | | 2 |
| Staff directory, vendors | V | | B (scorecards) | | | 2–3 |
| Maintenance / work orders with SLA | V | | B (AI triage, dup detection, policy routing) | | | 3, 7 |
| Vendor RFQ / quotes | V | | | | | 3 |
| Inspections, recurring, move-in/out | V | | B (checklist templates, follow-up tasks) | | | 3 |
| Incidents, complaints, bylaw escalation | V | | B (human review on enforcement) | | | 3 |
| Tasks with checklists & recurrence | V | | B (dependencies) | | | 3 |
| Amenities & bookings with rules | V | | B (policy engine shared with AI) | | | 4 |
| Packages with notifications | V | | B (barcode scan via camera) | | | 4–5 |
| Announcements, messages, memorandums | V | | B (templates with variables) | | | 4 |
| Documents | V | | B (versioning, permissions, RAG) | | | 4, 8 |
| Surveys, polls, digital voting | V | | | | | 4 / strata |
| Visitors & visitor parking passes | V | | B (QR invites) | X (access control) | | 5 |
| Parking permits, violations | V | | | | | 5 |
| Parking computer vision | | | B | X (vision model) | O | later |
| Shifts, handover notes | V | | B (AI handoff summary) | | | 5 |
| Assets, preventive maintenance, downtime | V (claimed) | | B (pattern detection) | | | 5 |
| Strata meetings, agendas, minutes, motions | V | | B (grounded AI drafts) | | | strata add-on |
| Rental: listings, applications, leases, rent | V | | | X (screening, payments, e-sign) | O | later |
| AI agent with tool registry | V (claimed) | | B (typed tools, dry-run, approvals, audit) | X (LLM provider) | | 6–7 |
| AI knowledge base / policies (RAG) | I ("learns policies") | | B (citations, permissions) | | | 8 |
| AI analytics grounded in data | | | B | | | 9 |
| Workflow automation builder | I | | B (WHEN/IF/THEN, approval step) | | | 9 |
| Property health score (explainable) | | | B | | | 9 |
| Daily brief, shift handoff, proactive insights | | | B | | | 9 |
| Global search + Cmd/Ctrl-K command bar | | | B | | | 2, 12 |
| Public REST API + webhooks | I ("API-ready") | | B (documented, versioned) | | | 10 |
| Transparent self-serve plans + trial | | | B | X (Stripe) | | 10 |
| Integrations: accounting, calendar, SMS, email | V (generic) | | | X | O | 10+ |
| Voice input | | | B | X (STT) | O | 12 |
| Privacy: export, deletion, retention | V (PIPEDA/GDPR language) | | B (self-serve export) | | | 11 |

## 5. Positioning statement (working)

> **[YOUR PRODUCT NAME]** is the operations platform for buildings where an AI assistant, **[YOUR AI ASSISTANT NAME]**, does the busywork — but shows its plan, cites its sources, and asks before it acts. Transparent pricing, a real API, and a UI your front desk can learn in an afternoon.

## Sources

- Buildiveo: https://buildiveo.com, /features, /pricing, /about, /security, /integrations, /solutions/{property-managers, facility-management, residents, rental-management, strata, concierge-security} — fetched 2026-09-25
- AppFolio vs Buildium pricing (aitoolsbakery.com, 2026-09-04): https://aitoolsbakery.com/blog/appfolio-vs-buildium/
- DoorLoop pricing (aitoolsbakery.com, updated 2026-09-11): https://aitoolsbakery.com/blog/doorloop-pricing/
- AI tools for multifamily operators (Travtus, 2026-08/09): https://www.travtus.com/resources/best-ai-tools-multifamily-operators
- BuildingLink review (Hoozzee): https://www.hoozzee.com/post/buildinglink-reviews-alternative
