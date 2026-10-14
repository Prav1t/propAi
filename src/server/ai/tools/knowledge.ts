import "server-only";
import { z } from "zod";
import { DOCUMENT_CATEGORIES } from "../../db/schema";
import { canUseDocuments, listDocuments } from "../../modules/documents/service";
import { bestSentences, canSearchKnowledge, citationLabel, POLICY_CATEGORIES, searchKnowledge, type Passage } from "../../kb/retrieve";
import { defineTool, ok, plural, type ToolOutput } from "./registry";
import { label, locationArg, placeFilter, where } from "./common";
import { isErr } from "./resolve";

// Retrieval tools: passages come from documents and knowledge-base entries this user may read (audience, place,
// current version, active), so a resident never receives a staff procedure. Every passage carries a citation link.

const PASSAGE_CHARS = 1200;

// "…at Harbour Centre": the place is a filter, so its words shouldn't also rank passages that merely mention it
function withoutPlace(question: string, location: string | undefined, resolved: boolean): string {
  if (!location || !resolved) return question;
  const cleaned = question.replace(new RegExp(`\\b(?:at|in|for|of)?\\s*(?:the\\s+)?${location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "ig"), " ").replace(/\s+/g, " ").trim();
  return cleaned.length >= 3 ? cleaned : question;
}

function passagesResult(question: string, passages: Passage[], scope: string, demo: boolean): ToolOutput {
  if (!passages.length) {
    return {
      result: ok(`Nothing in the documents and knowledge base you can access${scope} covers that.`, {
        count: 0, cite: true,
        note: "Say so plainly. Don't answer from general knowledge; suggest asking the management office or (for admins) adding it to the knowledge base.",
      }),
    };
  }
  const sources = new Map<string, Passage>();
  for (const p of passages) if (!sources.has(p.sourceId)) sources.set(p.sourceId, p);
  // the demo model quotes these lines verbatim; a language model gets the full passages to answer from
  const quotes = passages.slice(0, 3).map((p) => ({ p, lines: bestSentences(p.content, question) }))
    .filter((x, i) => i === 0 || x.lines.length)
    .map(({ p, lines }) => `> ${(lines.length ? lines : [p.content.split("\n")[0]]).join(" ")}\n\n— [${citationLabel(p)}](${p.href})`);
  return {
    result: ok(`Found ${plural(passages.length, "passage")} in ${plural(sources.size, "source")}${scope}.`, {
      count: passages.length,
      cite: true,
      items: passages.map((p, i) => ({
        ref: `[${i + 1}]`, source: p.title, section: p.heading, page: p.page, property: p.propertyName ?? "All properties", type: p.sourceType === "document" ? "document" : "knowledge base",
        audience: p.audience, href: p.href, text: p.content.length > PASSAGE_CHARS ? `${p.content.slice(0, PASSAGE_CHARS)}…` : p.content,
      })),
      highlights: [demo ? "Here's what your organization's documents say:" : "Relevant passages:", ...quotes],
      note: "Answer only from these passages and cite each fact as a markdown link to its source, e.g. [Amenity booking policy § Party Room](href). These are the organization's own documents, not legal advice.",
    }),
    display: {
      records: [...sources.values()].map((p) => ({
        ref: p.sourceType === "document" ? "Document" : "Knowledge base", title: p.title,
        sub: [p.heading?.split(" › ").pop(), p.page ? `p. ${p.page}` : null, p.propertyName ?? "All properties"].filter(Boolean).join(" · "),
        href: p.href, badges: [{ label: label(p.category), tone: "neutral" as const }, ...(p.audience === "staff" ? [{ label: "Staff only", tone: "warning" as const }] : p.audience === "owners" ? [{ label: "Owners", tone: "accent" as const }] : [])],
      })),
    },
  };
}

export const searchKnowledgeTool = defineTool({
  name: "search_knowledge",
  title: "Searching your documents",
  description:
    "Search the organization's documents and knowledge base (rules, policies, bylaws, procedures, building information) for passages that answer a question. " +
    "Use this for any question about rules, fees, deposits, what is allowed, how to do something, or what to do in a situation. Answer only from the returned passages and cite them.",
  input: z.object({
    question: z.string().trim().min(3).max(500).describe("The user's question in their words."),
    location: locationArg,
  }),
  available: canSearchKnowledge,
  riskClass: 1,
  async execute(ctx, a) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const question = withoutPlace(a.question, a.location, !!pf.place);
    const r = await searchKnowledge(ctx, { query: question, propertyId: pf.propertyId ?? null, buildingId: pf.buildingId ?? null, limit: 5 });
    return passagesResult(question, r.passages, where(pf.place), r.demo);
  },
});

export const retrievePolicyTool = defineTool({
  name: "retrieve_policy",
  title: "Checking building policies",
  description: "Find the policy, rule, bylaw or procedure that applies to a topic (e.g. 'party room booking', 'pets', 'move-in', 'flood after hours'), optionally at a property or building.",
  input: z.object({
    topic: z.string().trim().min(2).max(200),
    location: locationArg,
  }),
  available: canSearchKnowledge,
  riskClass: 1,
  async execute(ctx, a) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const topic = withoutPlace(a.topic, a.location, !!pf.place);
    const r = await searchKnowledge(ctx, { query: topic, propertyId: pf.propertyId ?? null, buildingId: pf.buildingId ?? null, categories: POLICY_CATEGORIES, limit: 3 });
    return passagesResult(topic, r.passages, where(pf.place), r.demo);
  },
});

export const searchDocumentsTool = defineTool({
  name: "search_documents",
  title: "Looking up documents",
  description: "List documents (by title words, category, place) the user can open — e.g. 'the insurance certificate', 'AGM minutes'. Returns titles and links, not their contents; use search_knowledge for what they say.",
  input: z.object({
    q: z.string().trim().max(120).optional().describe("Words from the title."),
    category: z.enum(DOCUMENT_CATEGORIES).optional(),
    location: locationArg,
  }),
  available: canUseDocuments,
  riskClass: 1,
  async execute(ctx, a, env) {
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return { result: pf };
    const page = await listDocuments(ctx, { q: a.q, category: a.category, propertyId: pf.propertyId, pageSize: 10 });
    const items = page.rows.map((d) => ({ ref: d.title, category: d.category, audience: d.audience, property: d.propertyName ?? "All properties", version: d.currentVersion, updated: d.updatedAt.toISOString().slice(0, 10), href: env.href(`/documents/${d.id}`) }));
    return {
      result: ok(page.total ? `${plural(page.total, "document")}${where(pf.place)}${a.category ? ` in ${label(a.category).toLowerCase()}` : ""}.` : `No documents match${where(pf.place)}.`, {
        count: page.total, items, highlights: page.rows.map((d) => `[${d.title}](${env.href(`/documents/${d.id}`)}) — ${label(d.category)}${d.propertyName ? ` · ${d.propertyName}` : ""}`),
      }),
      display: { records: page.rows.map((d) => ({ ref: label(d.category), title: d.title, sub: [d.propertyName ?? "All properties", `version ${d.currentVersion}`].join(" · "), href: env.href(`/documents/${d.id}`) })) },
    };
  },
});
