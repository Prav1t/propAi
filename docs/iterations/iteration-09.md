# Iteration 9 — Analytics and automation

_Completed 2026-10-15_

## What was built

**The vertical slice:** an admin starts from the *Elevator emergencies* template, scopes it to Fraser Towers and presses **Run test**, which shows what the rule would have done for a recent request without changing anything. They turn it on.
1. A resident reports "Elevator stuck with doors shut" as an emergency.
2. The rule runs as its owner. It raises the request to urgent (or notes it already is), notifies the property managers and the technician on call, and creates a "Confirm nobody is trapped" task for the on-call technician, due in an hour.
3. It then pauses. Marcus Chen, the property manager for Fraser Towers, finds it under *Automations → Waiting for approval* with every step's outcome, adds a note and approves.
4. The remaining step runs: only now is the resident told "A technician is on the way for WO-…".
5. The run log shows each step, who approved and their note. The audit log ties every change to the run, and the *Analytics* page counts the run.

**Metrics and analytics** (`src/server/analytics/*`)
- **A catalog of 24 metrics**, each one SQL over recorded rows: requests created/completed, emergencies, first-response and resolution hours, SLA and response compliance, maintenance spend, open backlog, overdue now, backlog age, complaints and complaint resolution time, incidents and serious incidents, inspections completed and failure rate, downtime hours, amenity bookings and booked hours, packages received and pickup time, tasks completed, open tasks.
- Every metric is restricted to the reader's visible properties and permissions **before** it is computed; RLS still pins the organization.
- **Periods** are whole local days in the organization's time zone (presets or custom dates, DST-safe), compared with the same number of days before (or the same span of last quarter), with the change coloured by whether up is good for that metric.
- **The Analytics page** (`analytics.read`) has:
  - filters for period, property and building;
  - metric tiles that link to the records behind them;
  - a created-vs-completed trend chart (accessible SVG with a *Show as table* view and a screen-reader caption);
  - breakdowns by category, vendor and property;
  - a vendor scorecard;
  - property health;
  - automation activity.
- **10 reports:**
  - maintenance requests (row-level, with SLA outcome)
  - SLA by property
  - vendor scorecard
  - complaints
  - incidents
  - inspections
  - amenity utilisation
  - packages
  - staff workload
  - property health

  Each report has **CSV export** (RFC 4180, BOM, formula-injection guard, audited as `report.exported`) and a print layout.
- **The dashboard's 30-day performance tiles** now use the same definitions, so the dashboard and analytics can't disagree. The first-response figure on the dashboard previously used a different definition; it now matches.

**Property health score** (`health.ts`, `/analytics/health/{property}`)
- **Eight factors:** resolved within SLA, responded within SLA, overdue share, open backlog per 100 units, complaints per 100 units, serious incidents, inspection failure rate, equipment availability.
- Each factor is scored 0–100 by a fixed, documented rule. Factors are combined with weights the organization sets; factors without data are left out and the rest re-weighted.
- The page shows each factor's raw value, score, weight, points contributed and a link to the records. Grades: Healthy ≥ 80, Watch ≥ 60, Needs attention.

**Insights and the daily brief**
- **Insights** compare recorded data and link to the rows behind them:
  - requests close to their target;
  - a category spiking in one building against its 4-week average;
  - vendors missing SLA targets;
  - inspection failures rising;
  - booking volume change;
  - equipment with repeated repairs.
- **Daily operations brief** (`/brief`, and the assistant's `daily_brief` tool) covers:
  - new and overdue requests;
  - today's incidents;
  - inspections;
  - scheduled vendor visits;
  - bookings;
  - packages;
  - approvals waiting;
  - insights.

  The worker builds it per manager, with their own access, at the organization's brief time. It is stored once per person per day and delivered in-app and by email.

**SLA "due soon"**
- Open requests whose resolution target is within the organization's lead time (default 2 hours) are warned **once**. The assignee and the property's managers are notified, and rules can react to the `workorder.sla_approaching` trigger.
- Changing the target resets the warning. *Maintenance → Due soon* lists them.

**Automation engine** (`src/server/automation/*`, catalog in `src/lib/automation.ts`)
- **Triggers:** request created / status changed / assigned / due soon / past SLA, complaint created, incident created, inspection failed, booking created, package arrived, document uploaded, or a **schedule** (daily, weekdays, weekly, monthly at a local time).
- **Conditions** are typed per trigger; all of them must hold. They cover emergency, category, priority, status, building, unassigned, source, text contains, failed items, severity, type, amenity, perishable, carrier and more.
- **Actions:**
  - set priority;
  - change status (never to completed or cancelled);
  - assign (staff, approved vendor, or whoever is on call);
  - escalate;
  - notify (roles at the property, named staff, on call, the submitter, the assignee);
  - create a task;
  - draft an announcement (a person publishes it);
  - **ask for approval** (a role);
  - **assistant draft** (an internal note);
  - send a report.
- **Validation:** the rule schema rejects anything that couldn't run as written. On save, references (buildings in the property, staff members, approved vendors, staff roles) are checked.
- **Runs:** events are consumed from the outbox. Claiming an event and creating its runs happen in one transaction, and runs are unique per event and per scheduled slot, so there are no duplicates. Each run executes **as the rule's owner**, re-authorized every time, through the same services as the UI. A failure stops the run with a clear message, and the run log keeps every step's outcome and links. Audit entries carry `workflow_run_id`.
- **Loop protection:**
  - a rule never fires on events its own actions raised;
  - chains stop at depth 3;
  - more than 100 runs in an hour pauses the rule, with the reason shown;
  - runs interrupted by a restart are closed honestly after 15 minutes.
- **Approvals:**
  - Only people holding the named role *at that property* can decide.
  - Approve → the rest runs immediately; decline → it's skipped.
  - Other automation managers are told who decides; anyone else gets a 404.
  - Decisions are audited with the note.
- **Who:** `automation.manage` (organization admins, portfolio and property managers). Scoped managers make rules for their properties only. Organization-wide rules are read-only to them, and saving or enabling a rule makes the saver its owner.
- **Builder:** 7 templates, WHEN → IF → THEN cards, a plain-language sentence for the whole rule, **Run test** against a recent real event (or "now" for schedules), enable/disable, run history.
- **Delivery:** after any change (forms and the assistant), notifications, automation (to the chain limit) and indexing run right after the response; the worker tick covers everything else.

**Assistant**
- **Four analytics tools:** `query_metrics`, `compare_periods`, `property_health`, `daily_brief`. They answer from the same metric definitions, and every result states its exact dates.
- **A prompt rule** sends counting/averaging/ranking questions to these tools and forbids estimating.
- **Demo mode** routes numeric questions and "morning briefing" to them.
- **4 new eval cases** (32 in total).

**Settings**
- *Settings → Analytics & automation* (`org.settings.manage`, audited) sets the due-soon lead time, whether briefs are sent and at what time, and the health-score weights.

**Navigation and layout**
- *Analytics* and *Automations* entries in the navigation; the latter has a badge for approvals waiting for you.
- Command-palette entries, a dashboard panel for approvals and insights, light and dark chart colours, and print rules.

**Demo data**
- Six rules (five on), including:
  - the Fraser Towers elevator rule with a run **waiting for Marcus**;
  - a weekly report that has already run once;
  - "Serious incidents", off.
- Today's brief for the property manager.
- A Northshore rule, run and brief to prove isolation.

## Files created / modified

- **Schema / migrations:** `src/server/db/schema.ts`, `drizzle/0018_analytics_automation.sql`, `drizzle/0019_rls_automation.sql` (+ snapshots)
- **Analytics:** `src/server/analytics/{period,metrics,settings,health,reports,insights,brief,page-filters}.ts`, `src/lib/analytics-labels.ts`
- **Automation:**
  - Server: `src/server/automation/{engine,actions,recipients,subjects,service}.ts`
  - Shared: `src/lib/{automation,automation-templates,automation-labels}.ts`
- **Shared plumbing:**
  - New: `src/server/after-change.ts`, `src/server/system-orgs.ts`
  - Modified: `src/server/{worker,form-action,audit}.ts`, `src/server/modules/{context,ops/core,ops/kpis}.ts`
  - Modified: `src/server/modules/{notifications,maintenance,documents}/service.ts`, `src/server/authz/permissions.ts`
- **AI:**
  - New: `src/server/ai/tools/analytics.ts`
  - Modified: `src/server/ai/tools/{index,names,maintenance}.ts`, `src/server/ai/{modes,prompt}.ts`, `src/server/ai/demo/intents.ts`, `src/server/ai/eval/cases.ts`
- **Pages:**
  - Analytics: `src/app/o/[orgSlug]/analytics/{page.tsx, health/[propertyId]/page.tsx, reports/page.tsx, reports/[report]/page.tsx, reports/[report]/csv/route.ts}`
  - Brief: `src/app/o/[orgSlug]/brief/page.tsx`
  - Automations: `src/app/o/[orgSlug]/automations/{page.tsx, actions.ts, new/page.tsx, [id]/page.tsx, [id]/edit/page.tsx, runs/[runId]/page.tsx}`
  - Settings: `src/app/o/[orgSlug]/settings/analytics/{page.tsx, actions.ts}`
  - Modified: dashboard, layout, maintenance list, assistant actions/stream
- **Components:** `src/components/analytics/{trend-chart,bits,print-button}.tsx`, `src/components/automation/{rule-builder,decide-form}.tsx`, `src/components/shell/icons.tsx`, `src/config/navigation.ts`, `src/app/globals.css`
- **Seed:** `scripts/seed-automation.ts`, `scripts/seed.ts`
- **Tests:**
  - Unit: `src/lib/automation.test.ts`, `src/server/analytics/analytics.test.ts`
  - Integration: `tests/integration/{automation,analytics}.test.ts`, `tests/integration/tenant-isolation.test.ts`
  - E2E: `tests/e2e/{automation,analytics}.spec.ts`, `tests/e2e/global-setup.ts`, `playwright.config.ts`
  - Assistant: `src/server/ai/{policy,demo/intents}.test.ts`
- **Docs:** `README.md`, `docs/{architecture,ai-architecture,database-schema,roadmap}.md`, this report

## Database changes

- **New tables** `workflows`, `workflow_runs`, `daily_briefs` (see `docs/database-schema.md`):
  - check constraints on trigger, schedule and run status;
  - partial unique indexes for run idempotency (`(workflow_id, event_id)`, `(workflow_id, scheduled_for)`);
  - one brief per person per day.
- **New columns:**
  - `outbox_events.automation_at`, `caused_by_run_id`, `caused_by_workflow_id`, `chain_depth` (the migration marks every existing event as already evaluated, so new rules never replay history);
  - `audit_logs.workflow_run_id`;
  - `work_orders.sla_warned_at`.
- **Changed constraint:** `tasks.source` accepts `automation`.
- **RLS:** the standard tenant policy on the three new tables (`0019`).
- **Indexes:**
  - completed work orders;
  - the due-soon watch;
  - packages by arrival;
  - bookings by start;
  - pending automation events;
  - enabled rules by trigger and by next run.
- **Permission:** `automation.manage`.

## APIs added

Pages:
- `/o/{org}/analytics?period=&from=&to=&property=&building=`
- `/o/{org}/analytics/health/{propertyId}`
- `/o/{org}/analytics/reports`, `/o/{org}/analytics/reports/{report}`
- `/o/{org}/brief`
- `/o/{org}/automations?tab=rules|approvals|runs`, `/new?template=`, `/{id}`, `/{id}/edit`, `/runs/{runId}?decided=`
- `/o/{org}/settings/analytics`

Route handler:
- `GET /o/{org}/analytics/reports/{report}/csv` — same filters as the report; CSV attachment; audited.

Server actions:
- `saveRuleAction`, `setRuleEnabledAction`, `deleteRuleAction`
- `decideRunAction` (approve/decline with note → redirect to the run with a confirmation)
- `candidateEventsAction`, `dryRunAction` (builder; read-only)
- `saveAnalyticsSettingsAction`

Worker jobs:
- `checkSlaApproaching`, `runDueSchedules`, `processAutomationEvents`, `deliverDailyBriefs`, `sweepStaleRuns`

The public versioned REST API is Iteration 10.

## AI capabilities added

- **Tools** (risk class 1, read-only):
  - `query_metrics` — up to 6 metrics, a period or dates, a place, an optional breakdown;
  - `compare_periods` — quarter/month to date vs. the same days before, 7/30 days, or custom ranges; refuses "right now" metrics;
  - `property_health` — factors with value, score and weight;
  - `daily_brief`.

  All are offered by permission (`analytics.read`, plus `workorder.read` for health; staff only for the brief).
- **Prompt:** a numbers rule — every operational number comes from these tools, with the exact period, and is never estimated or added up from records.
- **Demo planner:** metric, period and breakdown parsing ("this quarter", "last 7 days", "which property has the most…"); "briefing" → `daily_brief`.
- **Automation's assistant step:** an internal draft note summarising only the record's facts; logged in `ai_usage` (feature `automation`) and counted against the monthly cap; a fixed template in demo mode.
- **Evaluation:** spending change → `compare_periods`; complaint volume by property → `query_metrics` with a breakdown; health limited to a manager's properties; a resident gets no analytics; the briefing case accepts `daily_brief`.

## Tests added

- **Unit (21):**
  - period presets, comparisons, DST days and buckets;
  - number formatting and change colouring;
  - health factor scoring and re-weighting;
  - CSV quoting and formula neutralisation;
  - schedules (next slot, weekdays, monthly, both DST changes);
  - every condition operator;
  - rule validation (each template valid, 10 invalid shapes);
  - actions per trigger;
  - plain-language rule descriptions and role plurals.

  Plus analytics routing in the demo planner and analytics tool availability per role.
- **Integration — automation (10):**
  - the full elevator slice, step by step and with the audit run id;
  - decline skips steps;
  - conditions and property scope;
  - own-event loop guard, the chain-depth limit and the runaway pause;
  - the owner's *current* permissions;
  - scoped managers can only make rules for their properties;
  - dry run changes nothing;
  - a scheduled report once per slot, per-recipient scope;
  - the due-soon warning fires once and triggers rules;
  - stale run sweep.
- **Integration — analytics (11):**
  - exact metric values on hand-built fixtures, with the previous period;
  - scope and permission limits;
  - series and breakdowns add up to the total;
  - the assistant tools return the same numbers;
  - report rows with SLA outcome;
  - CSV export audited, and no reports for roles without access;
  - health limited to the reader, explained and following the weights;
  - a category spike insight;
  - the brief's scope;
  - once-a-day brief delivery after the brief time.
- **Tenant isolation:** the three new tables are invisible without context. Rules, runs and briefs can't be planted, read, changed or deleted across organizations.
- **E2E (6 new):**
  - the automation slice (template → scope → test → on → resident emergency → manager approval → resident notified → analytics counts it);
  - org-wide rules read-only for a scoped manager, residents get 404;
  - analytics filters → table view → health breakdown → CSV download;
  - daily brief + an assistant spending answer;
  - analytics on a phone without horizontal scrolling;
  - residents can't open analytics or the brief.

  A **warm-up step** (`tests/e2e/global-setup.ts`) compiles every route on the dev server before the tests.

## Test results

- `npm run typecheck` — clean. `npm run lint` — clean.
- **Unit: 235** (+25). **Integration: 456** (+34), against real Postgres + pgvector, with the S3 adapter tested against an S3-compatible server. 41 files, 691 tests, all passing.
- **Assistant evaluation** (`npm run ai:eval`, demo model): **32/32**.
- **E2E: 60** Playwright runs (+7: six new tests, one of them also on mobile), all passing on a freshly reset database and a freshly started dev server, in 20.4 minutes including the 5.6-minute warm-up. Before the warm-up existed, the same suite had 9 timeouts on first-visit compiles; all of them passed when re-run warm.
- **Production build:** the production build is clean. On the production server (port 3100), as the property manager:
  - the dashboard, analytics (30 and 90 days), the vendor scorecard, the brief and the approvals queue rendered in 0.35–1 s;
  - the health breakdown opened;
  - the maintenance CSV downloaded (84 rows);
  - approving the seeded elevator run ran the last step ("Notified Emma Tremblay.");
  - the brief summarised the day.

## Bugs found and fixed during the iteration

- **A role filter leaked across organizations' custom roles.** An `OR` without parentheses widened a query. It is now `(roles.org_id is null or roles.org_id = …)`, and a test covers it.
- **Worker jobs couldn't read organizations in system context.** That's by design: RLS hides `organizations` and `memberships` without an org. Jobs now list active organizations through the platform context and do per-organization work inside that organization's context.
- **The dashboard's first-response time used a different definition than the new metric.** Both now come from the metric catalog.
- **Approving a run lost its confirmation.** The approval panel disappears once the run is decided, so the success message went with it. The action now redirects to the run page, which shows the confirmation.
- **Brief text and builder polish:**
  - the brief said "1 new requests" (pluralisation fixed);
  - roles read "Securitys" in rule sentences (role plurals fixed);
  - narrow selects in the builder were stretched by a conflicting width class.
- **Analytics overflowed horizontally on phones** because chart grids didn't shrink. Fixed, and covered by an E2E check.
- **The assistant's knowledge routing caught metric words** ("resolution time" went to the knowledge base). Metric words are now excluded.
- **Parallel queries on one transaction connection** (pg deprecation warning) when loading names for rule sentences. They are now sequential.

## Known issues

- **The dev-server E2E suite was flaky on a 2-CPU machine.** The first test to reach a route waited for its compile while headless Chromium competed for the CPU. Nine tests timed out on the first full run and passed when re-run warm. The new warm-up step compiles every route before the tests. Production builds don't compile on request.
- **Approvals don't expire.** A run waits until someone decides. The approval badge and the brief keep it visible.
- **Rule logic limits:**
  - Conditions are AND-only (each condition can match "any of" several values; there are no OR groups).
  - A rule can ask for approval once.
  - There are no "wait N hours" steps (schedules and the due-soon trigger cover the common cases).
- **Runs record the rule version number,** but not a copy of that version's contents.
- **Insights use fixed thresholds** (e.g. a spike is ≥ 3 and at least double the 4-week weekly average). Forecasting and statistical anomaly detection aren't built.
- **Fixed scoring rules:** only the health-score weights are configurable; each factor's scoring rule is fixed and documented on the page.
- **PDF output and report attachments:**
  - Reports are "PDF-ready" through the print layout (browser print → PDF); there is no server-side PDF generation.
  - Scheduled reports arrive as notifications with the key figures and a link, not attachments.
- **Metrics are computed live on every view,** with no caching or rollups. That's fine at demo scale (a few hundred milliseconds), but very large portfolios will need materialised rollups (Iteration 13). The health page runs its 8 factor queries in parallel connections.
- **Without an AI provider key,** the automation's assistant step writes a fixed, labelled template.

## Next iteration

**Iteration 10 — Billing and integrations** (details in `docs/roadmap.md`):
- configuration-driven plans with entitlements and usage metering;
- trials and subscriptions through a billing-provider abstraction (a labelled mock provider for development and a Stripe adapter);
- API keys acting as scoped service principals;
- a versioned REST API (`/api/v1`) with an OpenAPI document;
- signed outgoing webhooks from the outbox with retries and an SSRF-safe fetcher;
- an integration framework (email/SMS providers first, Slack/Teams as an automation action, calendar sync interface);
- feature flags.
