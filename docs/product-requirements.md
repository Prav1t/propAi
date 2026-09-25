# Product Requirements

_Iteration 0 · owner: product/engineering · status: living document_

Product: **[YOUR PRODUCT NAME]** · AI assistant: **[YOUR AI ASSISTANT NAME]**

## 1. Goals

1. Run day-to-day building operations (maintenance, residents, front desk, facilities, governance) from one multi-tenant platform.
2. Make the AI assistant an **operations layer**, not a chatbot: it reads authorized data, plans, asks for approval, acts through typed tools, and logs everything.
3. Be credible to both a 40-unit strata council and a 5,000-unit property manager: transparent pricing, fast onboarding, enterprise-grade isolation and audit.

### Non-goals (for now)

- General ledger / trust accounting (integrate with QuickBooks/Xero instead).
- Rent pricing or revenue management (legal risk in the category).
- Native mobile apps (responsive PWA first).
- Legal advice of any kind. AI output on bylaws/leases is always grounded and labelled "not legal advice".

## 2. Personas

| Persona | Primary role key | Main device | Top jobs |
|---|---|---|---|
| Org admin (owner of the PM company account) | `org_admin` | Desktop | Set up org, invite staff, configure policies, billing |
| Property / portfolio manager | `property_manager`, `portfolio_manager` | Desktop | Triage requests, dispatch vendors, answer residents, report to owners |
| Building manager | `building_manager` | Desktop + phone | One building's ops, staff, vendors |
| Facility manager | `facility_manager` | Desktop + tablet | Assets, preventive maintenance, downtime, inspections |
| Maintenance staff | `maintenance_staff` | Phone | Work orders assigned to me, photos, completion |
| General staff | `staff` | Phone | Tasks, shift notes |
| Concierge / security | `concierge`, `security` | Front-desk desktop + phone | Packages, visitors, incidents, shift handoff |
| Vendor | `vendor` | Phone | Jobs assigned to my company only |
| Accountant | `accountant` | Desktop | Costs, invoices, exports (read-mostly) |
| Strata council member | `council_member` | Desktop + phone | Meetings, motions, bylaws, reports |
| Resident / tenant / owner / occupant | `resident`, `tenant`, `owner`, `occupant` | Phone | Requests, bookings, packages, messages, documents |
| Platform super admin (us) | `users.is_platform_admin` | Desktop | Orgs, plans, flags, health, support |

## 3. Core workflows (vertical slices, in priority order)

1. **Account → org → invite → role-scoped access** (Iteration 1). A user registers, verifies email, creates an organization, invites a property manager scoped to one property, who sees only that property.
2. **Maintenance request lifecycle** (Iteration 3). Resident submits with photo → manager notified → triage (category, priority, emergency per configured policy) → assign staff or vendor → vendor sees only their job → status updates notify resident → completion, resolution notes, cost → closed. SLA timers drive escalation.
3. **Amenity booking** (Iteration 4). Resident picks amenity/time → rules evaluated (window, duration, capacity, blackout, eligibility, deposit, approval) → confirmed or pending approval → notifications.
4. **Package handling** (Iteration 4–5). Concierge logs (scan/tracking, courier, photo) → resident notified in-app/email → pickup recorded with signature → aging report.
5. **Incident** (Iteration 3). Staff logs incident → timeline, evidence, people involved → notify authorized staff → resolution.
6. **AI read** (Iteration 6). "Show overdue maintenance across my properties" → permission-scoped tool query → real records with links.
7. **AI act with approval** (Iteration 7). "Send residents a message the pool is closed tomorrow" → draft → dry-run plan card → Approve / Edit / Cancel → sent through notification engine → audit + AI action log.
8. **Knowledge-grounded answer** (Iteration 8). "Party room rules?" → permission-aware retrieval over policy docs → answer with citations.

## 4. Functional requirements by module

The full list lives in the master brief; this section records **decisions** that sharpen it.

### 4.1 Identity & access
- Email is the login identifier, case-insensitive, unique platform-wide. One user can belong to many orgs.
- Passwords: min 10 chars, checked against a small common-password list, argon2id hashing.
- Email verification is required before an account can create an organization or be granted admin roles; accepting an invitation by emailed token verifies the email.
- MFA: TOTP (RFC 6238) with 10 single-use recovery codes. Orgs can require MFA for staff roles (Iteration 11).
- Sessions: opaque random token in an `HttpOnly; Secure; SameSite=Lax` cookie, only its SHA-256 hash stored. 30-day sliding expiry, revocable per device.
- Login history and new-device alerts by email.
- Account lockout via rate limiting (per IP and per email).

### 4.2 RBAC
- Roles are **records** (`roles` table) with a set of permission keys. System roles are seeded and immutable; custom org roles come later.
- A membership = (user, org, role) + zero or more **scopes** (portfolio / property / building). No scope = org-wide for staff roles.
- Resident-type roles are scoped through **unit occupancy**, not membership scopes.
- Every permission check happens server-side through one `authorize()` function. UI hiding is cosmetic only.

### 4.3 Tenancy
- Every tenant-owned row carries `org_id`. Postgres Row-Level Security enforces `org_id = current org` for the application database role, in addition to application-layer checks.
- Cross-tenant access attempts return 404 (not 403) to avoid confirming existence.

### 4.4 Maintenance (Iteration 3)
Statuses: `new → acknowledged → assigned → scheduled → in_progress → awaiting_vendor | awaiting_resident → completed → closed`, plus `cancelled`. Transitions are a state machine enforced server-side. Emergency classification comes from **configured rules** (keywords, categories, property policy), which the AI may suggest but never invent.

### 4.5 AI governance
Action classes 1–5 as in the brief. Default policy: class 1 auto; class 2 auto if org setting allows; class 3+ requires approval; class 5 always requires explicit typed confirmation. Policies are evaluated by the same policy engine that powers automations.

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Security | OWASP ASVS L2 as the target; see `architecture.md` §7 |
| Tenancy | Automated tests prove isolation at DB and service layers |
| Performance | Dashboard p95 < 500 ms server time on seeded demo; all lists paginated (default 25, max 100) |
| Availability | Stateless app containers; health endpoint; zero-downtime migrations (expand/contract) |
| Accessibility | WCAG 2.2 AA-conscious: labels, focus states, keyboard nav, contrast |
| Privacy | PIPEDA/GDPR-compatible mechanisms (export, deletion, retention). No compliance claims we can't substantiate |
| Observability | Structured JSON logs with request ID; audit logs; AI usage logs |
| Portability | Docker; any Postgres 16 with pgvector; S3-compatible storage |

## 6. Plans (config-driven; see Iteration 10)

| Plan | Target | Indicative dimensions |
|---|---|---|
| Starter | Single building / small strata | ≤ 1 property, ≤ 150 units, core modules, AI with monthly cap |
| Professional | Growing PM companies | Per-unit pricing, all ops modules, AI actions, API |
| Enterprise | Large portfolios | Custom, SSO, audit export, data residency, SLAs |

Prices are **not** decided here; they live in configuration.

## 7. Assumptions (documented, not blocking)

1. Primary market is Canada (BC first), so default timezone `America/Vancouver`, currency CAD, and privacy language references PIPEDA.
2. Product name and assistant name remain placeholders until replaced in `src/config/brand.ts`.
3. English only at launch; strings are kept in components but i18n-ready structure is Iteration 12.
4. Demo org is "Pacific Properties Management" with Harbour Centre, Pacific Heights, Fraser Towers, Kingsway Residences.
