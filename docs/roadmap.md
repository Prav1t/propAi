# Implementation Roadmap

Each iteration must end runnable, building, tested, documented, with demo data. Status is updated at the end of every iteration.

| # | Iteration | Status | Exit criteria (summary) |
|---|---|---|---|
| 0 | Discovery + architecture | ✅ Done | Research, requirements, architecture, AI architecture, schema, roadmap docs |
| 1 | Application foundation | ✅ Done | Register → verify → create org → enter; login with MFA; invitations; RBAC + scopes; RLS tenant isolation proven by tests; settings; audit log; seed; Docker |
| 2 | Property / portfolio core | ✅ Done | CRUD for portfolios, properties, buildings, floors, units, residents (occupancy), staff, vendors; search + filters; detail pages; Cmd/Ctrl-K navigation |
| 3 | Operations core | ✅ Done | Maintenance state machine + SLA, vendor assignment + vendor portal, tasks, inspections (templates, checklists), incidents, complaints; outbox events; notifications (in-app + email) |
| 4 | Community + resident experience | ✅ Done | Resident dashboard (mobile-first), amenities + booking rules engine, packages, announcements, messaging, documents + file storage |
| 5 | Concierge + facility | ✅ Done | Concierge console, visitors + QR passes, parking permits/violations, shifts + handoff notes, assets, preventive maintenance, downtime |
| 6 | AI foundation | ✅ Done | Provider abstraction (Anthropic, OpenAI, compatible, demo), 22 read-only permission-filtered tools, orchestrator, private conversations, tool-call log, usage + caps, chat UI with status states, eval suite |
| 7 | Agentic AI | ✅ Done | 13 action tools (prepare → execute → verify), policy engine (org + property rules, risk classes, hard limits), approval plans with Approve / Edit / Cancel, re-authorization, AI-marked audit, tone-aware drafts, demo-mode actions, eval cases for actions |
| 8 | RAG + knowledge base | ⏭ Next | pgvector, ingestion, chunking, permission-aware retrieval, citations, KB admin UI |
| 9 | Analytics + automation | | KPI dashboards from real data, reports + CSV, property health score, workflow engine (WHEN/IF/THEN), SLA monitor, daily brief |
| 10 | Billing + integrations | | Config-driven plans, trial, mock + Stripe billing adapter, API keys, versioned REST API docs, outgoing webhooks (HMAC, retries, SSRF-safe) |
| 11 | Security hardening | | Threat model review, pen-test style tests, SSO/OAuth, org-enforced MFA, privacy export/deletion, rate limits on Redis |
| 12 | UX polish | | Loading/empty/error states, accessibility audit, mobile passes, PWA, voice input |
| 13 | Production readiness | | Prod Docker, migrations runbook, backups, monitoring, deployment guide |

Iteration reports: [1](iterations/iteration-01.md) · [2](iterations/iteration-02.md) · [3](iterations/iteration-03.md) · [4](iterations/iteration-04.md) · [5](iterations/iteration-05.md) · [6](iterations/iteration-06.md) · [7](iterations/iteration-07.md)

## Iteration 8 — detailed plan (RAG + knowledge base)

Vertical slice first: **a resident asks "What are the rules for booking the party room?" → the assistant searches only the documents and knowledge entries that resident may see (their property's policies, published to residents), answers from the retrieved passages, and cites them as links ("Fraser Towers Amenity Policy, §3 Party Room") — and says plainly when the documents don't cover the question.** A manager asking "what's our emergency procedure for a flood in Tower B?" gets the staff-only procedure; the same question from a resident never retrieves it.

1. **Vector storage:** `document_chunks` (org, document, version, property/building, audience, heading path, ordinal, text, token count, `embedding vector(n)`, `tsvector`), HNSW index, under the same RLS as `documents`. pgvector is the target (the Docker image switches to `pgvector/pgvector:pg16`); where the extension isn't installed, a documented fallback stores embeddings as `real[]` and ranks in SQL so development and tests still run.
2. **Ingestion pipeline** (worker job, triggered by the document-uploaded outbox event and by knowledge-base edits): text extraction for PDF, DOCX, Markdown/text (the existing `lib-pdf` text layer for PDFs), heading-aware chunking (~800 tokens, 100 overlap), metadata from the document (type, property, building, audience, version), embeddings through an `EmbeddingModel` provider abstraction (OpenAI-compatible and a deterministic local demo embedder so it works without a key), status per document (queued / indexing / indexed / failed with reason), re-index on new version, superseded versions excluded.
3. **Permission-aware retrieval:** hybrid search (vector similarity + full-text rank, reciprocal-rank fusion) filtered by RLS and by the document's audience/property for the principal *before* ranking; top passages with their document, section and version.
4. **Knowledge base:** admins add text entries ("Our after-hours emergency procedure is …") alongside uploaded documents, categorise them (rules, procedures, emergency, amenities, maintenance), assign a property, set the audience (staff / residents / everyone), replace versions, disable entries, and see indexing status — *Organization → Knowledge base*.
5. **Assistant tools:** `search_knowledge` (passages with citations) and `retrieve_policy` (best-matching policy for a topic and place); answers cite sources as in-app links; the prompt requires answers about rules and procedures to come from retrieved passages, never from the model's general knowledge, and to say when nothing covers it. Legal/policy content is presented as the organization's documents, not legal advice.
6. **Booking and maintenance grounding:** the booking and work-order actions add the relevant policy passage to their prepared steps when one matches (e.g. the party-room deposit rule), so approvals show the rule they rely on.
7. **Demo mode:** the deterministic embedder plus keyword ranking make retrieval and citations work without a key; seeded policy documents and knowledge entries for each property (amenity rules, move-in procedure, emergency procedures — staff-only versions included) so permission boundaries are demonstrable.
8. **Tests:** chunker and extractor unit tests; retrieval never returns another org's chunks, staff-only chunks to residents, or another property's chunks to a property-scoped manager; superseded versions aren't retrieved; eval cases for cited answers, "not covered" honesty, and audience leaks.

Carried over: routing approvals to a second person (manager sign-off) moves to the workflow engine's "request approval" action (Iteration 9); voice input for the assistant (Iteration 12), web push notifications (manifest exists; service worker + VAPID in Iteration 12), payment collection for amenity fees/deposits (Iteration 10), Google/Outlook calendar sync (Iteration 10 integrations), camera / licence-plate-recognition integration beyond the `ingestDetection` entry point (later, behind a feature flag), Docker compose run on a machine with Docker.
