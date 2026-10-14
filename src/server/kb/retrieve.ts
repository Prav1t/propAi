import "server-only";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { documents, kbChunks, kbSources, knowledgeEntries, properties } from "../db/schema";
import { ForbiddenError, type Principal } from "../authz/authorize";
import { tenantTx, ValidationError, type TenantCtx } from "../modules/context";
import { documentVisibleWhere } from "../modules/documents/access";
import { log } from "../log";
import { knowledgeVisibleWhere } from "./knowledge";
import { embeddings, searchGroups, terms } from "./embeddings";

// Permission-aware hybrid retrieval. Every candidate passage is filtered BEFORE ranking by: the organization (RLS),
// the reader's audience and place (the same rules as the Documents page), the source being active, and the passage
// belonging to the source's current version. Meaning (vector) and words (full text) are ranked separately and fused.

export type Passage = {
  chunkId: string;
  sourceType: "document" | "knowledge";
  sourceId: string;
  title: string;
  heading: string | null;
  page: number | null;
  content: string;
  href: string;
  propertyName: string | null;
  category: string;
  audience: string;
  version: number;
  score: number; // fused rank score (higher is better)
  similarity: number | null; // cosine similarity, when meaning-based search ran
  matchedTerms: number; // how many of the question's words the passage contains
};

export type Retrieval = { passages: Passage[]; model: string; demo: boolean; vector: boolean; terms: string[] };

// document categories and knowledge categories that hold rules people ask about
export const POLICY_CATEGORIES = ["rules", "policy", "bylaws", "manual", "procedures", "emergency", "amenities", "moving", "parking", "maintenance"];

export const canSearchKnowledge = (p: Principal) => p.permissions.has("document.read") || p.permissions.has("document.manage") || p.permissions.has("knowledge.manage");

const RRF_K = 60;
const CANDIDATES = 40;
const MAX_PER_SOURCE = 3;

export async function searchKnowledge(ctx: TenantCtx, input: { query: string; propertyId?: string | null; buildingId?: string | null; categories?: string[]; limit?: number }): Promise<Retrieval> {
  const p = ctx.principal;
  if (!canSearchKnowledge(p)) throw new ForbiddenError();
  const query = input.query.trim();
  if (query.length < 2) throw new ValidationError("Ask a longer question.");
  if (query.length > 500) throw new ValidationError("Keep the question under 500 characters.");
  const limit = Math.min(10, Math.max(1, input.limit ?? 5));
  const { model } = embeddings();

  let qvec: number[] | null = null;
  try {
    [qvec] = await model.embed([query], "query");
  } catch (e) {
    log.error("kb.query_embed_failed", { err: e }); // keyword search still runs
  }

  const placeProp = sql`coalesce(${documents.propertyId}, ${knowledgeEntries.propertyId})`;
  const placeBld = sql`coalesce(${documents.buildingId}, ${knowledgeEntries.buildingId})`;
  const visible: SQL = and(
    eq(kbChunks.orgId, p.orgId),
    or(
      and(sql`${kbChunks.documentId} is not null`, eq(documents.status, "active"), sql`${kbChunks.version} = ${documents.currentVersion}`, documentVisibleWhere(p)),
      and(sql`${kbChunks.entryId} is not null`, eq(knowledgeEntries.status, "active"), sql`${kbChunks.version} = ${knowledgeEntries.version}`, knowledgeVisibleWhere(p)),
    ),
    // a place narrows to that property (and its building), always keeping organization-wide material
    input.propertyId ? or(sql`${placeProp} = ${input.propertyId}`, sql`${placeProp} is null`) : undefined,
    input.buildingId ? or(sql`${placeBld} = ${input.buildingId}`, sql`${placeBld} is null`) : undefined,
    input.categories?.length ? or(inArray(documents.category, input.categories), inArray(knowledgeEntries.category, input.categories)) : undefined,
  )!;

  const cols = {
    id: kbChunks.id, documentId: kbChunks.documentId, entryId: kbChunks.entryId, heading: kbChunks.heading, page: kbChunks.page, content: kbChunks.content, version: kbChunks.version,
    docTitle: documents.title, entryTitle: knowledgeEntries.title, docCategory: documents.category, entryCategory: knowledgeEntries.category,
    docAudience: documents.audience, entryAudience: knowledgeEntries.audience, propertyName: properties.name,
  };
  const SEARCH = sql.raw("kb_chunks.search"); // generated column (migration 0017), not part of the Drizzle schema
  const dist = qvec ? sql<number>`(${kbChunks.embedding} <=> ${`[${qvec.join(",")}]`}::vector)` : null;
  const { vectorRows, wordRows, words } = await tenantTx(ctx, async (tx) => {
    // Postgres' own English stemmer turns each question word (plus its everyday equivalent) into search lexemes,
    // so "booking" meets "book" exactly as the stored passages were stemmed
    const groups = searchGroups(query);
    const lexRows = groups.length
      ? (await tx.execute<{ lex: string[] }>(sql`select array(select lexeme from unnest(to_tsvector('english', g.txt))) as lex from jsonb_array_elements_text(${JSON.stringify(groups)}::jsonb) with ordinality as g(txt, ord) order by g.ord`)).rows
      : [];
    const lexGroups = lexRows.map((r) => r.lex.filter((l) => /^[a-z0-9]+$/.test(l))).filter((g) => g.length);
    const words = lexGroups.map((g) => g.join(" "));
    const matchedExpr = lexGroups.length
      ? sql<number>`(${sql.join(lexGroups.map((g) => sql`(kb_chunks.search @@ to_tsquery('simple', ${g.join(" | ")}))::int`), sql` + `)})`
      : sql<number>`0`;
    const from = (extra: { sim?: SQL<number> }) => tx.select({ ...cols, matched: matchedExpr, sim: extra.sim ?? sql<number | null>`null` }).from(kbChunks)
      .innerJoin(kbSources, eq(kbSources.id, kbChunks.sourceId))
      .leftJoin(documents, eq(documents.id, kbChunks.documentId))
      .leftJoin(knowledgeEntries, eq(knowledgeEntries.id, kbChunks.entryId))
      .leftJoin(properties, eq(properties.id, sql`coalesce(${documents.propertyId}, ${knowledgeEntries.propertyId})`))
      .$dynamic();
    let vectorRows: Awaited<ReturnType<typeof from>> = [];
    if (dist) {
      await tx.execute(sql`set local hnsw.ef_search = 100`);
      vectorRows = await from({ sim: sql<number>`1 - ${dist}` })
        .where(and(visible, eq(kbChunks.embeddingModel, model.id), sql`${kbChunks.embedding} is not null`)).orderBy(dist).limit(CANDIDATES);
    }
    const tsq = lexGroups.flat().join(" | ");
    const wordRows = lexGroups.length
      ? await from({}).where(and(visible, sql`${SEARCH} @@ to_tsquery('simple', ${tsq})`)).orderBy(sql`ts_rank_cd(${SEARCH}, to_tsquery('simple', ${tsq}), 32) desc`).limit(CANDIDATES)
      : [];
    return { vectorRows, wordRows, words };
  });

  // relevance floor: a passage needs real meaning-similarity, or enough of the question's words
  const needed = words.length <= 2 ? 1 : Math.ceil(words.length * 0.4);
  type Row = (typeof wordRows)[number];
  const fused = new Map<string, { row: Row; score: number; sim: number | null }>();
  vectorRows.forEach((r, i) => {
    const sim = Number(r.sim);
    if (model.requiresSharedWord && Number(r.matched) < 1) return;
    if (sim < model.minSimilarity && Number(r.matched) < needed) return;
    fused.set(r.id, { row: r, score: 1 / (RRF_K + i + 1), sim });
  });
  wordRows.forEach((r, i) => {
    const hit = fused.get(r.id);
    if (hit) hit.score += 1 / (RRF_K + i + 1);
    else if (Number(r.matched) >= Math.max(1, needed)) fused.set(r.id, { row: r, score: 1 / (RRF_K + i + 1), sim: null });
  });

  const perSource = new Map<string, number>();
  const passages: Passage[] = [];
  for (const { row, score, sim } of [...fused.values()].sort((a, b) => b.score - a.score)) {
    const sourceId = (row.documentId ?? row.entryId)!;
    const n = perSource.get(sourceId) ?? 0;
    if (n >= MAX_PER_SOURCE) continue;
    perSource.set(sourceId, n + 1);
    const isDoc = !!row.documentId;
    passages.push({
      chunkId: row.id, sourceType: isDoc ? "document" : "knowledge", sourceId, title: (isDoc ? row.docTitle : row.entryTitle) ?? "", heading: row.heading, page: row.page,
      content: row.content, href: `/o/${p.orgSlug}/${isDoc ? "documents" : "knowledge"}/${sourceId}`, propertyName: row.propertyName,
      category: (isDoc ? row.docCategory : row.entryCategory) ?? "", audience: (isDoc ? row.docAudience : row.entryAudience) ?? "",
      version: row.version, score, similarity: sim, matchedTerms: Number(row.matched),
    });
    if (passages.length >= limit) break;
  }
  return { passages, model: model.id, demo: model.demo, vector: !!qvec, terms: words };
}

// the most relevant sentences of a passage for a question (demo answers and short previews quote these verbatim);
// a short passage is quoted whole, and a list item keeps the line that introduces the list
export function bestSentences(content: string, question: string, max = 2): string[] {
  const q = new Set(terms(question));
  const isList = /\n\s*([-*•]|\d+[.)])\s+/.test(content);
  if (content.length <= 320 && !isList) {
    // a short paragraph is quoted whole, if it shares any word with the question
    return terms(content).some((t) => q.has(t)) ? [content.replace(/\s*\n\s*/g, " ").trim()] : [];
  }
  type S = { s: string; i: number; score: number; leadIn: number | null };
  const out: S[] = [];
  let lastLead: number | null = null;
  for (const line of content.split(/\n+/)) {
    const item = /^\s*([-*•]|\d+[.)])\s+/.test(line);
    const parts = item ? [line.replace(/^\s*([-*•]|\d+[.)])\s*/, "").trim()] : line.split(/(?<=[.!?])\s+/).map((x) => x.trim());
    for (const s of parts.filter((x) => x.length > 3)) {
      out.push({ s, i: out.length, score: new Set(terms(s).filter((t) => q.has(t))).size, leadIn: item ? lastLead : null });
      if (!item) lastLead = out.length - 1;
    }
  }
  const best = Math.max(0, ...out.map((x) => x.score));
  if (!best) return [];
  // a single shared word is weak evidence: quote one sentence, not every sentence that shares it
  const picked = out.filter((x) => x.score === best).slice(0, best >= 2 ? max : 1);
  const withLead = new Set<number>();
  for (const x of picked) {
    if (x.leadIn !== null) withLead.add(x.leadIn);
    withLead.add(x.i);
  }
  return [...withLead].sort((a, b) => a - b).map((i) => out[i].s);
}

// one short policy line for an action's plan ("Policy: “Party Room: approval required…” — Amenity booking policy")
export async function policyLine(ctx: TenantCtx, topic: string, propertyId: string | null): Promise<string | null> {
  if (!canSearchKnowledge(ctx.principal)) return null;
  try {
    const r = await searchKnowledge(ctx, { query: topic, propertyId, categories: POLICY_CATEGORIES, limit: 1 });
    const top = r.passages[0];
    if (!top || top.matchedTerms < 2) return null;
    const quote = bestSentences(top.content, topic, 1)[0];
    if (!quote || new Set(terms(quote).filter((t) => terms(topic).includes(t))).size < 2) return null;
    return `Policy: “${quote.length > 180 ? `${quote.slice(0, 177)}…` : quote}” — ${citationLabel(top)}`;
  } catch {
    return null; // a policy hint never blocks preparing the action
  }
}

export const citationLabel = (p: Pick<Passage, "title" | "heading" | "page">) =>
  [p.title, p.heading ? `§ ${p.heading.split(" › ").pop()}` : null, p.page ? `p. ${p.page}` : null].filter(Boolean).join(" · ");
