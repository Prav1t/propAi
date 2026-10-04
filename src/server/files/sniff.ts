// detects real file type from magic bytes; the client-supplied MIME type is never trusted
export type Sniffed = { mime: string; ext: string; inline: boolean } | null;

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

const OFFICE: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// UTF-8 text with no NUL bytes (checked on the first 64 KB)
function isText(b: Uint8Array): boolean {
  const head = b.slice(0, 65_536);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length === b.length ? head : head.slice(0, head.length - 4));
    return true;
  } catch {
    return false;
  }
}

// `filename` only disambiguates containers (ZIP-based Office files) and plain text; it never overrides magic bytes
export function sniff(b: Uint8Array, filename = ""): Sniffed {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (b.length >= 4 && startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
    // OOXML packages always contain [Content_Types].xml near the start
    if (OFFICE[ext] && ascii(b, 0, Math.min(b.length, 2048)).includes("[Content_Types].xml")) return { mime: OFFICE[ext], ext, inline: false };
    return null;
  }
  if ((ext === "txt" || ext === "csv") && b.length > 0 && isText(b)) return { mime: ext === "csv" ? "text/csv" : "text/plain", ext, inline: false };
  if (b.length < 12) return null;
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg", inline: true };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png", inline: true };
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { mime: "image/gif", ext: "gif", inline: true };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp", ext: "webp", inline: true };
  if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf", inline: false };
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (["heic", "heix", "mif1", "msf1", "hevc"].includes(brand)) return { mime: "image/heic", ext: "heic", inline: false };
    if (brand === "qt  ") return { mime: "video/quicktime", ext: "mov", inline: false };
    if (["isom", "iso2", "mp41", "mp42", "avc1", "M4V ", "dash"].includes(brand)) return { mime: "video/mp4", ext: "mp4", inline: false };
  }
  return null;
}

export const MAX_BYTES: Record<string, number> = {
  "image/jpeg": 10_000_000, "image/png": 10_000_000, "image/gif": 10_000_000, "image/webp": 10_000_000, "image/heic": 10_000_000,
  "application/pdf": 15_000_000, "video/mp4": 25_000_000, "video/quicktime": 25_000_000,
  [OFFICE.docx]: 15_000_000, [OFFICE.xlsx]: 15_000_000, [OFFICE.pptx]: 25_000_000, "text/plain": 2_000_000, "text/csv": 5_000_000,
};

export const MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "application/pdf", "video/mp4", "video/quicktime"];
export const DOCUMENT_TYPES = ["application/pdf", OFFICE.docx, OFFICE.xlsx, OFFICE.pptx, "text/plain", "text/csv", "image/jpeg", "image/png"];
