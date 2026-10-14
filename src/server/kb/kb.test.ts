import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { chunkContext, chunkText, embeddingText, estimateTokens, headingOf, MAX_TOKENS } from "./chunk";
import { docxHtmlToText, extractText } from "./extract";
import { EmbeddingError, hashEmbed, OpenAIEmbedder, resolveEmbeddings, searchGroups, stem, terms, VoyageEmbedder } from "./embeddings";
import { bestSentences, citationLabel } from "./retrieve";
import { EMBEDDING_DIMENSIONS } from "../db/schema";
import { OFFICE } from "../files/sniff";
import { makePdf } from "../../../scripts/lib-pdf";

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("headings", () => {
  it("recognises the ways documents introduce a section", () => {
    expect(headingOf("## Fees and deposit")).toEqual({ level: 2, text: "Fees and deposit" });
    expect(headingOf("2.3 Booking the room")).toEqual({ level: 3, text: "2.3 Booking the room" });
    expect(headingOf("PARKING AND STORAGE")).toEqual({ level: 2, text: "Parking And Storage" });
    expect(headingOf("Moving in:")).toEqual({ level: 3, text: "Moving in" });
    expect(headingOf("Part 7 - Use of common property")).toMatchObject({ level: 2 });
  });
  it("doesn't mistake sentences or list items for headings", () => {
    expect(headingOf("Book in the app at least 48 hours ahead.")).toBeNull();
    expect(headingOf("2. Book the service elevator for moves at least 48 hours ahead.")).toBeNull();
    expect(headingOf("NO.")).toBeNull();
    expect(headingOf("A".repeat(90))).toBeNull();
  });
});

describe("chunking", () => {
  it("follows sections, keeps the heading path and the page", () => {
    const chunks = chunkText([
      { page: 1, text: "# Amenities\nIntro line.\n\n## Party room\nBook 48 hours ahead.\n\n## Gym\nOpen 5 am to 11 pm." },
      { page: 2, text: "Still about the gym on page two." },
    ]);
    expect(chunks.map((c) => [c.heading, c.page, c.content])).toEqual([
      ["Amenities", 1, "Intro line."],
      ["Amenities › Party room", 1, "Book 48 hours ahead."],
      ["Amenities › Gym", 1, "Open 5 am to 11 pm."],
      ["Amenities › Gym", 2, "Still about the gym on page two."], // the section continues across the page break
    ]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);
  });
  it("keeps list items as separate lines and splits long text under the token limit, with overlap", () => {
    const rules = chunkText([{ page: null, text: "Rules:\n1. Quiet hours 11 pm to 7 am.\n2. Pets on a leash.\n- No smoking." }]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ heading: "Rules", content: "1. Quiet hours 11 pm to 7 am.\n2. Pets on a leash.\n- No smoking." });

    const para = (n: number) => `Paragraph ${n} ${"word ".repeat(90).trim()}.`;
    const long = chunkText([{ page: null, text: Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n") }]);
    expect(long.length).toBeGreaterThan(2);
    for (const c of long) expect(c.tokenCount).toBeLessThanOrEqual(MAX_TOKENS);
    // a passage starts with the previous one's last paragraph when that fits in the overlap
    const short = (n: number) => `Rule ${n} ${"text ".repeat(28).trim()}.`; // ~40 tokens
    const small = chunkText([{ page: null, text: [1, 2, 3, 4].map(short).join("\n\n") }], { maxTokens: 100, overlapTokens: 60 });
    expect(small.map((c) => c.content.split("\n").map((l) => l.slice(0, 6)))).toEqual([["Rule 1", "Rule 2"], ["Rule 2", "Rule 3"], ["Rule 3", "Rule 4"]]);
  });
  it("splits a single huge paragraph at sentences, then words", () => {
    const sentences = Array.from({ length: 80 }, (_, i) => `Sentence ${i} has a handful of words in it.`).join(" ");
    const out = chunkText([{ page: null, text: sentences }]);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((c) => c.tokenCount <= MAX_TOKENS && /\.$/.test(c.content))).toBe(true);
    const words = chunkText([{ page: null, text: "word ".repeat(1200) }]);
    expect(words.every((c) => c.tokenCount <= MAX_TOKENS)).toBe(true);
  });
  it("returns nothing for empty text and labels context for search and citations", () => {
    expect(chunkText([{ page: null, text: " \n\n " }])).toEqual([]);
    expect(estimateTokens("one two three")).toBe(4);
    expect(chunkContext("House rules", "Pets")).toBe("House rules › Pets");
    expect(chunkContext("House rules", null)).toBe("House rules");
    expect(embeddingText("House rules", { heading: "Pets", content: "Leash in common areas." })).toBe("House rules › Pets\n\nLeash in common areas.");
  });
});

describe("text extraction", () => {
  it("reads text, keeps PDF pages, and reads Word documents with their headings", async () => {
    const txt = await extractText(new TextEncoder().encode("Quiet hours are 11 pm."), "text/plain; charset=utf-8");
    expect(txt).toEqual({ kind: "text", pages: [{ page: null, text: "Quiet hours are 11 pm." }] });

    const pdf = await extractText(makePdf("House rules", ["1. Quiet hours are 11 pm to 7 am.", "2. Pets must be leashed."]), "application/pdf");
    expect(pdf.kind).toBe("text");
    if (pdf.kind === "text") {
      expect(pdf.pages[0].page).toBe(1);
      expect(pdf.pages[0].text).toContain("Quiet hours are 11 pm to 7 am.");
      expect(pdf.pages[0].text).toContain("Pets must be leashed.");
    }

    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Moving in</w:t></w:r></w:p>
      <w:p><w:r><w:t>Book the elevator 48 hours ahead &amp; pad it.</w:t></w:r></w:p></w:body></w:document>`);
    const docx = await extractText(new Uint8Array(await zip.generateAsync({ type: "uint8array" })), OFFICE.docx);
    expect(docx).toEqual({ kind: "text", pages: [{ page: null, text: "# Moving in\nBook the elevator 48 hours ahead & pad it." }] });
  });
  it("reports what it can't read instead of guessing", async () => {
    expect(await extractText(new Uint8Array([137, 80, 78, 71]), "image/png")).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/Images/) });
    expect(await extractText(new Uint8Array(4), OFFICE.xlsx)).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/Spreadsheets/) });
    expect(await extractText(new Uint8Array(4), "application/zip")).toMatchObject({ kind: "unsupported" });
    expect(await extractText(new Uint8Array(26 * 1024 * 1024), "text/plain")).toMatchObject({ kind: "unsupported", reason: expect.stringMatching(/25 MB/) });
  });
  it("turns Word HTML into text with markdown headings and list items", () => {
    expect(docxHtmlToText("<h2>Fees</h2><p>Deposit &amp; fee: $250&nbsp;total</p><ul><li>Cash</li><li>Card</li></ul>")).toBe("## Fees\nDeposit & fee: $250 total\n\n- Cash\n- Card");
    expect(chunkText([{ page: null, text: docxHtmlToText("<h2>Fees</h2><p>Deposit $250.</p>") }])[0]).toMatchObject({ heading: "Fees", content: "Deposit $250." });
  });
});

describe("local embedder and query terms", () => {
  it("stems, drops grammar and rule words, and adds everyday equivalents", () => {
    expect(["bookings", "booking", "booked", "parties", "boxes", "glass"].map(stem)).toEqual(["booking", "book", "book", "party", "box", "glass"]);
    expect(terms("Are dogs allowed in the gym?")).toEqual(["dog", "pet", "gym", "fitness"]);
    expect(searchGroups("Are dogs allowed?")).toEqual(["dogs pet"]);
    expect(searchGroups("What is the policy on hot tubs?")).toEqual(["hot", "tubs"]);
    expect(searchGroups("What are the rules for booking the party room?")).toEqual(["booking book", "party", "room"]);
  });
  it("is deterministic, normalised, and closer for related text", () => {
    const a = hashEmbed("Party room booking: fee and deposit")!;
    const b = hashEmbed("How much is the deposit for the party room?")!;
    const c = hashEmbed("Recycling goes to the P1 room on Tuesdays")!;
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(hashEmbed("Party room booking: fee and deposit")).toEqual(a);
    expect(Math.abs(cosine(a, a) - 1)).toBeLessThan(1e-9);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    expect(hashEmbed("the and of")).toBeNull(); // nothing to embed
  });
});

describe("embedding providers", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("are chosen from the environment, falling back to the local embedder with a reason", () => {
    expect(resolveEmbeddings({})).toMatchObject({ model: { id: "local/hash-v2", demo: true }, reason: "no embedding provider key is configured" });
    expect(resolveEmbeddings({ VOYAGE_API_KEY: "k" }).model).toMatchObject({ id: "voyage/voyage-3.5-lite", demo: false });
    expect(resolveEmbeddings({ OPENAI_API_KEY: "k" }).model).toMatchObject({ id: "openai/text-embedding-3-small" });
    expect(resolveEmbeddings({ EMBEDDING_PROVIDER: "openai-compatible", EMBEDDING_BASE_URL: "http://localhost:11434/v1", EMBEDDING_MODEL: "nomic" }).model.id).toBe("openai-compatible/nomic");
    expect(resolveEmbeddings({ EMBEDDING_PROVIDER: "openai-compatible" }).reason).toMatch(/EMBEDDING_BASE_URL or EMBEDDING_MODEL/);
    expect(resolveEmbeddings({ EMBEDDING_PROVIDER: "voyage" }).reason).toMatch(/no VOYAGE_API_KEY/);
    expect(resolveEmbeddings({ EMBEDDING_PROVIDER: "local", OPENAI_API_KEY: "k" }).model.id).toBe("local/hash-v2");
  });
  it("ask for the index's dimensions, order results, and retry a server error once", async () => {
    const vec = (x: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, () => x);
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (fail) {
        fail = false;
        return new Response("busy", { status: 503 });
      }
      return Response.json({ data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }] });
    }));
    const out = await new OpenAIEmbedder("openai", "text-embedding-3-small", "k", "https://api.example.test/v1/").embed(["a", "b"], "document");
    expect(out.map((v) => v![0])).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ url: "https://api.example.test/v1/embeddings", body: { model: "text-embedding-3-small", input: ["a", "b"], dimensions: EMBEDDING_DIMENSIONS } });

    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      calls.push({ url: _u, body: JSON.parse(String(init.body)) });
      return Response.json({ data: [{ index: 0, embedding: vec(1) }] });
    }));
    await new VoyageEmbedder("voyage-3.5-lite", "k").embed(["q"], "query");
    expect(calls.at(-1)!.body).toMatchObject({ input_type: "query", output_dimension: EMBEDDING_DIMENSIONS });
  });
  it("refuse a model with the wrong vector size or a broken response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [{ index: 0, embedding: [0.1, 0.2] }] })));
    await expect(new OpenAIEmbedder("openai-compatible", "tiny", undefined, "http://x.test").embed(["a"], "document")).rejects.toThrow(/2-dimensional.*512/);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nope: true })));
    await expect(new OpenAIEmbedder("openai-compatible", "m", undefined, "http://x.test").embed(["a"], "document")).rejects.toBeInstanceOf(EmbeddingError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    await expect(new VoyageEmbedder("v", "k").embed(["a"], "query")).rejects.toThrow(/\(401\)/);
  });
});

describe("quotes and citations", () => {
  it("quotes the sentences that answer the question, with a list's lead-in", () => {
    const rules = "1. Quiet hours are 11 pm to 7 am.\n2. Book the service elevator for moves.\n3. Barbecues: propane only, rooftop terrace only.\n4. Pets must be leashed in common areas.";
    expect(bestSentences(rules, "Can I have a barbecue on my balcony?")).toEqual(["Barbecues: propane only, rooftop terrace only."]);
    expect(bestSentences(rules, "Are dogs allowed?")).toEqual(["Pets must be leashed in common areas."]);
    const emergency = "Call the emergency line instead of filing a request when:\n- water is leaking and you can't stop it,\n- there is no heat in winter.";
    expect(bestSentences(emergency, "Water leaking from my ceiling")).toEqual(["Call the emergency line instead of filing a request when:", "water is leaking and you can't stop it,"]);
  });
  it("quotes a short paragraph whole only when it's on topic", () => {
    expect(bestSentences("The fee is $50 and the deposit is $250.", "party room deposit")).toEqual(["The fee is $50 and the deposit is $250."]);
    expect(bestSentences("Tenant: Emma Tremblay. Term: 12 months.", "water leak at night")).toEqual([]);
  });
  it("labels a citation with its section and page", () => {
    expect(citationLabel({ title: "Party room rules", heading: "Amenities › Fees", page: null })).toBe("Party room rules · § Fees");
    expect(citationLabel({ title: "House rules", heading: null, page: 2 })).toBe("House rules · p. 2");
  });
});
