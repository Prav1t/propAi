# Iteration 2 — Property / portfolio core

_Completed 2026-09-25_

## What was built

- **Portfolios:** list with live property counts, create/edit/delete (org-wide roles), scoped portfolio managers edit their own.
- **Properties:** list with search (name, code, address), type and portfolio filters, pagination and real counts (buildings, units, occupancy, current residents); detail page with buildings, assigned staff, approved vendors; create/edit; delete with typed-code confirmation (org-wide roles only).
- **Buildings & floors:** create with optional floor scaffolding; **stacking plan** (units by floor, coloured by status); add/remove floors; bulk **generate units** (e.g. levels 1–15 × 5 → 101…1505, idempotent); edit/delete (blocked while residents live there).
- **Units:** searchable, filterable list (property, building, status, type); detail with current and past residents, move-out, edit, delete (blocked while occupied). Residents see a "My home" view limited to their own unit, with neighbours' contact details hidden.
- **Residents:** directory with search by name/email/phone, property/relationship/current-vs-moved-out filters; create with unit placement (by building + unit number), move-in/move-out history, unit status updated automatically, edit, delete; **invite to the resident app** (the login is linked to the resident record, so their unit access follows).
- **Staff directory:** role, coverage (portfolio/property/building), skills, employment type; filter by role, property or skill; people edit their own profile, admins edit anyone's.
- **Vendors:** directory with trade/status/property filters and insurance-expiry warnings; detail with contacts, property approvals, and vendor-portal users; create/edit/delete; **invite vendor users** who are linked to their company (`vendorId` on the principal, used for job visibility next iteration).
- **Search:** permission-aware global search across properties, buildings, units, residents, vendors and staff (Postgres full-text search), a results page, and a **Cmd/Ctrl-K command palette** with navigation, quick actions and live results.
- **UI building blocks:** schema-driven forms with server-side validation, URL-driven filter bar, pagination, two-step destructive confirmations, breadcrumbs, detail lists.

## Authorization decisions (documented assumptions)

- Scoped managers see and manage only residents with a **current** occupancy in their properties; residents without a unit are visible only to org-wide roles.
- Scoped managers must place new residents in a unit they manage.
- The vendor directory is organization-wide for reading. Org-wide roles manage every vendor; scoped managers create vendors only for one of their properties, and edit only vendors approved for a property they manage. Deleting vendors and properties is org-wide only.
- Moving a property between portfolios is an org-wide decision (or within a portfolio manager's own portfolios).
- Pages return 404 for both "doesn't exist" and "not allowed".

## Database changes

- `0003_portfolio_core`: `vendors`, `vendor_contacts`, `vendor_properties`, `staff_profiles`; `memberships.vendor_id`; `invitations.resident_id`, `invitations.vendor_id`; `residents.notes`.
- `0004_rls_search`: RLS on the four new tables; generated `tsvector` search columns + GIN indexes on properties, buildings, units, residents, vendors.

## APIs added

No public REST endpoints (Iteration 10). New server actions for every create/update/delete above plus `searchAction` for the palette — all re-resolve the principal from the session and go through the service layer.

## AI capabilities added

None (by plan). The permission-aware search service and scoped list services are what the AI read tools will call in Iteration 6.

## Tests

- Unit (54, +6): search-query sanitizer (operators stripped, accents, emails, phone digits), pagination maths.
- Integration (91, +30): property scoping and CRUD, portfolio moves, cross-org ids → not found, unique codes, building/floor/unit generation and uniqueness, stacking-plan occupant counts, building-scoped staff, unit list scoping, resident privacy on unit pages, move-in/out with unit status, resident scoping for PMs, resident-app invite → principal gets the unit, staff profile self-edit only, vendor management rules, vendor detail hides unseen properties, vendor user invite → `vendorId`, scoped and cross-tenant search, email/phone search, tsquery injection. Tenant-isolation suite extended to the 4 new tables.
- E2E (15, +5): admin builds a property → building → generated units → adds a resident → finds them via the palette; Ctrl+K navigation; PM scoping in lists; resident "My home" on desktop and mobile.

## Bugs found and fixed during the iteration

- **Correlated subqueries referenced the wrong `id`.** Drizzle renders `${table.id}` unqualified when the outer query has no join, so `where o.unit_id = "id"` silently matched the subquery's own `id`. This produced wrong occupant/vendor/floor counts and a 500 on the residents list. Fixed by qualifying the references; integration tests now assert those counts against direct SQL.
- **Zod 4 intersections** failed on transformed fields in the "add resident"/"add vendor" forms; switched to `.extend()`.
- **Command palette overlay** was clipped by the header's `backdrop-filter`; now rendered through a portal.

## Known issues / limitations

- Unit numbers containing dashes (e.g. `P1-01`) are only partially searchable via full-text search.
- The residents list sorts by last name only; no column sorting controls yet.
- No bulk import (CSV) for units/residents yet — planned alongside onboarding in Iteration 12.
- Carried over: in-memory rate limiter; Docker images not built in this environment; CSP allows inline scripts.
