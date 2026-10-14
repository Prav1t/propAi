import "server-only";
import { OFFICE } from "../files/sniff";

// Text extraction for indexing. Each page/section keeps its page number so citations can say "p. 2".
// Unsupported types (spreadsheets, slides, images without OCR) are reported, not guessed at.

export type ExtractedPage = { page: number | null; text: string };
export type Extracted = { kind: "text"; pages: ExtractedPage[] } | { kind: "unsupported"; reason: string };

const MAX_BYTES = 25 * 1024 * 1024;

const decodeEntities = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

// mammoth's clean HTML → plain text with "#" headings kept for the chunker
export function docxHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n`)
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<\/li>/gi, "")
      .replace(/<\/(p|tr|table|ul|ol)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<td[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  ).replace(/\n{3,}/g, "\n\n").trim();
}

export async function extractText(bytes: Uint8Array, contentType: string): Promise<Extracted> {
  if (bytes.byteLength > MAX_BYTES) return { kind: "unsupported", reason: "The file is larger than 25 MB." };
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "text/plain" || type === "text/markdown" || type === "text/csv") {
    return { kind: "text", pages: [{ page: null, text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) }] };
  }
  if (type === "application/pdf") {
    const { getDocumentProxy, extractText: pdfText } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      const { text } = await pdfText(pdf, { mergePages: false });
      const pages = (Array.isArray(text) ? text : [text]).map((t, i) => ({ page: i + 1, text: t }));
      return { kind: "text", pages };
    } finally {
      await pdf.loadingTask.destroy(); // pdf.js keeps the parsed document (and its fonts) alive until destroyed
    }
  }
  if (type === OFFICE.docx) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    return { kind: "text", pages: [{ page: null, text: docxHtmlToText(value) }] };
  }
  if (type.startsWith("image/")) return { kind: "unsupported", reason: "Images aren't read yet (text recognition is planned)." };
  if (type === OFFICE.xlsx || type === OFFICE.pptx) return { kind: "unsupported", reason: "Spreadsheets and slide decks aren't indexed yet." };
  return { kind: "unsupported", reason: `Files of type ${type} can't be indexed.` };
}
