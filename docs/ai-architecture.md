# AI Architecture

_Design for Iterations 6–9. Nothing in this document is implemented in Iteration 1 except the pieces it depends on: principals, `authorize()`, tenant-scoped transactions and the audit log._

The assistant is **[YOUR AI ASSISTANT NAME]**. It is an operations layer that acts through the same services, permissions and audit trail as a human user. The LLM never touches the database.

## 1. Pipeline

```
user message
  → identity (session → Principal: user, org, role, scopes, units)
  → load conversation (short-term memory, last N turns + running summary)
  → intent + mode routing (cheap model or rules: read / act / knowledge / analytics)
  → context retrieval (tool calls: records; RAG: policies/docs — both permission-scoped)
  → planning (LLM proposes tool calls with typed args)
  → per call: validate args (Zod) → authorize(principal, tool.permission, resource)
            → risk class → policy engine decision: auto | needs_approval | deny
  → read tools execute immediately; mutations become a PLAN (dry run) when approval needed
  → Approval card [Approve] [Edit] [Cancel]  ← human
  → execute via domain service (same code path as the UI) inside withTenant()
  → verify (re-read the created/updated record)
  → response with links to real records, citations for documents
  → ai_action_logs + audit_logs (ai_generated=true, approval_id, correlation_id)
```

## 2. Tool registry

Each tool is a typed module:

```ts
defineTool({
  name: "create_work_order",
  description: "Create a maintenance work order for a unit or common area.",
  input: z.object({ propertyId: z.string().uuid(), unitId: z.string().uuid().optional(), title: z.string().max(200), … }),
  permission: "workorder.create",
  riskClass: 2,               // 1 read · 2 low-risk mutation · 3 external comms · 4 high impact · 5 irreversible
  resource: (args) => ({ propertyId: args.propertyId, unitId: args.unitId }),
  preview: (args, ctx) => "Create work order “…” at Harbour Centre, Unit 1204",
  execute: (args, ctx) => maintenance.createWorkOrder(ctx, args),
  verify: (result, ctx) => maintenance.getWorkOrder(ctx, result.id),
})
```

- Tools are exposed to the model filtered by the principal's permissions (a resident never even sees `search_residents`).
- Tool results are **data** (records with IDs); the model is instructed to answer only from tool results and say "I don't have that" otherwise.
- Numbers come from analytics tools that run SQL aggregates; the response template renders the number from the tool result, not the model's text, where possible.

Initial tool set (Iteration 6 read-only → 7 actions): `search_properties`, `search_units`, `search_residents`, `search_work_orders`, `get_work_order`, `create_work_order`, `assign_work_order`, `update_work_order_status`, `search_vendors`, `recommend_vendor`, `schedule_inspection`, `search_bookings`, `check_amenity_availability`, `create_booking`, `cancel_booking`, `search_packages`, `create_package`, `notify_resident`, `draft_announcement`, `send_announcement`, `create_incident`, `search_incidents`, `create_task`, `assign_task`, `search_documents`, `retrieve_policy`, `run_analytics_query` (whitelisted metrics), `generate_report`.

## 3. Policy engine

Input: `(principal, tool, args, riskClass, orgPolicy, propertyPolicy)` → `allow | require_approval(approverRole) | deny(reason)`.

Defaults: class 1 allow; class 2 allow if `ai.autoLowRisk` is on; class 3 require approval from requester; class 4 require approval from a manager role; class 5 require explicit typed confirmation, never auto. Org and property policies ("AI may auto-assign maintenance", "AI must ask before contacting residents") override within those bounds — they can tighten anything but cannot loosen class 5. The same engine evaluates automation rules (Iteration 9).

## 4. Approvals

`ai_approvals(id, org_id, conversation_id, requested_by, plan jsonb, status pending|approved|rejected|expired|executed|failed, decided_by, decided_at, expires_at)`. A plan is a list of steps (tool + validated args + preview text). **Edit** re-validates the edited args. Approval re-runs `authorize()` at execution time (permissions may have changed).

## 5. Memory

- **Short-term:** `ai_conversations` / `ai_messages` per user per org; last N messages + rolling summary.
- **Organizational:** policies, rules and procedures in the knowledge base (RAG), plus structured config (amenity rules, SLA policies) read through tools.
- **User context:** role, scopes, properties, preferences injected into the system prompt from the Principal — never from free text.
- Hard rule: every memory store is keyed by `org_id` under RLS; no cross-org retrieval is possible.

## 6. RAG (Iteration 8)

Upload → text extraction (PDF/DOCX/TXT) → chunking (~800 tokens, 100 overlap, heading-aware) → metadata (org, property, building, doc type, visibility, version, uploaded_at) → embeddings (provider abstraction) → `document_chunks.embedding vector(…)` with HNSW index → retrieval = vector + keyword hybrid, **filtered by org_id (RLS) and document visibility for the principal** → optional rerank → LLM context with chunk IDs → answer cites `[doc title §section]`. Disabled or superseded versions are excluded.

## 7. Model abstraction

```ts
interface LlmProvider {
  chat(req: { model; system; messages; tools?; maxTokens; temperature }): Promise<ChatResult>  // text + tool calls + usage
  stream?(…): AsyncIterable<ChatChunk>
}
interface EmbeddingProvider { embed(texts: string[]): Promise<number[][]> }
```

Adapters: `anthropic`, `openai`, `google`, `openai-compatible` (local/self-hosted, e.g. vLLM/Ollama), and **`demo`**. Chosen by `AI_PROVIDER`, `AI_MODEL`, `AI_MODEL_FAST`. The `demo` provider is a deterministic rule-based planner that maps common phrasings to tools so the product works without an API key; every response it produces is labelled **"Demo mode — no language model"**. It still executes real tools through the real policy engine.

Routing (Iteration 9): classification/intent → fast model; planning with tools → main model; extraction → main model with structured output; vision/voice → capability-specific model.

## 8. Logging and cost

`ai_action_logs`: user, org, property, conversation, correlation ID, tool, args (redacted where sensitive), risk class, policy decision, approval ID, outcome, error, latency.
`ai_usage`: provider, model, input/output tokens, estimated cost, org, user, feature. Org-level monthly caps enforced before each call; admin dashboard in Iteration 9.

## 9. Failure handling

Tool errors, permission denials, timeouts and ambiguity are first-class results returned to the model with a stable shape (`{ok:false, code:"AMBIGUOUS", options:[…]}`). The assistant must ask the user to choose rather than guess when ambiguity affects the outcome (two party rooms, two "Tower B"s). LLM timeout → retry once on fast model, then a plain failure message; no partial mutations (each approved plan step is its own transaction, and the plan reports which steps completed).

## 10. UX states

`Thinking → Retrieving <thing> → Checking <policy> → Preparing action → Waiting for approval → Executing → Completed | Failed`. Status labels come from the tool metadata, not model chain-of-thought.

## 11. Evaluation suite (Iteration 6+)

`tests/ai-eval/*.eval.ts`, runnable against `demo` and real providers:

- Tool selection: prompt → expected tool + arg constraints.
- Permission compliance: resident asks for other residents → refusal, **zero** foreign records in tool results.
- No fabricated values: every number in the answer must appear in a tool result.
- Confirmation behaviour: class ≥3 never executes without an approval record.
- Ambiguity: duplicate names → clarification question.
- Policy retrieval: answer cites the right document chunk.
