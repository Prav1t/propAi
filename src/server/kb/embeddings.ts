import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "../db/schema";

// Embedding providers behind one interface. Every model must return EMBEDDING_DIMENSIONS values (the vector column's size);
// providers that support a size parameter are asked for it, others are checked. Without a key, a local hashing embedder
// keeps retrieval working offline (labelled as demo quality).

export type EmbedKind = "document" | "query";

export interface EmbeddingModel {
  readonly provider: string;
  readonly model: string;
  readonly id: string; // stored on every passage; vector search only compares passages embedded by the same id
  readonly demo: boolean;
  readonly minSimilarity: number; // below this a passage only counts if its words also match
  // true when similarity alone can't be trusted: a passage must also share at least one of the question's words
  readonly requiresSharedWord?: boolean;
  embed(texts: string[], kind: EmbedKind, signal?: AbortSignal): Promise<(number[] | null)[]>;
}

export class EmbeddingError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
  }
}

/* ───────────── local hashing embedder (no network, deterministic) ───────────── */

// grammar words, plus words every rule contains ("allowed", "policy") that would otherwise match unrelated passages
const STOP = new Set(("a an and are as at be by can do does for from has have how i if in into is it its me my of on or our please " +
  "should so that the their them there these they this to up was we what when where which who why will with you your " +
  "allow allowed permit permitted ok okay rule rules policy policies need get use want know tell say says also any some would could").split(" "));

// a few everyday equivalents so "gym" finds "fitness centre" and "bbq" finds "barbecue" without a model
const SYNONYMS: Record<string, string> = {
  gym: "fitness", workout: "fitness", exercise: "fitness", bbq: "barbecue", grill: "barbecue", lift: "elevator",
  dog: "pet", cat: "pet", animal: "pet", reserve: "book", reservation: "book", booking: "book", rent: "book",
  moving: "move", mover: "move", cost: "fee", price: "fee", charge: "fee", loud: "quiet", noise: "quiet",
  trash: "garbage", rubbish: "garbage", waste: "garbage", recycling: "recycle", flood: "leak", flooding: "leak", burst: "leak",
  urgent: "emergency", car: "vehicle", bike: "bicycle", parcel: "package", delivery: "package", courier: "package",
  guest: "visitor", event: "party", fob: "key", keycard: "key", smoking: "smoke", vape: "smoke",
};

// question words worth searching for, each with its everyday equivalent ("gym fitness"); stop words dropped
export function searchGroups(text: string): string[] {
  const out = new Map<string, string>();
  for (const raw of text.toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw) || out.has(raw)) continue;
    const syn = SYNONYMS[raw] ?? SYNONYMS[stem(raw)];
    out.set(raw, syn && syn !== raw ? `${raw} ${syn}` : raw);
  }
  return [...out.values()].slice(0, 12);
}

export function stem(w: string): string {
  if (w.length <= 3 || /^\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    const s = stem(raw);
    out.push(s);
    const syn = SYNONYMS[raw] ?? SYNONYMS[s];
    if (syn && syn !== s) out.push(syn);
  }
  return out;
}

const fnv1a = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export function hashEmbed(text: string, dims = EMBEDDING_DIMENSIONS): number[] | null {
  const v = new Array<number>(dims).fill(0);
  const t = terms(text);
  const add = (feature: string, w: number) => {
    const h = fnv1a(feature);
    v[h % dims] += (fnv1a(`~${feature}`) & 1 ? 1 : -1) * w;
  };
  t.forEach((w, i) => {
    add(`w:${w}`, 1);
    if (i > 0) add(`b:${t[i - 1]}_${w}`, 0.6);
    if (w.length >= 5) for (let j = 0; j + 3 <= w.length; j++) add(`c:${w.slice(j, j + 3)}`, 0.2);
  });
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return norm ? v.map((x) => x / norm) : null;
}

export class LocalHashEmbedder implements EmbeddingModel {
  readonly provider = "local";
  readonly model = "hash-v2"; // bump when the features change: passages from an older version are flagged for re-indexing
  readonly id = "local/hash-v2";
  readonly demo = true;
  // hashed features collide by chance (about one made-up word in 25 scores over 0.35 against the demo passages),
  // so similarity only re-ranks passages that share a word with the question; it never finds one on its own
  readonly minSimilarity = 0.35;
  readonly requiresSharedWord = true;
  async embed(texts: string[]) {
    return texts.map((t) => hashEmbed(t));
  }
}

/* ───────────── HTTP providers ───────────── */

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), 30_000);
    signal?.addEventListener("abort", () => ctrl.abort(signal.reason), { once: true });
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
      if (res.ok) return await res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new EmbeddingError(`Embedding request failed (${res.status}): ${text.slice(0, 200)}`, retryable);
    } catch (e) {
      if (e instanceof EmbeddingError) throw e;
      if (attempt === 0 && !signal?.aborted) continue;
      throw new EmbeddingError(`Embedding service unreachable: ${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

const dataShape = z.object({ data: z.array(z.object({ index: z.number().optional(), embedding: z.array(z.number()) })) });

function checked(raw: unknown, n: number, who: string): number[][] {
  const parsed = dataShape.safeParse(raw);
  if (!parsed.success) throw new EmbeddingError(`${who} returned an unexpected response.`);
  const rows = [...parsed.data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  if (rows.length !== n) throw new EmbeddingError(`${who} returned ${rows.length} embeddings for ${n} inputs.`);
  const bad = rows.find((r) => r.length !== EMBEDDING_DIMENSIONS);
  if (bad) throw new EmbeddingError(`${who} returns ${bad.length}-dimensional embeddings; the index uses ${EMBEDDING_DIMENSIONS}. Choose a model that can output ${EMBEDDING_DIMENSIONS} dimensions.`);
  return rows;
}

const BATCH = 64;
async function batched(texts: string[], fn: (batch: string[]) => Promise<number[][]>): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) out.push(...(await fn(texts.slice(i, i + BATCH))));
  return out;
}

export class OpenAIEmbedder implements EmbeddingModel {
  readonly demo = false;
  readonly minSimilarity = 0.3;
  readonly id: string;
  constructor(readonly provider: "openai" | "openai-compatible", readonly model: string, private apiKey: string | undefined, private baseUrl: string) {
    this.id = `${provider}/${model}`;
  }
  async embed(texts: string[], _kind: EmbedKind, signal?: AbortSignal) {
    // text-embedding-3 models shorten to any size; other models must already produce the right size
    const sized = /^text-embedding-3/.test(this.model) ? { dimensions: EMBEDDING_DIMENSIONS } : {};
    return batched(texts, async (b) => checked(
      await postJson(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}, { model: this.model, input: b, encoding_format: "float", ...sized }, signal),
      b.length, "The embedding model",
    ));
  }
}

export class VoyageEmbedder implements EmbeddingModel {
  readonly provider = "voyage";
  readonly demo = false;
  readonly minSimilarity = 0.3;
  readonly id: string;
  constructor(readonly model: string, private apiKey: string, private baseUrl = "https://api.voyageai.com/v1") {
    this.id = `voyage/${model}`;
  }
  async embed(texts: string[], kind: EmbedKind, signal?: AbortSignal) {
    return batched(texts, async (b) => checked(
      await postJson(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, { authorization: `Bearer ${this.apiKey}` }, { model: this.model, input: b, input_type: kind, output_dimension: EMBEDDING_DIMENSIONS }, signal),
      b.length, "Voyage",
    ));
  }
}

/* ───────────── selection ───────────── */

const schema = z.object({
  EMBEDDING_PROVIDER: z.enum(["local", "openai", "openai-compatible", "voyage"]).optional(),
  EMBEDDING_MODEL: z.string().trim().optional(),
  EMBEDDING_API_KEY: z.string().trim().optional(),
  EMBEDDING_BASE_URL: z.string().trim().url().optional().or(z.literal("")),
  VOYAGE_API_KEY: z.string().trim().optional(),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_BASE_URL: z.string().trim().url().optional().or(z.literal("")),
  AI_COMPAT_BASE_URL: z.string().trim().url().optional().or(z.literal("")),
  AI_COMPAT_API_KEY: z.string().trim().optional(),
});

export type EmbeddingChoice = { model: EmbeddingModel; reason: string | null };

// pure: picks the embedding provider from the environment (unit-tested)
export function resolveEmbeddings(source: Record<string, string | undefined>): EmbeddingChoice {
  const e = schema.parse(source);
  const blank = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  const wanted = e.EMBEDDING_PROVIDER ?? (blank(e.VOYAGE_API_KEY) ? "voyage" : blank(e.OPENAI_API_KEY) ? "openai" : "local");
  const local = (reason: string): EmbeddingChoice => ({ model: new LocalHashEmbedder(), reason });
  if (wanted === "voyage") {
    const key = blank(e.EMBEDDING_API_KEY) ?? blank(e.VOYAGE_API_KEY);
    return key ? { model: new VoyageEmbedder(blank(e.EMBEDDING_MODEL) ?? "voyage-3.5-lite", key, blank(e.EMBEDDING_BASE_URL)), reason: null } : local("EMBEDDING_PROVIDER is voyage but no VOYAGE_API_KEY is set");
  }
  if (wanted === "openai") {
    const key = blank(e.EMBEDDING_API_KEY) ?? blank(e.OPENAI_API_KEY);
    return key
      ? { model: new OpenAIEmbedder("openai", blank(e.EMBEDDING_MODEL) ?? "text-embedding-3-small", key, blank(e.EMBEDDING_BASE_URL) ?? blank(e.OPENAI_BASE_URL) ?? "https://api.openai.com/v1"), reason: null }
      : local("EMBEDDING_PROVIDER is openai but no OPENAI_API_KEY is set");
  }
  if (wanted === "openai-compatible") {
    const base = blank(e.EMBEDDING_BASE_URL) ?? blank(e.AI_COMPAT_BASE_URL);
    const model = blank(e.EMBEDDING_MODEL);
    if (!base || !model) return local("EMBEDDING_PROVIDER is openai-compatible but EMBEDDING_BASE_URL or EMBEDDING_MODEL is not set");
    return { model: new OpenAIEmbedder("openai-compatible", model, blank(e.EMBEDDING_API_KEY) ?? blank(e.AI_COMPAT_API_KEY), base), reason: null };
  }
  return local(e.EMBEDDING_PROVIDER === "local" ? "EMBEDDING_PROVIDER is local" : "no embedding provider key is configured");
}

let cached: EmbeddingChoice | null = null;
let override: EmbeddingModel | null = null;
export function embeddings(): EmbeddingChoice {
  if (override) return { model: override, reason: null };
  cached ??= resolveEmbeddings(process.env);
  return cached;
}
export function setEmbeddingModelForTests(m: EmbeddingModel | undefined) {
  override = m ?? null;
  cached = null;
}
