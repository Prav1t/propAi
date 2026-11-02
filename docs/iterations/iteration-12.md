# Iteration 12 — UX and product polish

The goal was for the product to feel commercially credible on desktop and phones: every screen handles loading, empty and error states, the main flows work by keyboard and on a phone, and an accessibility audit finds no serious issues. The plan is in [`docs/roadmap.md`](../roadmap.md); the audit is in [`docs/accessibility.md`](../accessibility.md).

## What was built

**Accessibility:**

- **Audit:** every page each demo role can open was checked with axe (WCAG 2.2 A/AA rules) on the production build, on desktop and on a phone, with detail pages found by following links. The final results are below and in [`docs/accessibility.md`](../accessibility.md).
- **What the audit found and what changed:**
  - links that relied on colour alone (auth card footers, the development mailbox link) are underlined;
  - disabled pagination uses the faint text colour instead of opacity, and says it's disabled;
  - scrolling areas (the API reference's code examples, the weekly shift grid on phones) can be reached by keyboard and are named;
  - calendar controls, day numbers, event links and source filters, the role editor's permission checkboxes and the rule builder's recipient checkboxes meet the 24 px target-size rule;
  - the members table becomes cards on phones.
- **Focus and keyboard:**
  - a shared focus trap (`lib/use-focus-trap.ts`) keeps focus inside the command palette, the phone navigation drawer and the shortcuts dialog, and returns it to whatever opened them;
  - the account menu follows the menu keyboard pattern (arrows, Home/End, Escape);
  - links that are loading show it (`useLinkStatus`).
- **E2E coverage:** `a11y.spec.ts` keeps the pages each role uses most at zero serious or critical violations. It also covers keyboard-only passes (the command palette, the account menu, the skip link, a resident reporting a problem) and the phone drawer.

**Loading, empty and error states:**

- **Skeletons** (`components/ui/skeleton.tsx`) for slow sections.
- **Streaming dashboard:** the frame renders first and each section (attention, operations, community, facility, my work, portfolio) streams on its own. The sections are ordered by role: facility managers see facility first, staff see their own work first.
- **Section failures:** a failing section shows a small fallback with a retry, and the rest of the page still renders (`SectionBoundary`, built on `catchError`).
- **Error pages** for the org area, the root and `global-error`. Each shows what happened, **Try again**, and a **reference** that matches the server's log line, so support can find it.
- **Not-found pages** keep a real 404 status (sections are placed after the authorization checks, not under a `loading.tsx`) and offer a way back.
- **Empty states** say what to do next, and say when filters are hiding results.
- **Optimistic updates:** ticking checklist items (with "Saving…" and a leave-page warning until it's saved) and *Mark all read*.
- **Logging:** each failed request is logged once with its reference; a browser that disconnects mid-page is logged at debug level, not as an error.

**Phones:**

- **A bottom tab bar per kind of role** (resident, front desk, maintenance staff, facility, vendor, manager). It only shows places the person can open, with badges for unread messages, packages and visitors on site.
- **Touch targets** of at least 44 px for buttons, fields, tabs, menus and pagination on touch screens (`pointer-coarse`).
- **Lists become cards** on narrow screens. Each value carries its column label, and nothing scrolls sideways. This applies to work orders, tasks, inspections, incidents, complaints, packages, visitors, residents, staff, vendors, units, assets and bookings.
- **Photos:** a camera button on touch screens. Several shots add up instead of replacing each other, thumbnails show what will be sent, and each can be removed (`components/ui/photo-picker.tsx`).

**Installable app and offline:**

- **Install:** a manifest with PNG and maskable icons, and a service worker with an offline page. The worker caches only content-hashed static files and the offline page, never pages or data.
- **Offline drafts:** a maintenance request written without a connection is kept on the device, with its photos. A banner says it's waiting, and it's sent automatically when the connection returns. Each draft goes through the same validation and permissions as the form, and is created exactly once, even if the draft is sent twice. Drafts are deleted on sign-out.
- **Web push:**
  - turned on per device under *Notifications → Settings*, with VAPID keys from `npm run push:keys`;
  - payloads are encrypted and VAPID-signed, and delivered only to the browser vendors' push services through the SSRF-safe client;
  - each kind of notification can use push or not;
  - consent is recorded, devices are listed and can be removed, and gone subscriptions are cleaned up;
  - clicking a notification opens the page in the app.

**Assistant:**

- **Voice input:**
  - with a speech-to-text provider (any Whisper-compatible endpoint, configured behind the model abstraction), the recording is sent through the app and counts as one assistant request;
  - without one, the browser's speech recognition is used where it exists;
  - the words go into the question box, and nothing is sent until the person presses Send.
- **Suggested follow-ups** chosen from the tools the answer used. Every suggestion is one the demo model can answer, and questions already asked aren't repeated.
- **The plan card shows what was edited:** *You changed* with the old value struck through and the new one.
- **Keyboard:** `/` focuses the question box.

**Navigation and lists:**

- **Saved views:** named filter sets per list, private to each person.
- **Bulk changes on work orders:** assign, set priority, acknowledge new ones, or close completed ones. Each item gets its own permission check, state-machine rule, audit entry and timeline line, and the ones that can't change are listed with the reason.
- **Recently opened records** come first in Cmd/Ctrl-K. Records the person can no longer open are left out.
- **Keyboard shortcuts:** `?` lists them, `g` + a letter goes to a page, `c` starts a request, and `/` focuses the assistant's question box. They never fire while typing.
- **Breadcrumbs** now also on the deep pages that lacked them: automation rules, rule editing and runs, the health score details, and the role editor (detail pages already had them).

**Automation:** a visual **WHEN → IF → THEN flow view** of each rule, next to the sentence summary. Steps behind an approval step are marked *after approval*.

**Administration:**

- **Custom role editor** (*Settings → Roles*): start from an existing role, pick permissions by module, and choose where it applies.
  - **What it enforces:** the F-03 rules (you can't give a permission you don't have, and property-scoped editors define only property-scoped roles); a role's scope is fixed while people hold it, and it can't be deleted until they move.
  - **Safeguards:** every change needs a recent sign-in and is audited.
- **Signed-in members** (*Settings → Security*): everyone with an active session, each device, how they signed in and when they were last active.
  - **Sign out everywhere** ends a member's sessions.
  - For people who also use other organizations, only the sessions started through this organization's SSO end.

## Files created/modified

- **States and errors:** `src/components/ui/{skeleton,error-view}.tsx`, `src/app/{error,global-error,not-found}.tsx`, `src/app/o/[orgSlug]/{error,not-found}.tsx`, `src/instrumentation.ts`, `src/server/{request-error,dev-faults}.ts`, `src/app/o/[orgSlug]/dashboard/{page,sections}.tsx`
- **Accessibility and phones:**
  - shared: `src/lib/use-focus-trap.ts`, `src/components/shell/{sidebar,command-palette,user-menu,bottom-tabs}.tsx`, `src/components/ui/{primitives,form,button,tabs,pagination,photo-picker}.tsx`, `src/app/globals.css` (`.table-cards`)
  - list and detail pages across the org area, including the calendar, shifts, members, role editor and rule builder fixes from the audit
- **Fixes:** `src/server/modules/parking/service.ts` (`visitorPermitUntil`), `src/components/ops/checklist.tsx`, `src/app/o/[orgSlug]/assistant/stream/route.ts`
- **Offline and push:**
  - app files: `public/{sw.js,offline.html,icon-*.png}`, `src/app/manifest.ts`, `src/components/shell/{service-worker,draft-sync}.tsx`, `src/lib/drafts.ts`
  - server: `src/server/push/service.ts`, `src/components/ops/push-settings.tsx`, notification delivery and preferences
  - scripts: `scripts/make-icons.mjs`
- **Assistant:** `src/components/ai/{voice-input,assistant-chat,plan-card}.tsx`, `src/server/ai/transcribe.ts`, `src/app/o/[orgSlug]/assistant/transcribe/route.ts`, `src/lib/assistant-followups.ts`
- **Navigation:** `src/lib/views.ts`, `src/server/modules/views/service.ts`, `src/app/o/[orgSlug]/view-actions.ts`, `src/components/ui/saved-views.tsx`, `src/server/modules/maintenance/bulk.ts`, `src/components/ops/{bulk-bar,checklist,notification-list}.tsx`, `src/components/shell/keyboard-shortcuts.tsx`
- **Automation:** `src/components/automation/flow-view.tsx`, `src/lib/automation.ts` (`steps`)
- **Administration:** `src/server/modules/members/{roles,sessions}.ts`, `src/app/o/[orgSlug]/settings/roles/**`, `src/components/settings/role-form.tsx`, `src/app/o/[orgSlug]/settings/security/*`, `src/lib/device.ts`
- **Database:** `drizzle/0025_iteration12_views_push.sql` (generated), `drizzle/0026_rls_iteration12.sql`
- **Tests:**
  - integration: `tests/integration/{ux,admin-ux}.test.ts`;
  - E2E: `tests/e2e/{ux,a11y,workflow-ux,pwa,mobile}.spec.ts`;
  - unit: `src/server/request-error.test.ts`, `src/lib/{device,assistant-followups}.test.ts`;
  - changed: `tests/integration/{tenant-isolation,billing,frontdesk}.test.ts`, `tests/e2e/assistant-actions.spec.ts`, `src/lib/time.test.ts`.
- **Docs:** `docs/accessibility.md`, README, `.env.example`, architecture, AI architecture, database schema, roadmap

## Database changes

- **Migration `0025`:**
  - new tables `saved_views`, `recent_views` and `push_subscriptions`;
  - new columns `work_orders.client_ref` (with the partial unique index `work_orders_client_ref_uq` on organization, submitter and reference) and `notification_preferences.push`;
  - `consents.channel` now accepts `push`.
- **Migration `0026`:** row-level security on the three new tables. People reach only their own rows; the system context reaches rows within one organization for push delivery, privacy export and erasure, and retention.
- **No change for custom roles:** they use the existing `roles` table.

## APIs added

- **Route:** `POST /o/{org}/assistant/transcribe` turns a recording into text.
  - **Input:** multipart, audio only, up to 10 MB (the browser stops recording after a minute).
  - **Access:** the person needs `ai.use`, the assistant must be on with the `voice_input` flag, and the plan and monthly caps apply; there's a per-person rate limit.
- **App files:** `/manifest.webmanifest`, `/sw.js`, `/offline.html`, and the icons.
- **Server actions:**
  - saved views (save, delete);
  - bulk work order changes;
  - sending an offline draft;
  - push subscribe and unsubscribe;
  - checklist ticks and *Mark all read*;
  - custom roles (create, update, delete);
  - signing a member out.
- **Permission:** `role.manage` (org admins).
- **CSP:** `worker-src 'self'`.
- **REST API:** unchanged.

## AI capabilities added

- **Voice input** behind the model abstraction:
  - **Providers:** any OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI, or a self-hosted Whisper server). It's picked up from `AI_PROVIDER=openai` / `openai-compatible`, or set separately with `AI_TRANSCRIBE_*`. Without one, the browser's speech recognition is used.
  - **Limits and records:** transcriptions use the same switches, caps and usage records as typed questions.
- **Suggested follow-ups** from the tools used. A unit test checks that every suggestion routes to a tool in demo mode.
- **The plan card's edit diff:** *You changed* shows the old value struck through next to the new one.
- **Unchanged:** no new tools and no change to the policy engine.

## Tests added

- **Unit:**
  - `request-error` (5): error fields and references, client disconnects told apart from errors, one log line per request;
  - `device` (2): device names from user agents;
  - `assistant-followups` (5): chosen from tools, no repeats, resident and staff sets, every suggestion routes to a tool;
  - `time` (+2): `fmtDay` without time-zone shifts and outside the current year.
- **Integration:**
  - `ux.test.ts` (21):
    - saved views: sanitizing, privacy between people, limits;
    - recent records: ordering, the last 20, permission filtering, erased records;
    - bulk changes: each item checked and audited, assignment reach, refusals;
    - offline draft idempotency: twice, concurrently, and per person;
    - push: the endpoint allowlist, encrypted VAPID delivery to a local receiver that decrypts it, per-kind choices, gone subscriptions, consent, device ownership, malformed keys;
    - privacy export and erasure of the new data.
  - `admin-ux.test.ts` (10):
    - custom roles: exact permissions, the F-03 limits, refusals, scope fixed while held, delete blocked;
    - member sessions: listing, sign-out everywhere, SSO-only sign-out for people in several organizations, permission and self-protection;
    - transcription with a mock speech-to-text server: provider selection, usage counting, refusals.
  - `tenant-isolation`: the three new tables in the cross-organization sweep.
  - `frontdesk` (+1): a guest arriving after their window gets the visitor page, free spaces and a two-hour permit.
  - `billing`: usage days compared as UTC days.
- **E2E:**
  - `ux.spec.ts` (5): error page with reference and retry, one failing dashboard section, real 404s, the optimistic checklist, *Mark all read*;
  - `a11y.spec.ts` (13): axe on each role's main pages, detail pages and signed-out pages; keyboard-only flows; the phone drawer and resident pages on a phone;
  - `workflow-ux.spec.ts` (8): saved views, bulk priority with each request's history, palette recents, shortcuts, the rule flow view, custom role create/edit/delete with the audit entry, signed-in members, assistant follow-ups and `/`;
  - `pwa.spec.ts` (4): manifest, icons and worker; the offline page; an offline draft sent once when back online; push settings following the browser's permission state;
  - `mobile.spec.ts` (5, Pixel 7): front desk and maintenance tab bars, list cards with nothing scrolling sideways, 44 px targets, adding and removing photos;
  - `assistant-actions.spec.ts`: the plan card's edit diff.

## Test results

All of these ran on the final code in this commit.

| Check | Result |
| --- | --- |
| Type check (`tsc --noEmit`) | clean |
| Lint | clean |
| Vitest (unit + integration + security) | **64 files, 992 tests passed**: unit 362 (+14), integration 630 (+37) |
| Assistant evaluation (`npm run ai:eval`) | 32/32 |
| Secret scan (`npm run security:secrets`) | no secrets in the 629 files of this commit |
| Dependency gate (`npm run security:audit`, high or above, production deps) | passes, with **0** advisories in production dependencies (the 3 moderate mammoth advisories from Iteration 11 are gone) |
| Production build | OK |
| E2E (Playwright, 15 batches on a freshly reset database) | **104 passed, 0 failed, 0 flaky** in 37.7 minutes: analytics + automation 7, assistant 6, assistant actions 8, auth 4, authorization 6, billing 3, community 6, front desk 6, knowledge 6, maintenance 6, portfolio 5, security 6, UX + accessibility 18, workflow UX 8, PWA + phone 9. The 7 skips are phone-only tests in the desktop project, which run in the phone project |
| Accessibility audit (axe, WCAG 2.2 A/AA, production build) | every page each of 9 roles can open on desktop, 4 roles on a phone, and 45 pages in dark mode: **0 serious or critical** after the fixes (see [`docs/accessibility.md`](../accessibility.md)). The pages with findings were audited again after the fixes |

An earlier full run had 2 failures, both in tests rather than the app:

- the Iteration 9 automation test expected the rule builder's sentence, which is now behind *Show as a sentence* (the flow is the default);
- a shortcut test pressed keys before the page had hydrated.

Both tests were fixed, and the whole suite above was rerun from a fresh database.

**Production smoke test** (`next start` on port 3100):

- `/sw.js` is served as JavaScript; `/offline.html` and `/manifest.webmanifest` return 200;
- the CSP includes `worker-src 'self'`, and the offline page has no scripts, so it works under the CSP;
- the visitor page that failed in the audit returns 200 after the fix.

**Not tested:**

- push delivery through the real push services (Google, Mozilla, Microsoft, Apple);
- speech-to-text against a real provider (a mock Whisper-compatible server is used);
- installing the app on a real phone (iOS / Android);
- screen readers.

## Bugs found and fixed during the iteration

- **Visitor pages could fail once a guest's window had passed:** the free-parking lookup built a time range from now to the end of the visit, which is invalid after the visit ends (found by the audit in the evening). It now uses the same window check-in gives the permit: the rest of the visit, or two hours. There's a regression test that fails without the fix. This was a bug since Iteration 5.
- **A quick tick-and-leave on a checklist could be lost:** the tick showed at once, but leaving before the server answered dropped it. The checklist now says "Saving…" and asks before leaving until the save is done (found by the E2E test).
- **Leaving the assistant mid-answer was logged as an error:** writing to a stream the browser had closed logged `ai.stream_failed`. It's now logged at debug level as `ai.stream_aborted`; real failures are still errors.
- **The usage metering test failed in the evening west of UTC:** usage days are UTC days, and the test compared them with the database's local date. The test now uses the UTC date.

## Known issues

- **Push** was tested end to end against a local receiver that decrypts the payload, not against the real push services (Google, Mozilla, Microsoft, Apple), which this environment can't reach. Headless Chromium reports notifications as blocked, so the E2E test checks the page's blocked-state message; the *Turn on* button is covered only when a browser allows notifications.
- **Speech-to-text** was tested with a mock Whisper-compatible server. Browser speech recognition (Chrome, Edge, Safari) sends audio to the browser vendor; this is stated in `.env.example` and the README.
- **Offline:** only maintenance requests can be written offline. Inspection evidence offline (planned) isn't done. The worker doesn't cache pages, so with no connection, opening a page that isn't already open shows the offline page; drafts stay on the device and are sent when the connection returns.
- **Analytics** isn't streamed section by section like the dashboard.
- **Bulk changes** exist for work orders only (packages were planned too).
- **Saved views** save filters, not column choices.
- **E2E batching:** the full E2E suite still needs batching on machines with about 6 GB of memory (`npm run test:e2e:batched`).
- **Dev-only advisories:** 20 moderate advisories remain in development tools (esbuild under drizzle-kit, minimatch under ESLint). The only offered fixes are breaking downgrades. Production dependencies have none.

## Next iteration

Iteration 13 — production readiness:

- a production Docker build and a migrations runbook;
- backups and restore drills;
- structured logging and metrics with dashboards and alerts;
- health checks;
- error handling review;
- deployment documentation;
- security configuration;
- running Docker Compose on a machine with Docker.
