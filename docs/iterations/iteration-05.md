# Iteration 5 — Concierge, front desk and facility management

_Completed 2026-10-04_

## What was built

**Two vertical slices, end to end.**
1. **Guest pass:** a resident invites a guest from their phone and gets a QR pass with a link to send. The guest opens the link without an account and sees a pass showing only their first name and initial, the building and the time. The front desk scans the QR (camera, or a handheld scanner typing into the box), checks the details, checks the guest in and optionally assigns a free visitor parking space. The resident is notified that the guest has arrived. Checking the guest out ends the pass and the parking permit.
2. **Preventive maintenance:** an asset has a maintenance schedule. When the schedule's lead window opens, the background worker creates the work order and assigns the vendor or staff member. A breakdown work order can mark the equipment out of service, which starts a downtime record; finishing the job brings it back. The asset page shows recorded facts only: reactive requests, downtime hours, cost and PM history.

**Front desk console** (`/desk`; also the dashboard for the concierge and security roles):
- Pass scanner.
- Expected and on-site visitors, with check-in/out and "past their window" flags.
- Packages waiting, messages needing a reply, upcoming bookings, open incidents and my tasks.
- The current shift, with clock in/out, who's on now and the last handoff (with an acknowledge button).
- Parking status and a plate lookup.

**Visitors**
- Residents can invite guests for one visit or up to 14 days; staff can pre-register guests for up to 90 days.
- **Walk-ins** are checked in immediately.
- **Contractors** can be linked to a work order at the same property.
- **Turning someone away** records a reason and notifies the host.
- **Checking in outside the pass window** needs an override and a reason, which is audit-logged.
- **Passes are one-time links:** the token is shown once and only its hash is stored. "Get a new pass link" replaces it, and cancelling, checking out or denying entry kills it.
- **Visitor log:** expected today, on site, upcoming, past (with no-shows). Search covers name, company, unit and plate.

**Parking**
- **Spaces:** single or a numbered range, with kinds (resident, visitor, accessible, EV, loading…), unit assignment and out-of-service status.
- **Vehicles:** residents register their own (max 4 per unit). A plate can be active on only one record. Removing a vehicle revokes its permits.
- **Permits:** resident, visitor, contractor and staff, with start and end. The database prevents two live permits on one space.
- **Plate lookup:** shows registration, permits, visitors and past reports, as information for a person to act on.
- **Violations are always human-reviewed:**
  - Reports from staff and **camera detections** (with confidence, via `ingestDetection`) arrive as "to review".
  - A person confirms or dismisses them; nothing reaches a resident until then.
  - A confirmed report can become a **notice**, which notifies the residents of the matched unit. The resident sees the notice text only, never the evidence or who reported it.
  - Optional **second-person review**: the reporter can't confirm their own report.

**Shifts and handoffs**
- **Scheduling:** staff shifts, optionally repeated weekly, overnight-aware, with **on-call** periods.
- **On now and clock in/out:** a "who's on now" list and clocking in and out of your own shift.
- **Week view:** a grid by person with weekly hours.
- **On-call routing:** an emergency maintenance request that triage didn't assign goes to whoever is on call at that property, with a timeline note.
- **Handoffs:** notes plus an automatic snapshot of open items, limited to what the author can see. People on the next shift are notified, and someone other than the author acknowledges it.

**Assets and preventive maintenance**
- **Registry:** category, tag, make/model/serial, warranty, life, criticality, service vendor and replacement cost, with search and filters.
- **PM schedules:** every N days/weeks/months/years, opening work orders a set number of days ahead. Missed occurrences are skipped (no backlog), and a "Create now" button opens one on demand.
- **Status and downtime:** asset status and downtime history, plus files (manuals, warranty papers).
- **Facility dashboard:** out of service, PM due, PM overdue, downtime hours, and repeat failures (3+ reactive requests in 90 days).
- **Work order integration:** work orders can name the equipment and mark it out of service.

**Unified calendar:** scheduled work, inspections, PM due dates, bookings, visitors, shifts and task due dates, in day/week/month/agenda views with source and property filters. Each source applies its own visibility rule.

**Dashboards and navigation**
- **New navigation:** Front desk, Visitors (badge: expected today), Parking (badge: reports to review), Assets, Calendar and Shifts.
- **Dashboards:** staff dashboards gain front desk (visitors, parking) and facility sections. The resident home gains "Invite a guest" and "Your guests".
- **Command palette:** new quick actions for the front desk, parking, shifts and assets.

## Decisions and assumptions

- **Pass tokens** are 192-bit random values in the URL and are never stored. The public page reads one row through a dedicated row-level security policy, `visitor_pass`, and is rate-limited, `noindex` and `no-referrer`. It shows no unit number or host name, so a forwarded link reveals as little as possible.
- **Pass window:** valid from an hour before the start until the end. Outside it the desk can still decide, with a recorded reason.
- **Parking enforcement:** the system never issues a notice by itself and never "tows". A detection is a lead, not a finding. Second-person review is off by default and set in *Organization → General*.
- **On-call routing** assigns only when triage assigned nobody, and only to a role that can work maintenance requests. Managers are still notified of every emergency.
- **Front desk staff** (concierge, security) see the team schedule and write handoffs (`shift.read`) but can't schedule (`shift.manage`). Building-scoped staff also see property-wide shifts at their property.
- **PM dates** are calendar dates in the property's time zone. A missed occurrence opens one work order for the latest due date. Work orders are due at the end of the due date.
- **Storage lockers** are not built. They weren't needed for these slices, and they're tracked on the roadmap.

## Database changes

- **`0010_facility_frontdesk`:**
  - New tables: `visitors`, `parking_spaces`, `vehicles`, `parking_permits`, `parking_violations`, `shifts`, `shift_handoffs`, `assets`, `pm_schedules`, `asset_downtime`.
  - `work_orders.asset_id`.
  - Check constraints, unique keys (space code per property, active plate per org, permit/violation numbers, asset tag, one open downtime per asset) and org-leading indexes.
- **`0011_rls_facility`:**
  - Tenant RLS on all 10 tables.
  - The `visitor_pass` policy.
  - Exclusion constraints: no overlapping permits on a space, no overlapping shifts for a person.
  - Generated full-text search on assets.
- **Permissions:** `visitor.invite`, `parking.use` and `shift.read` (59 in total). Resident roles get invite and parking access; front-desk and maintenance roles get `shift.read`; managers keep `shift.manage`.
- **Seed:**
  - 6 extra staff members without logins.
  - ~170 shifts (front desk in three fixed blocks with the demo concierge on the current one, security nights, maintenance days, after-hours on call) and 3 handoffs.
  - ~90 visitors: a month of history, today's arrivals, on-site guests (one past their window) and upcoming guests for the demo resident and owner.
  - 223 parking spaces, ~115 vehicles and ~145 permits.
  - 8 violation reports covering every status, including a camera detection to review and a notice issued to the demo owner.
  - 27 assets with 18 PM schedules, a year of PM history, RTU-4's six reactive requests with downtime, the parkade gate's repeat failures, and Tower B car 2 currently down (linked to the elevator emergency).
  - One row per new table in the second tenant.

## Routes and server actions

**Pages under `/o/{org}/`:**
- `desk`
- `visitors`, `visitors/new`, `visitors/{id}`
- `parking` (reports, spaces, permits, vehicles), `parking/violations/new`, `parking/violations/{id}`, `parking/spaces/{id}`
- `shifts`, `shifts/handoff`
- `assets`, `assets/new`, `assets/{id}`
- `calendar`

**Public page:** `/pass/{token}`.

**Server actions** (`src/app/o/[orgSlug]/frontdesk-actions.ts`):
- Visitors: register visitor (returns the pass card once), regenerate pass, check in/out, turn away, cancel, scan pass.
- Parking: create space / range of spaces, update space, add/remove vehicle, issue/revoke permit, report/review/warn/resolve violation, plate lookup.
- Shifts: create shifts, cancel shift, clock in/out, write/acknowledge handoff.
- Assets: create/update asset, set status, create PM schedule, pause/resume, create now.

The work order form also takes `assetId` and `assetDown`.

**Worker:** preventive-maintenance generation was added to each tick.

## Tests

- **Unit: 125** (+23).
  - Plate normalisation and permit states.
  - Guest pass tokens and hashing, scanning (URL or text, junk rejected), and pass windows and overstays.
  - PM date math: month-end clamping, leap years, the lead window, and skipping missed occurrences.
  - Shift rules: length limits, overnight ends, "on now", clock-in window and weekly hours.
  - Role permission checks.
- **Integration: 296** (+58), including 29 in the new `frontdesk.test.ts`:
  - **Visitors:**
    - The pass shows only minimal details and stores only the hash.
    - Residents are limited to their own unit and can't check anyone in.
    - Scan → check-in → host notified → check-out kills the pass.
    - The window override is audited.
    - Visitor parking can't be double-assigned, even with a concurrent check-in, and is freed at check-out.
    - Reissuing and cancelling passes.
    - Desk and organization scoping.
    - The `visitor_pass` policy exposes exactly one row.
    - Walk-ins, contractor work order links, and denial.
  - **Parking:**
    - Vehicle uniqueness and the per-unit limit; revoking permits when a vehicle is removed.
    - Permit overlap, kind and out-of-service rules.
    - Scoped plate lookup.
    - Report → review → notice → resident sees only the notice; evidence stays private.
    - Second-person review.
    - Detections are labelled and never reach residents.
  - **Shifts:**
    - Scheduling rules (overlap, coverage, 16-hour limit, managers only, overnight).
    - Scoped schedules and own-shift clock-in.
    - **On-call emergency routing**, and no routing when nobody is on call.
    - Handoff snapshots limited by access, and acknowledgement rules.
  - **Assets:**
    - Scope and tag rules.
    - PM generation is idempotent and assigned; catch-up skips missed occurrences.
    - A breakdown work order runs down → downtime → completion → back in service.
    - Out-of-service alerts.
    - RTU-4 statistics come from real rows.
  - **Calendar:** resident and desk visibility.
  - **Tenant isolation** now covers all 10 new tables, including the "no org context" checks.
- **E2E: 33** Playwright runs (desktop + mobile, +6):
  - The whole guest pass journey: resident invites → guest opens the pass in a separate browser → desk pastes the link and checks in → resident notified.
  - A parking report reviewed by the manager before the owner sees the notice.
  - PM "Create now" and an outage with downtime history.
  - A handoff written by the desk and acknowledged by the manager.
  - The mobile resident inviting a guest and viewing their parking, with no horizontal scroll.

## Bugs found and fixed during the iteration

- **Wrong visitor-space counts:** Drizzle omits table names in single-table queries, so a correlated subquery compared a permit's space to the permit's own id. As a result the desk showed every visitor space as free and offered taken spaces at check-in. Subqueries now name the outer column explicitly. Found from a screenshot check of the desk console.
- **Building-scoped staff saw no schedule:** they couldn't see property-wide shifts or handoffs. Their schedule now includes their property's shifts.
- **Handoff page error:** it returned a 500 instead of a 404 when the permission was missing.
- **Seed failure at certain hours:** at some times of day the demo seed could give an on-site visitor a parking space a past visit still held, which the exclusion constraint correctly rejected. The seed now picks a free space.

## Known issues / limits

- **Lockers, cameras, calendar sync:** no storage lockers yet. No camera or licence-plate-recognition integration yet, only the `ingestDetection` entry point. No Google/Outlook sync.
- **QR scanning needs a supporting browser:** camera scanning uses `BarcodeDetector` (Chrome, Edge, Android). Elsewhere the desk uses a handheld scanner, pastes the link, or searches by name or unit.
- **No push notifications yet;** host arrival notices are in-app (email off by default).
- **Disappearing confirmations:** when an action removes its own form (confirming a report, issuing a notice, checking someone in), the confirmation message disappears with the form, so the page state shows the result instead. This was also noted in Iteration 3.
- **Dev worker after code changes:** in development the in-process worker keeps the code it started with across hot reloads. Restart `npm run dev` after changing worker jobs. Production is unaffected.
- **Docker untested here:** Docker isn't available in the build environment.
