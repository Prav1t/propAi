// only allow same-site relative redirects (blocks open redirects like //evil.com or /\evil.com)
export function safeNext(v: string | null | undefined): string | null {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || v.includes("://")) return null;
  if (/[\u0000-\u001f]/.test(v)) return null;
  return v.slice(0, 512);
}
