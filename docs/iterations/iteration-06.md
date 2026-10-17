# Iteration 6 — AI foundation (read-only)

_Completed 2026-10-04_

## What was built

**The vertical slice:** a property manager asks "Show me all overdue maintenance requests across my properties".
1. The assistant calls a typed tool, `search_work_orders{view:"overdue"}`, offered only because the role may list work orders.
2. The tool runs the same `listWorkOrders` service as the Maintenance page, inside the user's row-level-security context.
3. The answer streams in: "16 overdue work orders across 2 properties: Fraser Towers 11, Harbour Centre 5."
4. Record cards with status badges link to the real work orders.
5. The conversation, the tool call (arguments, outcome, duration) and the tokens, cost and latency are all logged.

A resident asking "Show me all residents in another building" gets a plain refusal. No tool runs and nothing leaks. The assistant can't change anything in this iteration; actions with approvals come in Iteration 7.

**Assistant (`/o/{org}/assistant`)**
- **Streamed answers.** Each answer shows a lookup trail ("Looking up work orders — …") and record cards built from the tool data, not from model text. Answer text is rendered as safe markdown, and links only point inside the app.
- **Conversation history.** Conversations are private to their author, can be deleted, and show on reload exactly as answered.
- **Five specialised modes:** Property, Maintenance, Front desk, Facility and Resident. Each has its own tool subset, prompt emphasis and suggested questions. Residents always get Resident mode; concierge/security default to Front desk and facility roles to Facility.
- **Other ways to ask:** **Cmd/Ctrl-K "Ask [YOUR AI ASSISTANT NAME]: …"** (listed first when the text looks like a question), and an ask box on the staff dashboard and the resident home.
- **Mobile layout** for residents and the front desk. Stop, rate-limit and cap notices, and a "Demo mode" label on every demo answer.

**22 read-only tools** over the existing services:
- **Work and property:** work orders (list and detail), properties, units, the resident directory (audited), the resident's own home.
- **Vendors:** vendors and a vendor scorecard computed from work orders.
- **Community:** bookings, amenity availability with a **dry run through the real booking rules**, packages ("waiting more than N days"), announcements.
- **Front desk:** visitors, who's on shift, the last shift handoff with a live open-items snapshot.
- **Operations:** incidents, complaints, tasks, inspections, equipment history and repeat failures, the dashboard KPIs, and the calendar.
- **Safeguards:** free-text references ("Tower B", "the gym", "unit 1204", "RTU-4") are resolved only among records the user can see. Several matches come back as a question with options.

**Providers**
- **Anthropic:** Messages API, streamed, tool use, prompt caching.
- **OpenAI** and any **OpenAI-compatible** server (Ollama, vLLM, LM Studio, gateways): Chat Completions, streamed.
- **Demo model:** works with no key. It routes common questions to the same tools and answers only from their results.
- **Configuration:** by environment (`AI_PROVIDER`, `AI_MODEL`, keys). Missing configuration falls back to demo mode, and the reason is shown to admins.
- **Model routing:** a `routeModel()` seam for future cheap/advanced tiers.

**Admin (*Organization → AI assistant*)**
- This month's requests, failures, tokens, estimated cost and average latency.
- Breakdowns by person, by tool (denied and problem counts) and by model.
- The recent tool-call log with arguments and outcomes.
- An on/off switch and a **monthly request limit**, enforced before the model is called.

**Developer tools**
- `npm run ai:ask -- --as <email> "question"` asks from the terminal through the real orchestrator.
- `npm run ai:eval` runs the evaluation suite against the configured provider.

## Decisions and assumptions

- **Read-only on purpose.** Every tool is risk class 1. When asked to create, book, send or assign, the assistant says it can't yet and links to the page that does it, after any useful lookup: availability and rules for a booking, similar open requests before a new work order. It never claims to have acted.
- **Tool results vs. display.** The model gets compact data (references, hrefs, facts, a factual summary). The UI renders cards from a separate display payload built from the same rows. Numbers in summaries are computed by SQL, never by the model.
- **The demo model is a planner, not a language model.** It maps a fixed set of phrasings to the same tools with the same arguments, so the product is explorable and E2E tests are deterministic. Unknown questions get an honest "I only understand a fixed set of questions in demo mode" with examples.
- **Conversations are private:** owner-only RLS on `org_id` and `user_id`, with no platform-admin bypass. Usage and tool-call logs are org records visible to AI admins.
- **No AI SDKs.** The adapters use `fetch` and a small SSE reader, which keeps dependencies down and lets the streaming parsers be tested against recorded event sequences.
- **Cost estimates are honest.** Models without a known price record tokens but no estimate. Admins can configure prices. Demo requests cost $0.
- **Default Anthropic models:** `claude-sonnet-5` (main) and `claude-haiku-4-5-20251001` (fast tier). OpenAI and compatible servers need `AI_MODEL`.
- **Prompt injection** can't widen access, because tools run as the user and re-check every record. The prompt also tells the model that record text is data, not instructions.

## Database changes

- **`0012_ai_foundation`:** `ai_conversations`, `ai_messages`, `ai_tool_calls` and `ai_usage`, with checks (modes, roles, outcomes, risk class), a unique message sequence per conversation, one usage row per question, and org-leading indexes.
- **`0013_rls_ai`:**
  - Owner-only policies on conversations and messages.
  - Tenant policies on tool calls and usage.
- **Organization settings:** `aiEnabled` and `aiMonthlyRequestCap`.

## Changes to existing modules

**Services**
- `listWorkOrders` gained building and unit filters (with a shared filter builder) and `workOrderCountsByProperty`.
- New optional filters:
  - complaints: text, since/until, building
  - incidents: since/until, building
  - packages: unit, received-before
  - bookings: date window, building
  - visitors: property
  - residents: unit, building
- Booking rules are evaluated by a shared `evaluateBookingTx`, so `previewBooking` (the dry run) and `createBooking` use the same code.
- New `analytics/vendors.ts` vendor scorecard.

**Search and display fixes**
- `toPrefixQuery` now finds hyphenated codes such as `RTU-4`. This was a real search bug on the assets page too.
- Amenity rules say "Up to 1 person", not "1 people".

**UI and seed**
- **UI:** an *Assistant* nav item and an *AI assistant* settings page.
- **Seed:**
  - Two incidents earlier "today".
  - Two recent fitness-centre complaints at Fraser Towers.
  - Real example conversations generated by running the orchestrator with the demo model.
  - A delivered outbox event in the demo org, so the isolation tests don't depend on test order.

## Routes and actions

- `POST /o/{org}/assistant/stream`: newline-delimited JSON events. It requires the same origin and JSON, plus a session and membership.
- Pages: `/o/{org}/assistant` (`?c=` for a conversation, `?q=` to ask straight away) and `/o/{org}/settings/ai`.
- Server actions: delete conversation, update AI settings.

## Tests

- **Unit: 162** (+37).
  - SSE parsing across chunk boundaries and CRLF. This found a real bug: a `\r\n` split across chunks.
  - Anthropic adapter: message mapping, cached system prompt, partial tool JSON, usage, HTTP and stream errors, retryability.
  - OpenAI adapter: mapping, `max_completion_tokens` vs `max_tokens`, tool calls assembled by index, cached-token usage.
  - Provider selection and demo fallbacks; cost estimates.
  - The grounding check, conversation-replay repair, modes, the system prompt, org AI settings and result trimming.
  - The markdown renderer's link safety.
  - The demo planner: all six brief scenarios plus 20 everyday phrasings, dates, times and extraction.
- **Integration: 350** (+54).
  - **Orchestrator with the demo model:** answers match DB truth; transcript, tool log and usage are persisted; conversation continuation replays history.
  - **Permissions:**
    - Tools are filtered per role.
    - Vendors are refused.
    - A model calling an un-offered tool gets `UNKNOWN_TOOL`.
    - A place outside the user's scope is `NOT_FOUND`, never revealed.
    - Front desk results stay within their property.
    - Invalid arguments are reported back to the model.
    - Ambiguity returns options.
    - Directory reads are audited as AI reads.
  - **Limits and failures:**
    - The step limit stops runaway loops.
    - A retryable provider error is retried once.
    - A non-retryable one ends the turn without leaking details.
    - Timeouts abort the model call.
    - Cost is estimated for priced models.
    - The per-user rate limit, the monthly cap (refusals don't count) and the org off switch all work.
    - Only AI admins see usage or change settings.
  - **Privacy:** another user can't open, list or continue a conversation (service and RLS), and deleted conversations are gone.
  - **All 17 evaluation cases pass** with the demo model.
  - **Tenant isolation** now covers the four AI tables, including owner-only transcripts that even platform admins can't read.
- **E2E: 39** Playwright runs (+6):
  - A manager asks about overdue work and opens a record from the answer.
  - A resident is refused directory access with nothing looked up.
  - A question asked from Cmd/Ctrl-K is kept in history and re-rendered from the database.
  - An admin sees usage and the action log and sets a monthly limit.
  - A resident asks about packages from the home screen on a phone, with no horizontal scroll.
- **Production build:** the streamed endpoint was verified under `next start`, with a morning briefing answered from three tools.
- **Real providers:** the adapters are tested against recorded event streams. They were **not** run against live provider APIs here, because this environment has no outbound access to them. `npm run ai:eval` is the check to run once a key is set.

## Bugs found and fixed during the iteration

- **CRLF split across chunks (SSE reader):** a `\r\n` split across two network chunks produced an empty event. Found by the unit test's 1-byte chunking.
- **Hyphenated codes not found in search:** searching "RTU-4" found nothing, because Postgres indexes it as `rtu-4`/`rtu`/`4` while the query asked for `rtu4`. Fixed in the shared query builder, which also fixes the asset search page.
- **"The gym" silently resolved:** for an org admin it picked the Harbour Centre gym when Fraser Towers also has one. Exact-name matches now win only within one property; otherwise the assistant asks.
- **Demo planner misreadings (caught by the eval suite):**
  - "Which packages are waiting at the desk?" went to the shift tool.
  - "Tell me about RTU-4" was read as "tell (someone)…".
  - "What's the emergency number…" went to emergency work orders.
- **React key warning:** a server-rendered element passed into the chat header triggered it.

## Known issues / limits

- **Read-only.** Mutations, the policy engine, dry-run plans and approvals are Iteration 7.
- **No document knowledge yet.** Policy questions ("What are the party room rules?") are answered only from structured amenity rules, not documents. RAG is Iteration 8.
- **Demo mode is narrow:** a fixed set of phrasings. A real provider handles open questions.
- **Untested against live providers:** this environment can't reach the provider APIs (see Tests).
- **Prices:** the price table only knows the Claude Haiku 4.5 list price. Set `AI_PRICE_*` for other models, or the usage page shows tokens without a cost.
- **Single-instance rate limiting:** the per-user AI rate limit uses the in-memory limiter. The Redis adapter is still to come.
- **No voice input yet.** The architecture allows for it (Iteration 12).
- **Docker untested here:** Docker isn't available in this environment.
