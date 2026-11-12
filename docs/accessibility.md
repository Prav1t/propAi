# Accessibility

**Target:** WCAG 2.2 level AA.
**Automated checks:** axe-core with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` rule sets.
**Manual checks:** keyboard-only passes through the main flows.

Automated rules catch only part of what WCAG asks for. The parts that need people (screen-reader testing with NVDA, JAWS and VoiceOver; testing with disabled users; cognitive load) haven't been done yet and are listed under *Not covered* below.

## How the audit was run

1. **Build:** the production build (`next build` + `next start`), with the demo data.
2. **Coverage:** for every demo role, a script visits every route in `src/app` that the role can open.
   - A page that returns 404 to that role is skipped: the app answers 404 rather than 403 for records and pages outside someone's access.
   - Detail pages are checked with the first matching link found on the pages already visited, so each is a record that role can really open.
3. **Rules:** on each page, axe runs with the WCAG 2.2 A/AA rule sets once the network is idle.
4. **Views:**
   - every role on a desktop viewport (1280 × 900);
   - the resident, front desk, maintenance staff and property manager roles again on a phone (Pixel 7: 412 px wide, touch);
   - the most used pages of four roles in **dark mode**.
5. **Fixes:** pages with serious or critical findings were fixed, then audited again on a fresh production build.

The script is not part of the repository's test suite, because it takes about 30 minutes. The E2E suite keeps the pages each role uses most at zero serious or critical findings (`tests/e2e/a11y.spec.ts`).

## Results (Iteration 12, final build)

| Role | Desktop pages audited | Phone pages audited | Serious / critical left |
|---|---|---|---|
| Organization admin | 95 | – | 0 |
| Property manager | 83 | 83 | 0 |
| Front desk (concierge) | 49 | 49 | 0 |
| Facility manager | 57 | – | 0 |
| Maintenance staff | 33 | 33 | 0 |
| Strata council member | 29 | – | 0 |
| Vendor | 11 | – | 0 |
| Resident | 38 | 38 | 0 |
| Platform admin | 5 | – | 0 |

**Dark mode:** 45 pages were checked across the property manager, resident, admin and front desk roles, including the dashboards, lists, forms, settings, the assistant and search. There were no findings.

**Moderate and minor findings:** none on any audited page.

**Skipped pages:** the rest of the routes in each role's row were skipped, for one of two reasons:

- the role can't open them (404);
- no record was reachable from that role's lists. For example, the demo data has no custom role to edit, and a vendor has no inspection to open.

**Added in Iteration 13:** the public landing page (light, dark and phone, with every question expanded) and the new meetings and leases pages (list, new and detail; desktop, phone and dark) were audited the same way on the production build, with no findings. The landing page's building preview can be used by keyboard: each spot is a button with a name, the same choices are offered as a row of buttons, the plan's progress is announced, and motion stops under *reduce motion*.

## What the audit found, and the fixes

| Finding (axe rule) | Where | Fix |
|---|---|---|
| `link-in-text-block` (links told apart by colour only) | sign-in and register footers, the development mailbox link | Links in running text are underlined |
| `color-contrast` | disabled *Previous* / *Next* in pagination (dimmed with opacity) | Uses the faint text colour, which passes contrast, and `aria-disabled` |
| `scrollable-region-focusable` | code examples on the API reference; the weekly shift grid on phones | The scrolling area can be focused and is named (`tabIndex=0`, `role="region"`, `aria-label`) |
| `target-size` (WCAG 2.2: 24 × 24 px) | calendar navigation, view switch, day numbers, source filters; permission checkboxes in the role editor; recipient checkboxes in the rule builder | Minimum sizes and spacing; 44 px on touch screens |
| `scrollable-region-focusable` | the members table on phones | The table becomes cards on phones, like the other lists |

**Found by the audit, but not an accessibility issue:** a visitor's page returned an error when the guest's visit window had already ended, for example in the evening. The free-parking lookup built an invalid time range. It's fixed, with a regression test (`frontdesk.test.ts`).

## Keyboard and focus

- **Skip link:** *Skip to content* is the first stop on every page inside an organization.
- **Focus traps:** the command palette (Ctrl/Cmd-K), the phone navigation drawer and the shortcuts dialog keep focus inside while open, close on Escape, and return focus to what opened them.
- **Account menu:** follows the menu pattern (arrows, Home/End, Escape, Tab closes).
- **Shortcuts:** `?` lists them, `g` + a letter goes to a page, `c` starts a request, and `/` focuses the assistant's question box. They never fire while typing in a field.
- **Error pages:** the heading is focused, so screen readers announce what happened. The page also shows a reference number to quote to support.
- **Live regions:**
  - the checklist count and "Saving…";
  - saved and failed messages;
  - the assistant's answer status;
  - offline draft progress.
- **Forms:** fields have visible labels, and errors are tied to their fields (`aria-invalid`, `aria-describedby`).
- **Charts:** each chart has a table view and a text summary (Iteration 9).

Covered by E2E (`a11y.spec.ts`):

- the command palette and account menu by keyboard alone;
- the skip link;
- a resident reporting a problem without a mouse;
- the phone drawer's focus trap.

## Phones and touch

- **Touch targets:** buttons, fields, tabs, menu items, pagination and calendar controls are at least 44 px tall on touch screens (`pointer-coarse`).
- **Lists:** lists become labelled cards and nothing scrolls sideways (`mobile.spec.ts` checks six lists).
- **Navigation:** a bottom tab bar per kind of role; the full navigation stays in the drawer.

## Not covered yet

- Screen-reader passes with NVDA, JAWS and VoiceOver (iOS) and TalkBack (Android).
- Testing with disabled users.
- Windows High Contrast / forced-colours mode beyond the browser defaults.
- 200 % and 400 % zoom (reflow). The phone audit at 412 px covers much of the same layout, but zoom itself wasn't tested.
- Reduced-motion preferences: the app has little motion, but it hasn't been audited.
- PDFs and documents uploaded by organizations. Their accessibility depends on the files themselves.
