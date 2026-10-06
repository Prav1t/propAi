# Iteration 7 — Agentic AI (actions with approvals)

_Completed 2026-10-05_

## What was built

**The vertical slice:** a property manager types "Create a maintenance request for the broken elevator in Tower B and assign Summit Elevator".
1. The assistant first searches for similar open requests and shows them ("there are already 2 similar open requests — check it isn't the same problem").
2. It calls `create_work_order`, which only **prepares** the step: it resolves Tower B and Summit Elevator Services among records the manager can see, runs the organization's triage rules, and writes nothing.
3. A **plan card** appears: "Create work order “Broken elevator” · Tower B · Fraser Towers · Elevator · priority high · triage rules that will apply … → the property's managers are notified → assigned to Summit Elevator Services, who is notified", with **Approve**, **Edit** and **Cancel plan**.
4. On **Approve**, the plan is locked, the manager's permissions and the organization's AI rules are checked again, and the same `createWorkOrder` and `assignWorkOrder` services as the Maintenance page run as the manager.
5. The step is **verified** by re-reading the record ("Checked: WO-265 is on file at Tower B · Fraser Towers, status assigned, vendor Summit Elevator Services") and links to it.
6. The audit log shows `ai.plan.prepared → ai.plan.approved (a human decision) → work_order.created → work_order.assigned → ai.plan.executed`, with the domain entries marked `ai_generated` and carrying the plan's `approval_id`. The vendor is notified through the normal outbox.

**13 action tools** — each one `prepare → execute → verify`:
- **Work orders:** create (optionally assign), assign, change status, add a note.
- **Planning:** create a task, schedule an inspection from a checklist template.
- **Community:** book or cancel an amenity, log a package, register a visitor, report an incident.
- **Communications:** publish an announcement, message a resident.

Each tool:
- **Prepares with the real rules, writing nothing:**
  - booking rules (`previewBooking`) and triage rules (`triagePreview`);
  - allowed status transitions;
  - vendors approved for the property;
  - the announcement's audience size;
  - the visitor window.
- **Resolves references only among records the user can see**, and asks when they're ambiguous ("Unit 1204 exists in more than one building").
- **Executes through the existing domain services** as the user.
- **Verifies** by re-reading what it wrote.

Residents get their own subset: file a work order, comment, book, cancel, invite a guest, report an incident — **for their own home only**.

**The policy engine** (`policy.ts`, `policies.ts`):
- **Risk classes:**
  - 1 — read;
  - 2 — internal change;
  - 3 — contacts people;
  - 4 — high impact, e.g. cancelling a work order;
  - 5 — irreversible.
- **Rules:** per organization and optionally per property, for ten action keys: `auto`, `confirm` or `deny`. With no rule, the assistant asks first.
- **Precedence:** the most specific rule wins (property over organization over default), and the strictest key in a step wins.
- **Hard limits:**
  - class ≥ 3 can never run on its own, and an admin can't save such a rule;
  - confirmation grows with risk: one click (classes 2–3), a tick-box acknowledgement (class 4), typing `CONFIRM` (class 5).
- **Admin UI:** *Organization → AI assistant → What the assistant may do*, with a property-rule editor and a **Recent plans** table.

**Plans** (`ai_approvals`, `approvals.ts`):
- **One plan per turn:** identical steps are prepared once, with at most 8 steps. A newer plan in the same conversation replaces the older pending one.
- **Expiry:** 24 hours.
- **Only the requester can see or decide it.** Approval takes a row lock, so a double click or a second tab can't run a plan twice.
- **Re-authorization at approval:** the assistant must still be enabled, each tool still allowed for the role, and the step not denied by the current rules. Then every service re-checks permissions and RLS.
- **Steps run in order and stop at the first failure.** The result is `executed`, `partially_failed` or `failed` — nothing is hidden.
- **Edit** changes only the fields a tool allows. The step is re-validated and re-prepared with the same rules.
- **The model is told what happened** on its next turn ("[Update: The user approved the plan. Results: …]") without rewriting the stored transcript.
- **Policy-allowed steps** run immediately as one-step `auto` plans and are audited the same way.

**UI**
- **Plan card:**
  - risk badges;
  - the facts and side effects;
  - full drafts of anything residents will read;
  - Approve / Edit / Cancel;
  - the acknowledgement or typed confirmation when required;
  - states: *Waiting for your approval → Running → Done / Partly done / Didn't run / Cancelled / Expired / Replaced by a newer plan*;
  - each step's result, its record link and what verification found.
- **"Waiting for your approval" list** in the assistant sidebar.
- **Trail line** for each prepared step ("Prepared — waiting for approval: …").
- **Wording:** the empty state and footer now say that changes happen only after approval.

**Communication drafts:**
- Announcements and messages are drafted in full in the requested tone: professional (default), friendly, concise, formal or urgent.
- Relative dates are spelled out ("tomorrow (Tuesday, October 6)").
- "make it friendlier" redrafts the last one.
- With a language model, the model writes the text under the prompt rule "facts the user gave or tools returned only". In demo mode, fixed templates fill in the user's own words.

**Demo mode does actions too** (`demo/actions.ts`):
- About 25 phrasings map to the action tools, so the approval flow is explorable and E2E-testable without a key.
- These include "a package arrived for unit 602", "assign WO-1043 to Coastline Electric", "mark WO-12 completed with notes: …", "cancel booking #42 because …", "register a visitor named … from … at 9 AM", "book the gym the day after tomorrow at 7 PM", "report an incident: …", "send residents of Fraser Towers a notice saying …, keep it urgent", "message the resident of unit 1204 saying their fob is ready" (rewritten as "your fob…"), and "The elevator in Tower B is broken. Create a work order, assign Summit Elevator and notify the residents" (a work order plus a notice in one plan).
- Questions are never mistaken for actions ("Which packages arrived for unit 602?" still searches).
- A typed "yes, go ahead" gets a pointer to the Approve button.

## Decisions and assumptions

- **Prepared, not executed.** Calling an action tool never changes data unless an `auto` rule applies. This removes a whole class of "the model did it before I agreed" failures.
- **Resolved ids are stored in the plan,** so approval runs exactly what was shown. Text is never re-interpreted at approval time.
- **High-impact steps need the requester's acknowledgement, not a manager's sign-off.** The requester must already hold the permission, and the services enforce that. Routing an approval to another person belongs to the workflow engine's "request approval" action (Iteration 9). This differs from the Iteration 0 sketch.
- **`auto` is allowed only for class 2.** The seed lets Pacific create internal tasks without asking, and keeps package logging manual at Northshore.
- **One announcement action instead of draft + publish:** the plan itself is the draft. Assigning tasks is folded into `create_task` (assignee).
- **Steps aren't one transaction:** each step uses its services' own transactions. A multi-step plan stops at the first failure and reports a partial result. A work order that was created but failed to assign is reported as a warning.
- **Plans are visible only to the requester** in the product. Admins see a summary (Recent plans) and the full audit trail. RLS on `ai_approvals` is the standard tenant rule, and the per-user restriction is in the service.
- **Plan outcomes reach the model through history notes,** not extra message rows. This avoids sequence races with a turn in progress.

## Database changes

- **Migration `0014_ai_actions`:**
  - **`ai_approvals`** — the plan: steps and results as jsonb, mode (confirm/auto), 8 statuses, requested by / decided by / at, executed at, expires at.
  - **`ai_policies`** — action, optional property, mode, updated by. Partial unique indexes: org+action, and org+property+action.
  - **`ai_tool_calls.approval_id`** (indexed), plus outcomes `pending`, `executed`, `policy_denied`.
- **Migration `0015_rls_ai_actions`:** tenant RLS on both new tables.

## Changes to existing modules

- **`TenantCtx.ai = { approvalId }`:** `auditAs` writes `ai_generated` and `approval_id` from it. Every service that audits through `auditAs` marks assistant changes automatically.
- **Maintenance:**
  - `triagePreview` — which rules would apply, without writing;
  - `assignmentOptions` — staff and approved vendors for a property;
  - a timeline note when a request was filed with the assistant.
- **Announcements:** `audienceSize` — how many app users a notice would reach.
- **Tool helpers:**
  - `pickByName` — exact match, then contains, then all words ("fire safety" → "Monthly fire & life safety walk"), listing the choices when nothing matches;
  - `atLocal`, `myUnits`, `propertyFor`, `buildingFor`, `makeToolEnv`.
- **Orchestrator:** action handling, plan creation at the end of the turn, a `plan` stream event, policy rules and plan notes loaded per turn.
- **Stream route:** drains the outbox after a turn, so steps run by policy notify straight away.
- **Settings page:** the policy table and Recent plans. The Model panel text is updated.
- **Chat component:**
  - keeps its state when a new conversation gets its URL, so a plan being edited isn't torn down;
  - renders plan cards;
  - marks older pending plans as replaced when a new one arrives.

## Routes and actions

- **Stream** (`POST /o/{org}/assistant/stream`) now also emits `{ type: "plan", plan }`.
- **Server actions:**
  - `approvePlanAction`, `rejectPlanAction`, `revisePlanStepAction` — Zod-validated ids, requester only, outbox drained after approval;
  - `setAiPolicyAction` — `ai.settings.manage` only.
- **CLI:** `npm run ai:ask -- --as <email> --approve "…"` prints the plan and approves it as that user.

## Tests

- **Unit: 188** (+26).
  - **Policy engine:**
    - the default is to ask;
    - organization vs property rules;
    - the strictest key wins;
    - class ≥ 3 is never `auto`;
    - confirmation levels;
    - every action has a label.
  - **Action tools per role:**
    - residents never get assign, status, packages, announcements, messages, tasks or inspections;
    - managers get all 13;
    - the front desk gets desk actions;
    - vendors get none.
  - **Prompt:** the action rules are in the prompt, and the read-only rule is gone.
  - **History:** plan notes are appended to the right turn.
  - **Demo action planner:** about 25 phrasings, the question guard, "yes" never approving, redrafts and the combined work order + notice.
  - **Drafting templates:** five tones, with no invented times.
  - **Composer:** never says a prepared step was done; reports policy runs and refusals plainly.
- **Integration: 382** (+32).
  - **Vertical slice:**
    - nothing is written before approval;
    - work order created and assigned;
    - verified;
    - exact audit sequence with `ai_generated` / `approval_id`;
    - outbox event;
    - `:run` log row;
    - the conversation view shows the plan;
    - the next turn tells the model what happened.
  - **Deciding on plans:**
    - two approvals at once run once;
    - cancel, then approve is refused;
    - other users, admins and other organizations get "not found";
    - a newer plan supersedes an older one;
    - an expired plan won't run;
    - a removed permission blocks execution;
    - a policy turned to deny after preparation blocks execution;
    - invalid edits are rejected (too short, unknown field, bad option, unknown step);
    - a valid edit runs as edited;
    - cancelling a work order needs the acknowledgement;
    - a two-step plan with a failing second step is `partially_failed`.
  - **Policies:**
    - a task runs by policy, with an `auto` plan and audit;
    - a property rule overrides the organization rule;
    - communications can't be `auto` and only AI admins change rules;
    - `deny` yields `policy_denied` with no plan;
    - Northshore's package rule.
  - **Residents:**
    - booking for another unit is denied;
    - their own booking runs through the rules and is approved for their unit;
    - the 48-hour rule refuses before anything is prepared;
    - a work order is filed for their own unit, and triage decides it's an emergency;
    - they can't dispatch a vendor;
    - staff-only tools are `unknown_tool`.
  - **Front desk:**
    - an ambiguous unit gets a question, then the package is logged and the resident notified.
  - **Communications:**
    - an announcement draft is redrafted friendlier, edited, approved, published, and the resident is notified;
    - identical steps are prepared once.
  - **Tenant isolation:** extended to `ai_approvals` and `ai_policies`, with no cross-org inserts, updates or deletes.
  - **Evaluation suite:** now 21 cases, all passing with the demo model. New and updated cases:
    - create-and-assign prepares a plan after a duplicate search;
    - an announcement is a draft plan;
    - a typed "yes" runs nothing;
    - a booking runs nothing without approval;
    - a task runs by policy;
    - a disabled action is `policy_denied`;
    - a resident can't dispatch a vendor.
- **E2E: 47** Playwright runs (+8):
  - approve a prepared work order and open it;
  - edit a step, then cancel (nothing created);
  - the pending list opens the waiting plan;
  - a task runs by policy;
  - an announcement is approved and the resident sees it;
  - a resident books the gym on a phone (desktop and mobile, no horizontal scroll);
  - an admin sets an AI rule (`auto` is disabled for communications).
- **Production build:** `next build` is clean. Under `next start`, a plan was prepared and approved in the browser (WO created and linked).

## Bugs found and fixed during the iteration

- **Settings page 500:** a Drizzle `asc(sql\`… nulls first\`)` rendered invalid SQL (`nulls first asc`). Found in the UI pass.
- **Chat remount discarded an edit in progress** when a brand-new conversation received its URL. Found by E2E. The chat now keeps its state for its own conversation and resets only when you open a different one.
- **Demo planner misreadings** (caught by the new unit tests):
  - "from Summit Elevator Services" was taken as the visitor's location;
  - "with notes: …" kept the word "notes:";
  - "booking #42" was read as WO-42;
  - "keep it urgent" became part of the notice text;
  - "in the P2 garage" produced a place called "P";
  - "yes go ahead" wasn't recognised;
  - "Assign …" was case-sensitive;
  - "Add a internal note" (grammar).
- **Checklist names:** "fire safety" didn't match "Monthly fire & life safety walk"; word matching was added.

## Known issues / limits

- **No second-person approval** (manager sign-off) yet. High-impact steps need the requester's acknowledgement. Approval routing comes with the workflow engine (Iteration 9).
- **Steps aren't atomic across a plan.** Each step commits on its own, and a failure stops the rest and is reported. Previews can go stale between prepare and approve (e.g. audience size); the services re-validate everything that matters at execution.
- **No class-5 tools yet.** The typed-confirmation path exists in the approval service and the plan card, but no tool needs it, so no test exercises it.
- **Demo mode is narrow:** fixed phrasings and template drafts. Most requests map to one action; the only combination is a work order plus a notice. A real provider handles open requests and multi-step plans.
- **Untested against live providers.** This environment can't reach the provider APIs; run `npm run ai:eval` once a key is set.
- **Plans expire silently after 24 hours.** There's no reminder notification for pending plans.
- **Messages only reach residents who use the app.** Email/SMS to others arrives with integrations (Iteration 10).
- **Carried over:** single-instance rate limiting, no voice input (Iteration 12), Docker untested here.
