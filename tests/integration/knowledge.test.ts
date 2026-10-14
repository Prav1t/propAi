import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { searchKnowledge, type Passage } from "@/server/kb/retrieve";
import { processIndexQueue } from "@/server/kb/indexer";
import { createEntry, entrySchema, getEntry, kbStats, listKnowledgeBase, reindex, setEntryStatus, updateEntry } from "@/server/kb/knowledge";
import { setEmbeddingModelForTests, hashEmbed, LocalHashEmbedder, type EmbeddingModel } from "@/server/kb/embeddings";
import { addDocumentVersion, createDocument, documentSchema, setDocumentArchived } from "@/server/modules/documents/service";
import { runAssistantTurn, type AssistantEvent } from "@/server/ai/orchestrator";
import { setChatModelForTests } from "@/server/ai/providers";
import { DemoModel } from "@/server/ai/providers/demo";
import { resolveAiConfig, setAiConfigForTests } from "@/server/ai/config";
import { loadPrincipal } from "@/server/modules/organizations/principal";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { ValidationError, type TenantCtx } from "@/server/modules/context";
import { closeDb } from "@/server/db/client";
import { makePdf } from "../../scripts/lib-pdf";
import { asApp, orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";

const meta = { ip: "203.0.113.40", userAgent: "vitest", requestId: "kb" };
async function ctxFor(email: string, slug = "pacific-properties"): Promise<TenantCtx> {
  const p = await loadPrincipal(await userIdByEmail(email), slug);
  if (!p) throw new Error(`${email} not in ${slug}`);
  return { principal: p, meta };
}
const pdfFile = (name: string, title: string, lines: string[]) => new File([makePdf(title, lines) as BlobPart], name, { type: "application/pdf" });
const search = (ctx: TenantCtx, query: string, opts: { propertyId?: string } = {}) => searchKnowledge(ctx, { query, limit: 10, ...opts }).then((r) => r.passages);
const titles = (ps: Passage[]) => [...new Set(ps.map((p) => p.title))];
const q = async (sql: string, params: unknown[] = []) => (await ownerPool.query(sql, params)).rows;
const entry = (over: Record<string, string> = {}) => entrySchema.parse({ title: "Test entry", body: "Bike storage is in P2. Register your bike with the front desk to get a tag.", category: "rules", audience: "residents", propertyId: ids.FRT, ...over });
const docInput = (over: Record<string, string> = {}) => documentSchema.parse({ title: "Test doc", category: "rules", audience: "residents", propertyId: ids.FRT, ...over });
const word = () => `zq${Math.random().toString(36).slice(2, 8)}`; // a word no other passage contains

let pm: TenantCtx, admin: TenantCtx, emma: TenantCtx, noah: TenantCtx, concierge: TenantCtx, vendor: TenantCtx, ns: TenantCtx;
const ids: Record<string, string> = {};

beforeAll(async () => {
  [pm, admin, emma, noah, concierge, vendor, ns] = await Promise.all([
    ctxFor("pm@demo.test"), ctxFor("admin@demo.test"), ctxFor("resident@demo.test"), ctxFor("owner@demo.test"), ctxFor("concierge@demo.test"),
    ctxFor("vendor@demo.test"), ctxFor("admin@northshore.test", "northshore-strata"),
  ]);
  for (const r of await q("select code, id from properties")) ids[r.code] = r.id;
  for (const r of await q("select b.id, p.code, b.code bcode from buildings b join properties p on p.id = b.property_id")) ids[`${r.code}-${r.bcode}`] = r.id;
  setAiConfigForTests({ ...resolveAiConfig({}), requestsPerMinute: 1000 });
});
afterEach(() => setEmbeddingModelForTests(undefined));
afterAll(async () => {
  setChatModelForTests(undefined);
  setAiConfigForTests(undefined);
  await ownerPool.end();
  await closeDb();
});

describe("the seeded knowledge base", () => {
  it("indexes every seeded document and entry with the local embedder", async () => {
    // sources the seed created (other test files add documents of their own, which stay queued)
    const SEEDED = ["2026 AGM minutes", "After-hours flood response — Fraser Towers", "Amenity booking policy", "Entering a resident's unit", "Fire safety plan", "Fraser Towers house rules",
      "Guest lounge rules", "Harbour Centre gym and meeting room", "Harbour Centre house rules", "Lonsdale bylaws", "Moving in and out of Fraser Towers", "Party room booking rules",
      "Property insurance certificate", "Resident privacy notice", "Strata bylaws (consolidated)", "Tenancy agreement — Unit 1204", "Water shut-off procedure", "What counts as a maintenance emergency"];
    const rows = await q(`select coalesce(d.title, e.title) title, s.status, s.chunk_count, s.embedding_model from kb_sources s
      left join documents d on d.id = s.document_id left join knowledge_entries e on e.id = s.entry_id where coalesce(d.title, e.title) = any($1)`, [SEEDED]);
    expect(rows).toHaveLength(SEEDED.length);
    for (const r of rows) expect(r).toMatchObject({ status: "indexed", embedding_model: "local/hash-v2" });
    const [chunks] = await q("select count(*)::int n, count(embedding)::int embedded, count(distinct org_id)::int orgs from kb_chunks");
    expect(chunks.n).toBeGreaterThan(20);
    expect(chunks.embedded).toBe(chunks.n);
    expect(chunks.orgs).toBe(2);
  });
});

describe("retrieval only returns what the reader may read", () => {
  it("staff-only procedures reach the front desk at their property, never residents", async () => {
    const desk = await search(concierge, "Where are the Tower B riser valves?");
    expect(desk[0]).toMatchObject({ title: "After-hours flood response — Fraser Towers", audience: "staff", sourceType: "knowledge" });
    expect(desk[0].content).toMatch(/west wall/);
    expect(desk[0].href).toMatch(/^\/o\/pacific-properties\/knowledge\/[0-9a-f-]{36}$/);
    const tenant = await search(emma, "Where are the Tower B riser valves?");
    expect(tenant.every((p) => p.audience !== "staff")).toBe(true);
    expect(tenant.map((p) => p.content).join(" ")).not.toMatch(/west wall|east wall/);
  });
  it("a property-scoped role doesn't get another property's staff material", async () => {
    expect(titles(await search(pm, "main water valve shut-off"))).toContain("Water shut-off procedure"); // Harbour Centre, staff
    expect(titles(await search(concierge, "main water valve shut-off"))).not.toContain("Water shut-off procedure"); // Fraser Towers only
  });
  it("owners-only documents reach owners, not tenants", async () => {
    expect(titles(await search(noah, "amenity rooms restricted council resolution"))).toContain("Strata bylaws (consolidated)");
    expect(titles(await search(emma, "amenity rooms restricted council resolution"))).not.toContain("Strata bylaws (consolidated)");
    expect(titles(await search(emma, "theatre room owners resolution"))).not.toContain("2026 AGM minutes");
  });
  it("never crosses organizations, in the service or in the database", async () => {
    expect(titles(await search(ns, "guest lounge noise cleaning"))).toEqual(["Guest lounge rules"]);
    expect(titles(await search(admin, "guest lounge noise cleaning"))).not.toContain("Guest lounge rules");
    expect(titles(await search(ns, "party room deposit fee"))).not.toContain("Party room booking rules");
    const A = await orgIdBySlug("pacific-properties");
    const B = await orgIdBySlug("northshore-strata");
    await asApp({ orgId: A, userId: admin.principal.userId }, async (sql) => {
      expect((await sql("select count(*)::int n from kb_chunks where org_id = $1", [B])).rows[0].n).toBe(0);
      expect((await sql("select count(*)::int n from knowledge_entries where org_id = $1", [B])).rows[0].n).toBe(0);
    });
  });
  it("a place narrows results to that property plus organization-wide material", async () => {
    const hbc = await search(pm, "quiet hours", { propertyId: ids.HBC });
    expect(hbc.length).toBeGreaterThan(0);
    expect(hbc.every((p) => p.propertyName === "Harbour Centre" || p.propertyName === null)).toBe(true);
    const all = await search(pm, "quiet hours");
    expect(titles(all)).toEqual(expect.arrayContaining(["Fraser Towers house rules", "Harbour Centre house rules"]));
  });
  it("says nothing when nothing is relevant, and refuses roles without document access", async () => {
    expect(await search(emma, "hot tubs")).toEqual([]);
    await expect(searchKnowledge(vendor, { query: "party room" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(searchKnowledge(emma, { query: "x" })).rejects.toBeInstanceOf(ValidationError);
  });
  it("never returns a passage for a made-up word, even one whose hashed features collide with a passage", async () => {
    // the offline embedder's hashed features collide by chance: find a made-up word that scores high against a
    // passage emma can see, then check retrieval still returns nothing for it (it shares no word with anything)
    const rows = await q(`select k.embedding::text as e from kb_chunks k join knowledge_entries e on e.id = k.entry_id
      where e.title = 'Party room booking rules' and k.embedding_model = 'local/hash-v2'`);
    const vecs = rows.map((r) => JSON.parse(r.e) as number[]);
    const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
    let collider = "";
    for (let i = 0; i < 200_000 && !collider; i++) {
      const w = word();
      const v = hashEmbed(w)!;
      if (vecs.some((e) => dot(e, v) >= 0.35)) collider = w;
    }
    expect(collider).not.toBe("");
    expect(await search(emma, collider)).toEqual([]);
    expect(await search(pm, collider)).toEqual([]);
    // and a handful of ordinary made-up words
    for (let i = 0; i < 20; i++) expect(await search(emma, word())).toEqual([]);
  });
});

describe("indexing follows the source's life", () => {
  it("a new entry is searchable once indexed; a new version replaces the old passages", async () => {
    const w = word();
    const e = await createEntry(pm, entry({ title: `Bike room ${w}`, body: `The bike room is in P2. Tags cost $10 — ask about ${w}.` }));
    expect((await getEntry(pm, e.id)).index).toMatchObject({ status: "queued" });
    expect(await search(emma, w)).toEqual([]); // queued, not yet indexed
    await processIndexQueue(100);
    const hit = await search(emma, w);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ title: `Bike room ${w}`, version: 1, sourceType: "knowledge" });

    const w2 = word();
    await updateEntry(pm, e.id, entry({ title: `Bike room ${w}`, body: `The bike room moved to P1. Tags are free now — ${w2}.`, notes: "Moved" }));
    // until re-indexed the old version's passages are no longer served
    expect(await search(emma, w)).toEqual([]);
    await processIndexQueue(100);
    expect(await search(emma, `tags ${w}`)).toHaveLength(1); // the title still carries the first word
    const now = await search(emma, w2);
    expect(now[0]).toMatchObject({ version: 2 });
    expect(now[0].content).toMatch(/moved to P1/);
    const d = await getEntry(pm, e.id);
    expect(d.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(d.index).toMatchObject({ status: "indexed", indexedVersion: 2, chunkCount: 1 });
    const audit = await q("select action from audit_logs where entity_id = $1 order by created_at", [e.id]);
    expect(audit.map((a) => a.action)).toEqual(["knowledge.created", "knowledge.updated"]);
  });
  it("disabled entries and archived documents are never retrieved", async () => {
    const w = word();
    const e = await createEntry(pm, entry({ title: `Locker rules ${w}`, body: `Storage lockers are assigned by the office. ${w} applies to all lockers.` }));
    await processIndexQueue(100);
    expect(await search(emma, w)).toHaveLength(1);
    await setEntryStatus(pm, e.id, "disabled");
    expect(await search(emma, w)).toEqual([]);
    expect(await search(pm, w)).toEqual([]); // nobody, not even managers
    await setEntryStatus(pm, e.id, "active");
    expect(await search(emma, w)).toHaveLength(1);

    const dw = word();
    const doc = await createDocument(pm, docInput({ title: `Gym etiquette ${dw}` }), pdfFile("gym.pdf", `Gym etiquette ${dw}`, [`Wipe the machines after use. ${dw} towels are provided.`]));
    await processIndexQueue(100);
    const found = await search(emma, dw);
    expect(found[0]).toMatchObject({ sourceType: "document", page: 1, href: `/o/pacific-properties/documents/${doc.id}` });
    await setDocumentArchived(pm, doc.id, true);
    expect(await search(emma, dw)).toEqual([]);
  });
  it("a new document version replaces what the assistant quotes", async () => {
    const w = word();
    const doc = await createDocument(pm, docInput({ title: `Pool hours ${w}` }), pdfFile("pool.pdf", "Pool hours", [`The pool opens at 7 am. ${w}`]));
    await processIndexQueue(100);
    expect((await search(emma, w))[0].content).toMatch(/7 am/);
    await addDocumentVersion(pm, doc.id, pdfFile("pool-2.pdf", "Pool hours", [`The pool opens at 6 am from now on. ${w}`]), "Earlier opening");
    await processIndexQueue(100);
    const hits = await search(emma, w);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ version: 2 });
    expect(hits[0].content).toMatch(/6 am/);
  });
  it("reports files it can't read, and keeps keyword search when embedding fails", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const img = await createDocument(pm, docInput({ title: "Floor plan scan" }), new File([png as BlobPart], "plan.png", { type: "image/png" }));
    const broken = await createDocument(pm, docInput({ title: "Corrupt minutes" }), new File([new TextEncoder().encode("%PDF-1.4\n% not really\n%%EOF\n") as BlobPart], "bad.pdf", { type: "application/pdf" }));
    const w = word();
    const failing: EmbeddingModel = { provider: "test", model: "down", id: "test/down", demo: false, minSimilarity: 0.3, embed: async () => { throw new Error("service down"); } };
    setEmbeddingModelForTests(failing);
    const e = await createEntry(pm, entry({ title: `Parcel lockers ${w}`, body: `Parcel lockers are next to the mailroom. ${w} codes expire in 3 days.` }));
    await processIndexQueue(100);
    const sources = await q("select coalesce(d.title, e.title) title, s.status, s.error, s.chunk_count from kb_sources s left join documents d on d.id = s.document_id left join knowledge_entries e on e.id = s.entry_id where s.document_id = any($1) or s.entry_id = $2",
      [[img.id, broken.id], e.id]);
    const by = Object.fromEntries(sources.map((r) => [r.title, r]));
    expect(by["Floor plan scan"]).toMatchObject({ status: "unsupported", chunk_count: 0, error: expect.stringMatching(/Images aren't read/) });
    expect(by["Corrupt minutes"]).toMatchObject({ status: "failed", error: expect.stringMatching(/couldn't be read/) });
    expect(by[`Parcel lockers ${w}`]).toMatchObject({ status: "failed", chunk_count: 1, error: expect.stringMatching(/only keyword search covers this source/) });
    // passages without a vector are still found by their words
    expect(await search(emma, `${w} parcel lockers`)).toHaveLength(1);
    expect((await listKnowledgeBase(pm, { filter: "needs_attention" })).rows.map((r) => r.title)).toEqual(expect.arrayContaining(["Floor plan scan", "Corrupt minutes", `Parcel lockers ${w}`]));
  });
  it("flags passages from an older embedding model and re-indexes them on request", async () => {
    const other: EmbeddingModel = Object.assign(new LocalHashEmbedder(), { id: "local/hash-v9" });
    setEmbeddingModelForTests(other);
    const stats = await kbStats(pm);
    expect(stats.model).toBe("local/hash-v9");
    expect(stats.stale).toBeGreaterThan(0);
    const w = word();
    const e = await createEntry(pm, entry({ title: `Sauna ${w}`, body: `The sauna is closed on Mondays for cleaning. ${w}` }));
    await processIndexQueue(100);
    expect((await getEntry(pm, e.id)).index).toMatchObject({ embeddingModel: "local/hash-v9", stale: false });
    setEmbeddingModelForTests(undefined);
    expect((await getEntry(pm, e.id)).index).toMatchObject({ stale: true });
    expect(await reindex(pm, { entryId: e.id })).toBe(1);
    await processIndexQueue(100);
    expect((await getEntry(pm, e.id)).index).toMatchObject({ embeddingModel: "local/hash-v2", stale: false });
  });
});

describe("managing the knowledge base", () => {
  it("follows the same scope as documents", async () => {
    await expect(createEntry(emma, entry())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createEntry(concierge, entry())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createEntry(pm, entry({ propertyId: "" }))).rejects.toThrow(/organization-wide role/);
    await expect(createEntry(pm, entry({ propertyId: ids.PCH }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createEntry(pm, entry({ buildingId: ids["HBC-MAIN"] }))).rejects.toThrow(/isn't part of the property/);
    const orgWide = await createEntry(admin, entry({ title: "Org-wide note", propertyId: "" }));
    expect(orgWide.propertyId).toBeNull();
    await expect(updateEntry(pm, orgWide.id, entry({ propertyId: "" }))).rejects.toBeInstanceOf(ForbiddenError); // pm can read it but not manage it
    await expect(listKnowledgeBase(emma)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(kbStats(concierge)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("lets residents open entries meant for them, and nothing else", async () => {
    const [mine] = await q("select id from knowledge_entries where title = 'Party room booking rules'");
    const [staff] = await q("select id from knowledge_entries where title like 'After-hours flood response%'");
    const [other] = await q("select id from knowledge_entries where title = 'Guest lounge rules'");
    expect((await getEntry(emma, mine.id)).canManage).toBe(false);
    expect((await getEntry(emma, mine.id)).versions).toEqual([]); // history is for staff
    await expect(getEntry(emma, staff.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getEntry(pm, other.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getEntry(emma, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("lists entries and documents together, with index status, within the manager's scope", async () => {
    const pmRows = (await listKnowledgeBase(pm)).rows;
    expect(pmRows.find((r) => r.title === "Party room booking rules")).toMatchObject({ type: "knowledge", index: { status: "indexed" } });
    expect(pmRows.find((r) => r.title === "Fraser Towers house rules")).toMatchObject({ type: "document", index: { status: "indexed" } });
    expect(pmRows.some((r) => r.title === "Guest lounge rules")).toBe(false);
    const nsRows = (await listKnowledgeBase(ns)).rows.map((r) => r.title);
    expect(nsRows).toContain("Guest lounge rules");
    expect(nsRows).not.toContain("Party room booking rules");
    expect((await listKnowledgeBase(pm, { q: "party", filter: "entries" })).rows.map((r) => r.title)).toEqual(["Party room booking rules"]);
  });
  it("re-indexing everything queues only what the manager can manage", async () => {
    await processIndexQueue(200); // start from an empty queue
    const n = await reindex(pm, { all: true });
    const [{ queued }] = await q("select count(*)::int queued from kb_sources where status = 'queued'");
    expect(queued).toBe(n);
    const [{ nsQueued }] = await q("select count(*)::int \"nsQueued\" from kb_sources s join organizations o on o.id = s.org_id where o.slug = 'northshore-strata' and s.status = 'queued'");
    expect(nsQueued).toBe(0);
    await processIndexQueue(200);
    const [{ left }] = await q("select count(*)::int \"left\" from kb_sources where status in ('queued','indexing')");
    expect(left).toBe(0);
  });
});

describe("the assistant answers from passages, with citations", () => {
  async function ask(ctx: TenantCtx, message: string) {
    const events: AssistantEvent[] = [];
    for await (const ev of runAssistantTurn(ctx, { message })) events.push(ev);
    return {
      text: events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join(""),
      tools: events.filter((e) => e.type === "tool_end") as Extract<AssistantEvent, { type: "tool_end" }>[],
    };
  }
  it("quotes the rule and links its source", async () => {
    setChatModelForTests(new DemoModel());
    const r = await ask(emma, "What are the rules for booking the party room?");
    expect(r.tools[0]).toMatchObject({ tool: "search_knowledge", outcome: "ok" });
    expect(r.text).toMatch(/\$250/);
    expect(r.text).toMatch(/— \[Party room booking rules · § Approval, fee and deposit\]\(\/o\/pacific-properties\/knowledge\/[0-9a-f-]{36}\)/);
    expect(r.tools[0].display?.records?.map((c) => c.title)).toContain("Party room booking rules");
  });
  it("says when the documents don't cover a question, and never quotes a staff procedure to a resident", async () => {
    setChatModelForTests(new DemoModel());
    expect((await ask(emma, "What is the policy on hot tubs?")).text).toMatch(/^I couldn't find anything about that in the documents and knowledge base you can access/);
    const riser = await ask(emma, "Where are the Tower B riser valves?");
    expect(riser.text).not.toMatch(/west wall/);
    expect(riser.tools[0].display?.records?.some((c) => c.badges?.some((b) => b.label === "Staff only")) ?? false).toBe(false);
  });
  it("adds the matching policy to a prepared booking, and the procedure on file to an emergency", async () => {
    setChatModelForTests(new DemoModel());
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver" }).format(new Date(Date.now() + 60 * 86_400_000));
    const events: AssistantEvent[] = [];
    for await (const ev of runAssistantTurn(pm, { message: `Book the party room on ${day} at 10 am for unit 1204 in Tower A` })) events.push(ev);
    const plan = (events.find((e) => e.type === "plan") as Extract<AssistantEvent, { type: "plan" }> | undefined)?.plan;
    expect(plan?.steps[0].details.find((d) => d.startsWith("Policy:"))).toMatch(/^Policy: “.+” — (Party room booking rules|Amenity booking policy)/);

    const flood: AssistantEvent[] = [];
    for await (const ev of runAssistantTurn(pm, { message: "Create a work order: water is flooding from a burst pipe in the Tower B lobby, emergency" })) flood.push(ev);
    const wo = (flood.find((e) => e.type === "plan") as Extract<AssistantEvent, { type: "plan" }> | undefined)?.plan;
    expect(wo?.steps[0].details.find((d) => d.startsWith("Procedure on file:"))).toMatch(/After-hours flood response|maintenance emergency/);
  });
});
