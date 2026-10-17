# Iteration 8 — Knowledge base and retrieval (RAG)

_Completed 2026-10-13_

## What was built

**The vertical slice:** a resident asks "What are the rules for booking the party room?".
1. The assistant calls `search_knowledge`, which searches only passages this resident may read: active sources for residents at Fraser Towers (their home) or organization-wide, current versions only.
2. It finds the manager's "Party room booking rules" entry plus the amenity policy and house rules documents.
3. The answer quotes the rules — "Management approves every booking. The fee is $50 and the refundable damage deposit is $250…" — and links each quote to its section ("Party room booking rules § Approval, fee and deposit").
4. The citation opens the entry, read-only for the resident.

The same question about Tower B's riser valves returns the staff-only flood procedure to the front desk, and nothing to the resident. "What is the policy on hot tubs?" gets "nothing in the documents you can access covers that" instead of an answer from general knowledge.

**Indexing**
- **Every document and every knowledge entry is a source**, queued in the same transaction as the upload, new version, title change or edit. The request's `after()` hook and the worker index it within seconds.
- **Extraction:**
  - PDF text page by page (`unpdf`), Word `.docx` with its headings (`mammoth`), plain text and markdown.
  - Images, spreadsheets and slides are marked "can't read" with a reason.
  - Damaged files are marked failed with a reason, once (not retried).
- **Chunking** follows the document's own sections:
  - recognised headings: markdown, "2.3 …", ALL CAPS, "Part 7 …", "Heading:";
  - list items and numbered rules stay separate lines;
  - passages are ≤ 380 tokens, with up to 60 tokens of overlap;
  - each passage keeps its heading path and page, so citations can say "§ Fees" or "p. 2".
- **Embeddings** go through one interface: Voyage, OpenAI, any OpenAI-compatible server, or a **local offline hashing embedder** when no key is set. Every passage records the model that embedded it. Sources indexed with an older model are flagged, and vector search ignores them until re-indexed; keyword search still covers them.
- **No half-indexed sources:** passages are swapped in one transaction. A newer version queued meanwhile wins. An embedding failure keeps the passages for keyword search and says so.

**Retrieval** (`searchKnowledge`)
- **Filtered before ranking**, in SQL, with the same rule as the Documents page:
  - the organization (RLS plus an explicit predicate);
  - audience: staff, residents or owners only;
  - place: unit, building, property or organization-wide;
  - active sources and current versions only.
- **Two rankings, fused:** pgvector cosine similarity (HNSW index) and weighted full-text search (English stemming, with each question word's everyday equivalent — gym ↔ fitness, dog ↔ pet), combined by reciprocal-rank fusion.
- **Relevance:** a floor drops passages that are neither close in meaning nor share enough of the question's words. With the offline embedder, a passage must also share at least one word with the question, because its hashed features collide by chance. At most 3 passages per source.

**Assistant**
- **Three new read tools:**
  - `search_knowledge` — passages with citation links;
  - `retrieve_policy` — limited to rules, policies and procedures;
  - `search_documents` — titles and links.

  All three are offered to staff and residents with document access, never to vendors.
- **Prompt rules:** answer only from the passages, cite every fact as a link, say when nothing covers it, never answer rules questions from general knowledge, and present bylaws as the organization's documents, not legal advice.
- **Demo mode:** routes rules, policy and how-to questions — and any unrecognised question — to `search_knowledge`. It quotes the most relevant sentences verbatim, item by item for numbered lists, with their citations.
- **Answer rendering:** answers render `>` quotes. The cards under the answer list the sources, with "Staff only" / "Owners" badges for staff.
- **Grounding for actions:**
  - a prepared booking shows the matching policy ("Policy: “Management approves every booking…” — Party room booking rules");
  - an emergency work order shows the procedure on file.

  Each appears only when a passage clearly matches.

**Knowledge base** (`/o/{org}/knowledge`, new `knowledge.manage` permission for property managers and admins)
- **One list for everything:** every document and entry the manager can see, with its index status (indexed / queued / can't read / failed / older model), counts and the search model in use.
- **Tabs:** all, entries, documents, needs attention; plus title search and a property filter.
- **Try a question:** shows exactly which passages the assistant would get — as you — with their meaning and word-match scores.
- **Entries:**
  - written in your own words with `## sections`;
  - category, audience, and place (organization, property or building);
  - every save is a new version with a note, and old versions are viewable;
  - disable/enable takes effect immediately;
  - shows the passages it was split into;
  - re-index one source, or everything you manage.
- **Document pages** show an *Assistant index* panel with status, passage count and re-index.

**Demo data:**
- 7 entries written the way a manager would: party room rules, moving in and out, what counts as a maintenance emergency, Harbour Centre amenities, a **staff-only** after-hours flood procedure, a **staff-only** unit-entry procedure, and Northshore's lounge rules.
- All seeded documents indexed: 18 sources, 30 passages.
- A seeded resident conversation asking the party room question.

## Decisions and assumptions

- **pgvector is required.** The roadmap allowed a fallback without it. One code path with an HNSW index is simpler and faster, the Docker image already ships pgvector, and the managed Postgres services we'd deploy to support it. Local setup: install the extension. Either the migration role may create it, or pre-create it once; `CREATE EXTENSION IF NOT EXISTS` then skips for any role.
- **512 dimensions, fixed by the column.** Voyage and OpenAI are asked for 512. Other models must already produce it, and this is checked with a clear error.
- **Small passages (≤ 380 tokens, not the planned ~800).** Building rules are short and citations should point at the exact section.
- **Offline hashing embedder for demo mode.** It's deterministic and needs no network. With it, keyword search does most of the work; it's labelled demo quality in the UI. Its version is part of its id (`local/hash-v2`), so changing its features flags old passages.
- **The queue is the `kb_sources` table.** It's processed by the request's `after()` hook and the existing worker, so there's no new infrastructure. Claims use `SKIP LOCKED`, with three attempts and stale-claim recovery.
- **Audience and place reuse the document model** (staff / residents / owners; unit, building, property, organization). One shared SQL rule serves both documents and entries.
- **Demo answers are extractive.** With no model, the demo quotes sentences rather than paraphrasing, so it can't misstate a rule.

## Database changes

- **Migration `0016_knowledge_base`** (`CREATE EXTENSION IF NOT EXISTS vector`):
  - **`knowledge_entries`** — place, title, body, category, audience, status, version.
  - **`knowledge_entry_versions`**.
  - **`kb_sources`** — one per document or entry, with a check constraint and partial unique indexes. It holds the queue status, versions, counts, model, error and attempts.
  - **`kb_chunks`** — passages with context, heading, page, token count, `embedding vector(512)` and model.
- **Migration `0017_rls_knowledge`:**
  - tenant RLS on all four tables;
  - a generated weighted `search tsvector` on `kb_chunks` with a GIN index;
  - an **HNSW** cosine index on `embedding`;
  - a title index on entries.
- **Permission** `knowledge.manage`, granted to property managers; org admins hold every permission.

## Changes to existing modules

- **Documents:**
  - create, new version and retitle queue indexing;
  - `placeVisibleWhere()` is the shared visibility rule, also used by knowledge entries;
  - the document page has the index panel.
- **Worker** and **form actions** process the index queue.
- **Assistant:**
  - three tools, mode subsets and prompt rules;
  - the demo planner and composer handle citations;
  - the markdown renderer supports quotes;
  - booking and work-order actions add policy and procedure lines.
- **Navigation:** *Knowledge base* (book icon), for `knowledge.manage`.
- **Files:** `OFFICE` MIME map exported for extraction.

## Routes and actions

- **Pages:**
  - `/o/{org}/knowledge` (`?test=` for "try a question", tabs, search, property filter);
  - `/o/{org}/knowledge/new`;
  - `/o/{org}/knowledge/{id}` (`?v=` for an older version);
  - `/o/{org}/knowledge/{id}/edit`.
- **Server actions:** create entry, new version, disable/enable, re-index (one source, a document, or everything in scope).

## Tests

- **Unit: 210** (+22).
  - **Headings:** recognised and rejected.
  - **Chunking:** sections across pages, lists, token limits, overlap, sentence and word splitting.
  - **Extraction:** text, a real PDF, a real `.docx` built in the test, and unsupported types and sizes; Word HTML → text.
  - **Query terms:** stemming, stop and rule words, synonyms, search groups.
  - **Hash embedder:** deterministic, normalised, closer for related text.
  - **Provider selection** from the environment.
  - **Provider HTTP**, mocked: requested dimensions, result ordering, one retry, wrong-size and malformed responses, auth errors.
  - **Quotes:** list items with their lead-in, short paragraphs only when on topic; citation labels.
  - **Demo routing** to `search_knowledge` and `search_documents`.
  - **Answers:** cited quotes and "not covered".
  - **Markdown quotes.**
  - **Prompt rules.**
  - **Tools per role:** residents and the desk get the knowledge tools; vendors don't.
- **Integration: 422** (+40).
  - **Seed indexing:** every seeded source is indexed with the local embedder.
  - **Retrieval permissions:**
    - a staff procedure reaches the desk, never a resident;
    - a property-scoped role gets no other property's staff documents;
    - owners-only material reaches owners, not tenants;
    - nothing crosses organizations, in the service or in the database;
    - a place filter keeps that property plus organization-wide material;
    - irrelevant questions return nothing, including a made-up word whose hashed features collide with a passage;
    - vendors are refused.
  - **Indexing life cycle:**
    - an entry is searchable once indexed;
    - a new version stops serving the old passages immediately, then serves the new ones;
    - disabled entries and archived documents are never retrieved;
    - a new document version replaces the quoted text.
  - **Failure handling:**
    - an image is reported "can't read";
    - a damaged PDF is failed with a reason;
    - an embedding outage keeps keyword search working and lists the source under *needs attention*;
    - an older-model index is flagged and re-indexed.
  - **Management:**
    - management scope: residents and the desk can't write; property vs organization-wide entries; buildings must belong to the property;
    - residents can open entries meant for them only, without version history;
    - the list combines entries and documents within scope;
    - re-index-all queues only the manager's sources.
  - **Assistant:**
    - a cited answer with the $250 deposit and a section link;
    - "not covered";
    - no staff text or badges for a resident;
    - a policy line on a prepared booking and a procedure line on an emergency work order.
  - **Tenant isolation:**
    - extended to the four new tables;
    - another organization's passages can't be planted, updated or deleted.
  - **Evaluation suite: now 28 cases, all passing with the demo model.** The 7 new cases:
    - a cited party-room answer;
    - "not covered";
    - a staff procedure for the desk;
    - a staff procedure hidden from a resident;
    - owners-only bylaws hidden from a tenant;
    - bylaws cited for an owner;
    - no cross-organization answers.
- **E2E: 53** Playwright runs (+6):
  - a resident's cited answer whose citation opens the entry;
  - a resident gets no staff procedure and no knowledge base page;
  - a manager writes an entry, it's indexed, *Try a question* finds it, then disabling removes it from results;
  - a document page shows its index status;
  - a resident asks a rules question on a phone, desktop and mobile, with no horizontal scroll.
- **Production build:** `next build` is clean, and the standalone output includes the PDF and Word readers. Under `next start`:
  - a resident's question was answered from the knowledge base with citations;
  - a manager re-indexed a seeded PDF, and the server re-read it within a second;
  - *Try a question* found the house rules.

## Bugs found and fixed during the iteration

- **"Are dogs allowed?" quoted the moving rules**, because "allowed" matched. Words every rule contains ("allowed", "policy", "rules"…) no longer count as matches.
- **The demo embedder let an unrelated tenancy agreement through** on chance feature overlap. A passage sharing no words with the question now needs a much higher similarity. The embedder's version was bumped, which exercised the stale-model flag.
- **Numbered house rules were quoted as one block.** Lists are now quoted item by item ("Barbecues: propane only, rooftop terrace only.").
- **Word lists had blank lines between items.**
- **Damaged PDFs were retried three times.** They're now failed once with a reason.
- **A made-up word could return an unrelated passage.** The offline embedder's hashed features collide by chance: about one made-up word in 25 scored above the similarity floor against the demo passages. It showed up as an intermittent integration-test failure. With that embedder, similarity now only re-ranks passages that share a word with the question. A test finds a colliding word on purpose and checks nothing comes back.
- **The development server ran out of memory during the full E2E run.** The PDF and Word readers were bundled into every route that uses the shared form helper. They now load from `node_modules` (`serverExternalPackages`); the full run peaked at about 4.2 GB and passed.
- **One assistant E2E check was timing-dependent.** It could match both the finished step and the live status line; it now matches the step exactly.

## Known issues / limits

- **No text recognition (OCR):** scanned PDFs and images can't be read, and spreadsheets and slides aren't indexed. They're listed as "can't read".
- **Meaning-based search needs a provider key.** The offline embedder is demo quality. The Voyage and OpenAI adapters are tested against mocked responses only; this environment can't reach them.
- **Demo answers are quotes, not summaries.** Combining several sources into one explanation needs a language model.
- **Audience is per source**, not per section. Split staff-only material into its own entry.
- **Indexing runs in the app process** (request hook + worker), one source at a time. Very large documents (up to 25 MB) take a while, and the only progress shown is the status.
- **Local development without Docker** needs the migration role to be allowed to create the pgvector extension (or the extension created once beforehand). The README covers both.
- **The development server is memory-hungry:** about 4 GB by the end of the full E2E run, because it compiles every route. Production uses far less.
- **Carried over:** single-instance rate limiting, untested Docker in this environment, no voice input.
