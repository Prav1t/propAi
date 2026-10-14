import "server-only";
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { documentVersions, documents, files, kbChunks, kbSources, knowledgeEntries } from "../db/schema";
import { withContext, type Tx } from "../db/client";
import { blobStore } from "../files/storage";
import { log } from "../log";
import { chunkText, chunkContext, embeddingText, type Chunk } from "./chunk";
import { extractText } from "./extract";
import { embeddings, EmbeddingError } from "./embeddings";

// The indexing queue is kb_sources itself: a change marks its source "queued" in the same transaction, and the worker
// (or the request's after() hook) picks it up. Extraction and embedding run outside any transaction; the passages
// are swapped in one transaction at the end, so retrieval never sees a half-indexed source.

type Source = typeof kbSources.$inferSelect;
const MAX_ATTEMPTS = 3;
const STALE_MS = 10 * 60_000;

export async function queueIndex(tx: Tx, input: { orgId: string; documentId?: string; entryId?: string; version: number }) {
  const base = { orgId: input.orgId, status: "queued", version: input.version, attempts: 0, error: null, queuedAt: new Date() };
  if (input.documentId) {
    await tx.insert(kbSources).values({ ...base, sourceType: "document", documentId: input.documentId })
      .onConflictDoUpdate({ target: kbSources.documentId, targetWhere: sql`${kbSources.documentId} is not null`, set: { status: "queued", version: input.version, attempts: 0, error: null, queuedAt: new Date() } });
  } else if (input.entryId) {
    await tx.insert(kbSources).values({ ...base, sourceType: "knowledge", entryId: input.entryId })
      .onConflictDoUpdate({ target: kbSources.entryId, targetWhere: sql`${kbSources.entryId} is not null`, set: { status: "queued", version: input.version, attempts: 0, error: null, queuedAt: new Date() } });
  }
}

type Loaded =
  | { ok: true; title: string; version: number; pages: { page: number | null; text: string }[] }
  | { ok: false; status: "unsupported" | "empty" | "failed"; version: number; reason: string };

async function load(s: Source): Promise<Loaded | null> {
  if (s.entryId) {
    const [e] = await withContext({ orgId: s.orgId, system: true }, (tx) => tx.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, s.entryId!)));
    if (!e) return null;
    return { ok: true, title: e.title, version: e.version, pages: [{ page: null, text: e.body }] };
  }
  const row = await withContext({ orgId: s.orgId, system: true }, async (tx) => {
    const [d] = await tx.select().from(documents).where(eq(documents.id, s.documentId!));
    if (!d) return null;
    const [f] = await tx.select({ key: files.storageKey, type: files.contentType, scan: files.scanStatus }).from(documentVersions)
      .innerJoin(files, eq(files.id, documentVersions.fileId)).where(and(eq(documentVersions.documentId, d.id), eq(documentVersions.version, d.currentVersion)));
    return { d, f };
  });
  if (!row) return null;
  if (!row.f) return { ok: false, status: "empty", version: row.d.currentVersion, reason: "The document has no file." };
  if (row.f.scan === "infected") return { ok: false, status: "unsupported", version: row.d.currentVersion, reason: "The file was flagged by the virus scanner." };
  let ex: Awaited<ReturnType<typeof extractText>>;
  try {
    ex = await extractText(await blobStore().get(row.f.key), row.f.type);
  } catch (e) {
    // a damaged or password-protected file fails the same way every time: report it rather than retrying
    log.warn("kb.extract_failed", { sourceId: s.id, err: e });
    return { ok: false, status: "failed", version: row.d.currentVersion, reason: "The file couldn't be read — it may be damaged or password-protected. Upload a new version to try again." };
  }
  if (ex.kind === "unsupported") return { ok: false, status: "unsupported", version: row.d.currentVersion, reason: ex.reason };
  return { ok: true, title: row.d.title, version: row.d.currentVersion, pages: ex.pages };
}

async function finish(s: Source, set: Partial<typeof kbSources.$inferInsert>, chunks?: { version: number; title: string; rows: (Chunk & { embedding: number[] | null })[]; model: string | null }) {
  await withContext({ orgId: s.orgId, system: true }, async (tx) => {
    // a newer version queued while we worked: leave it queued, don't overwrite with stale passages
    const [cur] = await tx.select({ status: kbSources.status, version: kbSources.version }).from(kbSources).where(eq(kbSources.id, s.id)).for("update");
    if (!cur) return;
    const superseded = cur.status === "queued" && chunks && cur.version > chunks.version;
    if (superseded) return;
    if (chunks) {
      await tx.delete(kbChunks).where(eq(kbChunks.sourceId, s.id));
      if (chunks.rows.length) {
        await tx.insert(kbChunks).values(chunks.rows.map((c) => ({
          orgId: s.orgId, sourceId: s.id, documentId: s.documentId, entryId: s.entryId, version: chunks.version, ordinal: c.ordinal,
          context: chunkContext(chunks.title, c.heading), heading: c.heading, page: c.page, content: c.content, tokenCount: c.tokenCount,
          embedding: c.embedding, embeddingModel: c.embedding ? chunks.model : null,
        })));
      }
    }
    await tx.update(kbSources).set(set).where(eq(kbSources.id, s.id));
  });
}

export async function indexSource(s: Source): Promise<string> {
  const loaded = await load(s);
  if (!loaded) {
    await withContext({ orgId: s.orgId, system: true }, (tx) => tx.delete(kbSources).where(eq(kbSources.id, s.id)));
    return "gone";
  }
  if (!loaded.ok) {
    await finish(s, { status: loaded.status, error: loaded.reason, chunkCount: 0, charCount: 0, indexedVersion: loaded.version, indexedAt: new Date() }, { version: loaded.version, title: "", rows: [], model: null });
    return loaded.status;
  }
  // a first line repeating the title (PDF title blocks) adds nothing to passages
  const pages = loaded.pages.map((pg, i) => (i === 0 ? { ...pg, text: pg.text.replace(/^\s*([^\n]+)\n/, (m, first: string) => (first.trim().toLowerCase() === loaded.title.trim().toLowerCase() ? "" : m)) } : pg));
  const chunks = chunkText(pages);
  const chars = loaded.pages.reduce((n, p) => n + p.text.length, 0);
  if (!chunks.length) {
    await finish(s, { status: "empty", error: "No readable text was found.", chunkCount: 0, charCount: chars, indexedVersion: loaded.version, indexedAt: new Date() }, { version: loaded.version, title: loaded.title, rows: [], model: null });
    return "empty";
  }
  const { model } = embeddings();
  let vectors: (number[] | null)[];
  let error: string | null = null;
  try {
    vectors = await model.embed(chunks.map((c) => embeddingText(loaded.title, c)), "document");
  } catch (e) {
    // keep the passages (keyword search still finds them) and say why meaning-based search is missing
    error = `Embedding failed, so only keyword search covers this source: ${e instanceof EmbeddingError ? e.message : "unexpected error"}`;
    log.error("kb.embed_failed", { sourceId: s.id, err: e });
    vectors = chunks.map(() => null);
  }
  await finish(s, {
    status: error ? "failed" : "indexed", error, chunkCount: chunks.length, charCount: chars, indexedVersion: loaded.version, indexedAt: new Date(),
    embeddingModel: error ? null : model.id,
  }, { version: loaded.version, title: loaded.title, rows: chunks.map((c, i) => ({ ...c, embedding: vectors[i] })), model: model.id });
  return error ? "failed" : "indexed";
}

let running: Promise<number> | null = null;

const pending = () => or(eq(kbSources.status, "queued"), and(eq(kbSources.status, "indexing"), lt(kbSources.startedAt, new Date(Date.now() - STALE_MS))));

// claims queued sources (plus stale or retryable ones) and indexes them; concurrent calls are coalesced
export function processIndexQueue(limit = 20): Promise<number> {
  running ??= (async () => {
    let done = 0;
    try {
      // candidates are read across organizations; each is claimed inside its own organization's context (RLS checks writes)
      const candidates = await withContext({ system: true }, (tx) => tx.select({ id: kbSources.id, orgId: kbSources.orgId }).from(kbSources).where(pending())
        .orderBy(asc(kbSources.queuedAt)).limit(limit));
      const claimed: Source[] = [];
      for (const c of candidates) {
        const row = await withContext({ orgId: c.orgId, system: true }, async (tx) => {
          const [r] = await tx.select().from(kbSources).where(and(eq(kbSources.id, c.id), pending())).for("update", { skipLocked: true });
          if (!r) return null; // another worker took it
          if (r.attempts >= MAX_ATTEMPTS) {
            await tx.update(kbSources).set({ status: "failed", error: r.error ?? "Indexing kept failing; try re-indexing." }).where(eq(kbSources.id, r.id));
            return null;
          }
          const [u] = await tx.update(kbSources).set({ status: "indexing", startedAt: new Date(), attempts: r.attempts + 1 }).where(eq(kbSources.id, r.id)).returning();
          return u;
        });
        if (row) claimed.push(row);
      }
      for (const s of claimed) {
        try {
          await indexSource(s);
          done++;
        } catch (e) {
          log.error("kb.index_failed", { sourceId: s.id, err: e });
          await withContext({ orgId: s.orgId, system: true }, (tx) =>
            tx.update(kbSources).set({ status: s.attempts >= MAX_ATTEMPTS ? "failed" : "queued", error: `Indexing failed: ${e instanceof Error ? e.message.slice(0, 300) : "unexpected error"}` }).where(eq(kbSources.id, s.id)));
        }
      }
    } finally {
      running = null;
    }
    return done;
  })();
  return running;
}
