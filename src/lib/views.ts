// list pages that can keep saved views (the key is stored with the view)
export const VIEW_PAGES = ["maintenance", "tasks", "inspections", "incidents", "complaints", "packages", "residents", "vendors", "assets", "visitors", "bookings", "units"] as const;
export type ViewPage = (typeof VIEW_PAGES)[number];

// a saved view is only list filters: short lowercase keys with short values, no paging, stable order
export function sanitizeViewQuery(query: string): string {
  const raw = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const out = new URLSearchParams();
  const seen = new Set<string>();
  for (const [k, v] of raw) {
    if (k === "page" || seen.has(k) || !/^[a-z][a-z_]{0,19}$/.test(k)) continue;
    const value = v.trim();
    if (!value || value.length > 200) continue;
    seen.add(k);
    out.append(k, value);
    if (seen.size >= 12) break;
  }
  out.sort();
  return out.toString();
}
