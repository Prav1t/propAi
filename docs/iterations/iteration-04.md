# Iteration 4 — Community and resident experience

_Completed 2026-10-03_

## What was built

**Two vertical slices, end to end.**
1. **Amenity booking:** a resident books the party room from their phone. The booking rules check opening hours, slot steps, duration, notice, booking window, eligibility, capacity, closures and the per-unit limit, and the resident sees the fee and deposit. The booking waits for approval. A manager approves it with a note, the resident is notified, and the resident can cancel until the cut-off.
2. **Packages:** the concierge logs a package (scan or type the tracking number, and the carrier is detected). The resident is notified and sees a 6-digit pickup code. The desk releases the package against that code, optionally with an on-screen signature, and the resident is told it was picked up.

**Amenities and bookings**
- Amenities belong to a property, or to one building of it. Each has a kind, a description, a location and house rules.
- Booking rules are stored as columns: hours, slot length, min/max duration, notice, advance window, people per booking, bookings at once (exclusive or shared), per-unit limit per period, cancellation cut-off, approval, fee, deposit, and eligible roles (all residents, owners only, or owners and tenants).
- The **booking rules engine** (`amenities/rules.ts`) is pure and handles time zones and DST. It returns every problem at once, in plain language. Staff skip notice, the advance window, eligibility and limits, but never hours, closures or capacity.
- **No double-booking, even under a race.** The amenity row is locked while capacity is evaluated, and a Postgres exclusion constraint on `tstzrange` blocks overlapping live bookings of exclusive amenities.
- The day view is a timeline of existing bookings and closures. It opens on the first bookable day and only offers start times that can actually be booked.
- **Closures** (blackouts) report how many existing bookings they collide with.
- **Manager tools:**
  - Approve or decline (a decline needs a reason).
  - Cancel with a reason.
  - Record fee and deposit payment states by hand (paid/waived; held/refunded/withheld).
  - Report damage after an event, which opens a linked repair work order and can withhold the deposit.
- **Views:** a bookings list (upcoming, awaiting approval, past, cancelled) and a week calendar across amenities with lanes for overlaps, plus an agenda.
- **Units with the same number in two towers** (1204 in Tower A and B) are refused unless the building is chosen, rather than silently picking one.

**Packages**
- **Fast intake form:** building, unit, recipient, tracking with camera barcode scan where the browser supports it, carrier auto-detect, size, perishable, shelf, notes and photo.
- The recipient is matched to a unit occupant (or the primary resident).
- A random pickup code is shown only to the resident. Staff lists never show codes.
- **Release:** records who collected the package. For a single package the desk can check the pickup code (a wrong code is refused), and an on-screen signature can be captured for one package or several released together. Signatures are stored as private PNG files, and whether the code was verified or a signature taken is recorded in the audit log. Returns to sender are also supported.
- One automatic reminder after `PACKAGE_REMINDER_DAYS` (perishables after a day). Overdue packages (7+ days) are flagged.
- Residents get a home-screen banner with their codes.

**Announcements**
- **Targeting:** organization-wide, one property, or chosen buildings. The audience can be everyone, residents only or staff only.
- **Lifecycle:** categories, pinning, draft / schedule / publish now, expiry date, and optional notification of the audience.
- **Read receipts:** unread badges for readers and "read by N of M" for managers. The author's own view doesn't count.
- `{{property}}`, `{{org_name}}` and `{{today}}` are filled in at publish time.
- Scheduled posts are published by the worker.

**Messaging (resident ↔ management)**
- A resident starts a conversation (category and subject) with the people who handle their property.
- **Staff inbox views:** needs reply, open, assigned to me, unassigned, closed.
- **Working a thread:** assignment, closing and reopening (a resident reply reopens the thread), and internal notes the resident never receives (filtered on the server).
- Unread tracking per person.
- **Reply templates** with `{{resident_name}}`, `{{unit}}`, `{{building}}`, …. They are rendered for each thread and are always editable before sending. Unknown variables are rejected on save, and missing data is flagged on insert.
- Staff can start a conversation with any resident app user they manage.

**Documents**
- A library of categorised documents (bylaws, rules, notices, insurance, minutes, forms…). Each document is scoped to the organization, a property, a building or a unit, and has an audience: staff, residents, or owners only.
- **Important** documents appear on the resident home screen.
- **Versioning:** a new upload becomes current, and older files become staff-only, so residents always get the current version.
- Archive and restore, full-text search, and audited views and downloads.
- Uploads are checked by content: PDF, DOCX/XLSX/PPTX, TXT/CSV, JPEG/PNG.

**Resident app (mobile-first)**
- **Home screen:**
  - A packages banner with pickup codes and a new-reply banner.
  - Quick actions: report a problem, book an amenity, message management, building documents.
  - Announcements, open requests, upcoming bookings and important documents.
  - Building contacts: front desk / emergency phone, office hours and emergency information, which are new fields on properties.
- **Layout and navigation:** a bottom tab bar on phones, nav badges (unread messages and announcements, waiting packages, pending approvals), and resident-friendly labels ("Book amenities", "My packages").
- **Installable:** a web app manifest lets it be added to the home screen.

**Staff dashboard:** a "Front desk & community" section with packages waiting or overdue, bookings today and awaiting approval, and conversations that need a reply. The command palette has quick actions for the new modules.

**Storage:**
- `S3_SSE=none` (MinIO without a KMS).
- `S3_PUBLIC_ENDPOINT`, which signs download links for the host the browser can reach.
- An optional MinIO service in docker-compose (`--profile s3`).
- An S3 adapter test that runs against a real S3-compatible server.

## Decisions and assumptions

- **Booking rules** live as columns on the amenity rather than a separate rules table. They are typed, validated, and simple to edit, and closures are their own table. Per-unit limits count live bookings within the period on either side of the requested date.
- **Exclusive amenities** (`max_concurrent = 1`) are protected by the database. Shared amenities (gym, pool) allow up to `max_concurrent` overlapping bookings, checked under a row lock.
- **Fees and deposits** are recorded, not collected. Payment collection comes with the billing adapters (Iteration 10).
- **Bookings are always tied to a unit.** Staff booking on a resident's behalf pick the unit, and the building when the number is ambiguous.
- **Pickup codes** are 6 random digits. They aren't secret from the resident's household, and their purpose is to stop the wrong person collecting a parcel. Checking the code is optional, because desks also know their residents by sight; a signature is the alternative record when a resident has no code. A setting to require one or the other is a candidate for the AI policy work (Iteration 7).
- **Announcements** resolve their audience when they are published. Someone who moves in later still sees the post in the feed, but isn't notified.
- **Owner-only access** (documents, amenities) follows the occupancy relationship (`owner`), not a separate flag.
- **Messages go to the property team, not to a named person.** Assignment is optional, and everyone with `message.manage` on the property sees the thread. The Building Manager and Concierge roles gained `message.manage`, and the Building Manager role also gained `amenity.manage` and `document.manage`.
- **Template variables are a fixed list**, so a template can't reach data the sender couldn't see.

## Database changes

- `0008_community`:
  - New tables: `amenities`, `amenity_blackouts`, `bookings`, `packages`, `announcements`, `announcement_reads`, `message_threads`, `messages`, `message_reads`, `message_templates`, `documents`, `document_versions`, with check constraints, unique keys (booking number per org, version per document, read receipts) and org-leading indexes.
  - Properties gain `emergency_phone`, `emergency_info` and `office_hours`.
- `0009_rls_community`:
  - Tenant RLS policies on all 12 tables.
  - The `btree_gist` extension.
  - The `bookings_no_overlap` exclusion constraint.
  - A generated `tsvector` with a GIN index for document search.
- **Permissions:** new `message.manage` (56 in total). Role updates are listed above.
- **Seed:**
  - Property contacts, 8 amenities with closures and ~210 bookings without overlaps, 44 packages, 7 announcements, resident conversations with read state, 3 reply templates, and 10 documents with real PDF/text files.
  - A new demo owner, `owner@demo.test` (Tower A #805).
  - One row per community table in the second tenant, for isolation tests.

## Routes and server actions

**Pages under `/o/{org}/`:**
- `amenities`, `amenities/new`, `amenities/{id}` (day view, booking, edit, closures)
- `amenities/bookings`, `amenities/bookings/{id}`, `amenities/calendar`
- `packages`, `packages/{id}`
- `announcements`, `announcements/new`, `announcements/{id}`
- `messages`, `messages/new`, `messages/{id}`, `messages/templates`
- `documents`, `documents/new`, `documents/{id}`
- `/manifest.webmanifest`

**Server actions** (`src/app/o/[orgSlug]/community-actions.ts`):
- Amenities and bookings: create/update amenity, add/delete closure, create/decide/cancel booking, booking payment, booking damage.
- Packages: log, release (single/bulk), return.
- Announcements: create/update/archive.
- Messages: start thread, post message, update thread, create/delete template.
- Documents: create, add version, update, archive/restore.

Downloads still go through `GET /o/{org}/files/{id}`, which now also understands package and document files.

**Worker:** scheduled announcements and package reminders were added to each tick. `npm run worker -- --once` runs a single tick.

## Tests

- **Unit: 102** (+34).
  - Booking rules engine (hours, slots, DST days, 24:00 closing, notice/advance, eligibility, capacity, concurrency peaks, blackouts, limits, staff overrides, cancellation cut-off).
  - Carrier detection.
  - Template rendering (unknown/missing variables).
  - File sniffing (OOXML by package contents, text vs binary, disguised files).
  - Resident roles have no manage permissions.
- **Integration: 238** against real Postgres (+69), including 37 in the new `community.test.ts`:
  - Bookings: instant and approval flows, double-booking refused by both the service and the database, a concurrent race where exactly one wins, every rule, staff overrides, owner-only eligibility, shared concurrency, decisions/payments/cancellation cut-off/damage → work order, visibility, configuration scope.
  - Packages: intake → match → notify, scope, code privacy, code-checked release with a private signature, bulk release, disguised photos, one reminder.
  - Announcements: building targeting and variables, read tracking, scheduled publish → notify, audience/scope rules, expiry.
  - Messaging: notifications, internal-note privacy, cross-resident and cross-property privacy, close/reopen and badges, templates, who staff can message.
  - Documents: audience/place matching, content checks and versioning, archive and scope, cross-org files.
  - Tenant isolation now covers the 12 new tables, including the "no org context" checks.
  - The S3 adapter test (2 tests: put/presign/get/delete; public-endpoint signing) ran against a local S3-compatible server (moto), both with and without SSE. It is skipped unless `S3_TEST_ENDPOINT` is set.
- **E2E: 27** Playwright runs (desktop + mobile, +6):
  - Party room request → manager approval → resident notified → cancel.
  - Package logged → resident sees the code → a wrong code is refused → released with the right code → resident notified.
  - Resident message → concierge internal note and template reply → resident sees the reply but never the note.
  - Announcement targeted to Tower A seen by the Tower A owner but not the Tower B resident; owners-only bylaws hidden from the resident; a PDF download is served with the right type.
  - The mobile home screen with package banner and tab bar, and no horizontal scrolling.

## Bugs found and fixed during the iteration

- **Wrong unit for duplicate unit numbers:** staff booking for "1204" silently matched Tower A instead of Tower B. Ambiguous numbers now require a building.
- **Day view started at midnight of the wrong day on DST changes:** the end of day is now the next local midnight, not +24 h.
- **Unusable start times:** today's past or inside-the-notice start times were offered and then refused. The page now opens on the first bookable day, disables those times, and says when nothing is bookable.
- **Read counts:** the author's own view of an announcement counted as a read.
- **Phone layout:** the resident home scrolled sideways on phones because long announcement text widened the grid.
- **Message composer:** it gave no confirmation after sending or adding a note, because the form remounts on success. It now shows the result.
- **MinIO uploads:** S3 uploads always requested SSE-S3, which MinIO without a KMS rejects. This is now configurable.
- **Flaky E2E sign-out:** a sign-out click could land before hydration. The helper now retries opening the menu.

## Known issues / limits

- **No push notifications yet.** There is a manifest but no service worker or web push. Residents get in-app notifications and email.
- **Fees and deposits are tracked by hand.** No payment provider yet (Iteration 10).
- **Barcode scanning needs a supporting browser.** It uses the browser's `BarcodeDetector` (Chrome/Edge/Android). Elsewhere the field is typed or filled by a USB/Bluetooth scanner acting as a keyboard.
- **Docker untested here.** Docker isn't available in the build environment, so the compose file (including the new MinIO profile) and Dockerfile were updated but not executed. The S3 adapter itself was exercised against moto, not MinIO.
- **No booking calendar export** (iCal/Google) yet. A unified calendar comes in Iteration 5, and sync later.
- **No document previews.** DOCX/XLSX/PPTX are offered as downloads, and documents aren't indexed for AI retrieval yet (Iteration 8).
- **Announcements are resolved once**, at publish time, as noted in the decisions above.
- **Iteration 3 limits still apply:** emergency routing isn't shift-aware yet, malware scanning is a hook, and HEIC files aren't previewed.
