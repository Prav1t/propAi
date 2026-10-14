// Heading-aware chunking: passages follow the document's own sections so a citation can name the section.
// Pure and deterministic (unit-tested). Token counts are estimates (~1.33 tokens per word).

export type ChunkInput = { page: number | null; text: string };
export type Chunk = { ordinal: number; heading: string | null; page: number | null; content: string; tokenCount: number };

export const MAX_TOKENS = 380;
export const OVERLAP_TOKENS = 60;

export const estimateTokens = (s: string) => Math.ceil((s.match(/\S+/g)?.length ?? 0) * 1.33);

type Heading = { level: number; text: string };

// "# Party room", "2.3 Fees", "PARKING", "Moving in:" — short lines that introduce what follows
export function headingOf(line: string): Heading | null {
  const md = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
  if (md) return { level: md[1].length, text: md[2].trim() };
  if (line.length > 80) return null;
  const numbered = line.match(/^((?:\d+\.)*\d+)[.)]?\s+([A-Z][^.!?]*)$/);
  if (numbered && !/[.!?;,]$/.test(line) && numbered[2].split(/\s+/).length <= 8) return { level: Math.min(6, numbered[1].split(".").length + 1), text: line.trim() };
  if (/^(part|section|article|schedule|appendix)\s+[\w.-]+\b/i.test(line) && !/[.!?]$/.test(line)) return { level: 2, text: line.trim() };
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase() && line.split(/\s+/).length <= 8 && !/[.!?]$/.test(line)) return { level: 2, text: titleCase(line.trim()) };
  if (/^[A-Z][^.!?]{1,58}:$/.test(line)) return { level: 3, text: line.slice(0, -1).trim() };
  return null;
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function normalize(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/ /g, " ").replace(/[ \t]+/g, " ").split("\n").map((l) => l.trim());
}

// paragraphs: blank-line separated; list items and numbered rules stay separate paragraphs so they can be cited alone
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) out.push(cur.join(" ").trim());
    cur = [];
  };
  for (const l of lines) {
    if (!l) flush();
    else if (/^([-*•]|\d+[.)])\s+/.test(l)) {
      flush();
      cur.push(l);
    } else cur.push(l);
  }
  flush();
  return out.filter(Boolean);
}

// a paragraph longer than the limit is split at sentence ends, then at word boundaries
function splitLong(p: string, max: number): string[] {
  if (estimateTokens(p) <= max) return [p];
  const sentences = p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [p];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (estimateTokens(s) > max) {
      if (cur) out.push(cur);
      cur = "";
      const words = s.split(/\s+/);
      const per = Math.floor(max / 1.33);
      for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(" "));
      continue;
    }
    if (cur && estimateTokens(`${cur} ${s}`) > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

export function chunkText(input: ChunkInput[], opts: { maxTokens?: number; overlapTokens?: number } = {}): Chunk[] {
  const max = opts.maxTokens ?? MAX_TOKENS;
  const overlap = opts.overlapTokens ?? OVERLAP_TOKENS;
  const chunks: Chunk[] = [];
  const stack: Heading[] = [];
  const headingText = () => (stack.length ? stack.map((h) => h.text).join(" › ") : null);

  type Section = { heading: string | null; page: number | null; lines: string[] };
  const sections: Section[] = [];
  for (const pg of input) {
    let sec: Section = { heading: headingText(), page: pg.page, lines: [] };
    for (const line of normalize(pg.text)) {
      const h = line ? headingOf(line) : null;
      if (h) {
        if (sec.lines.some(Boolean)) sections.push(sec);
        while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
        stack.push(h);
        sec = { heading: headingText(), page: pg.page, lines: [] };
      } else sec.lines.push(line);
    }
    if (sec.lines.some(Boolean)) sections.push(sec);
  }

  for (const sec of sections) {
    const parts = paragraphs(sec.lines).flatMap((p) => splitLong(p, max));
    let cur: string[] = [];
    const emit = () => {
      const content = cur.join("\n").trim();
      if (content) chunks.push({ ordinal: chunks.length, heading: sec.heading, page: sec.page, content, tokenCount: estimateTokens(content) });
    };
    for (const part of parts) {
      if (cur.length && estimateTokens([...cur, part].join("\n")) > max) {
        emit();
        // carry the tail of the previous passage so a rule split across passages keeps its context
        const carry: string[] = [];
        for (let i = cur.length - 1; i >= 0 && estimateTokens([cur[i], ...carry].join("\n")) <= overlap; i--) carry.unshift(cur[i]);
        cur = [...carry, part];
      } else cur.push(part);
    }
    emit();
  }
  return chunks;
}

// what is embedded and keyword-searched alongside the passage: the source title and its section
export const chunkContext = (title: string, heading: string | null) => (heading ? `${title} › ${heading}` : title);
export const embeddingText = (title: string, c: Pick<Chunk, "heading" | "content">) => `${chunkContext(title, c.heading)}\n\n${c.content}`;
