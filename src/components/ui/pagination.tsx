import Link from "next/link";

// server-rendered pager that preserves the current filters
export function Pagination({ page, pageCount, total, basePath, params }: { page: number; pageCount: number; total: number; basePath: string; params: Record<string, string | string[] | undefined> }) {
  const href = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (typeof v === "string" && v && k !== "page") sp.set(k, v);
    if (p > 1) sp.set("page", String(p));
    return `${basePath}${sp.size ? `?${sp}` : ""}`;
  };
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-border px-4 py-2.5 text-[13px] text-muted">
      <span>{total.toLocaleString()} result{total === 1 ? "" : "s"}</span>
      <span className="flex items-center gap-3">
        {page > 1 ? <Link className="text-accent hover:underline" href={href(page - 1)}>← Previous</Link> : <span className="opacity-40">← Previous</span>}
        <span>Page {page} of {pageCount}</span>
        {page < pageCount ? <Link className="text-accent hover:underline" href={href(page + 1)}>Next →</Link> : <span className="opacity-40">Next →</span>}
      </span>
    </nav>
  );
}
