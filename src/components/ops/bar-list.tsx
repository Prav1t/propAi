// single-series horizontal bars: label + value always visible, title tooltip on hover
export function BarList({ rows, emptyLabel = "Nothing to show", href }: { rows: { key: string; label: string; value: number; sub?: string }[]; emptyLabel?: string; href?: (key: string) => string }) {
  if (!rows.length) return <p className="px-4 py-6 text-center text-[13px] text-faint">{emptyLabel}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2.5 px-4 py-3" role="list">
      {rows.map((r) => {
        const inner = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate">{r.label}</span>
              <span className="shrink-0 tabular-nums text-muted">{r.value}{r.sub ? <span className="text-faint"> · {r.sub}</span> : null}</span>
            </div>
            <div className="mt-1 h-2 rounded-r bg-subtle" aria-hidden>
              <div className="h-2 rounded-r-[4px] bg-accent" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
            </div>
          </>
        );
        return (
          <li key={r.key} title={`${r.label}: ${r.value}${r.sub ? ` (${r.sub})` : ""}`}>
            {href ? <a href={href(r.key)} className="block rounded hover:bg-subtle/60">{inner}</a> : inner}
          </li>
        );
      })}
    </ul>
  );
}
