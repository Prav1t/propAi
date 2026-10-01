import Link from "next/link";
import { cn } from "@/lib/cn";

// link-based tabs (URL is the state)
export function LinkTabs({ tabs, active }: { tabs: { key: string; label: string; href: string; count?: number | null }[]; active: string }) {
  return (
    <nav aria-label="Views" className="flex gap-1 overflow-x-auto border-b border-border px-3 pt-2">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={t.key === active ? "page" : undefined}
          className={cn("-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px]", t.key === active ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>
          {t.label}
          {t.count != null ? <span className="rounded-full bg-subtle px-1.5 text-[11px] tabular-nums text-muted">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
