"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Input, Select } from "./form";

export type FilterDef = { name: string; label: string; options: { value: string; label: string }[]; allLabel?: string };

// URL-driven filters: search is debounced, selects apply immediately, page resets on change
export function FilterBar({ filters = [], searchPlaceholder = "Search…", search = true }: { filters?: FilterDef[]; searchPlaceholder?: string; search?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = (name: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(name, value); else next.delete(name);
    next.delete("page");
    start(() => router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false }));
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <div role="search" className="flex flex-wrap items-center gap-2 border-b border-border p-3" aria-busy={pending}>
      {search ? <><label className="sr-only" htmlFor="filter-q">Search</label>
      <Input
        id="filter-q" type="search" value={q} placeholder={searchPlaceholder} className="h-8 w-full sm:w-64"
        onChange={(e) => {
          setQ(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = setTimeout(() => apply("q", v.trim()), 250);
        }}
      /></> : null}
      {filters.map((f) => (
        <div key={f.name}>
          <label className="sr-only" htmlFor={`filter-${f.name}`}>{f.label}</label>
          <Select id={`filter-${f.name}`} className="h-8 w-auto text-[13px]" value={params.get(f.name) ?? ""} onChange={(e) => apply(f.name, e.target.value)}>
            <option value="">{f.label}: {f.allLabel ?? "all"}</option>
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
      ))}
      {pending ? <span className="text-xs text-faint" aria-live="polite">Updating…</span> : null}
    </div>
  );
}
