"use client";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";

export type Command = { label: string; href: string; group: string; keywords?: string };
type Hit = { type: string; id: string; title: string; subtitle: string; href: string };

const TYPE_LABEL: Record<string, string> = { property: "Property", building: "Building", unit: "Unit", resident: "Resident", vendor: "Vendor", staff: "Staff" };

// global Cmd/Ctrl-K palette: navigation + actions + permission-aware record search
export function CommandPalette({ commands, search, searchPage }: { commands: Command[]; search: (q: string) => Promise<Hit[]>; searchPage: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const listId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const runSearch = useCallback((value: string) => {
    const mine = ++seq.current;
    if (value.trim().length < 2) { setHits([]); return; }
    start(async () => {
      const r = await search(value);
      if (mine === seq.current) setHits(r); // drop stale responses
    });
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => runSearch(q), 180);
    return () => clearTimeout(t);
  }, [q, runSearch]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (t ? commands.filter((c) => `${c.label} ${c.keywords ?? ""}`.toLowerCase().includes(t)) : commands).slice(0, 8);
  }, [q, commands]);

  const items = [...filtered.map((c) => ({ key: `c:${c.href}`, label: c.label, sub: c.group, href: c.href })), ...hits.map((h) => ({ key: `h:${h.type}:${h.id}`, label: h.title, sub: `${TYPE_LABEL[h.type]} · ${h.subtitle}`, href: h.href }))];
  const close = () => { setOpen(false); setQ(""); setHits([]); setActive(0); };
  const go = (href: string) => { close(); router.push(href); };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex h-8 items-center gap-2 rounded-[var(--radius-md)] border border-border px-2.5 text-[13px] text-faint hover:bg-subtle sm:w-64" aria-label="Search and commands">
        <Icon name="search" />
        <span className="hidden sm:inline">Search or jump to…</span>
        <kbd className="ml-auto hidden rounded border border-border px-1 font-sans text-[11px] sm:inline">Ctrl K</kbd>
      </button>
      {open ? createPortal(
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh]" onMouseDown={close}>
          <div role="dialog" aria-modal="true" aria-label="Command palette" className="w-full max-w-xl overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Icon name="search" className="size-4 text-faint" />
              <input
                ref={inputRef} value={q} role="combobox" aria-label="Search everything" aria-expanded="true" aria-controls={listId} aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
                placeholder="Search properties, units, residents, vendors… or type a command"
                className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint focus-visible:outline-none"
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") close();
                  else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                  else if (e.key === "Enter" && items[active]) { e.preventDefault(); go(items[active].href); }
                }}
              />
              {pending ? <span className="text-xs text-faint">Searching…</span> : null}
            </div>
            <ul id={listId} role="listbox" className="max-h-[50vh] overflow-y-auto p-1">
              {items.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-faint">{q.trim().length >= 2 && !pending ? "No matches" : "Type to search"}</li> : items.map((it, i) => (
                <li key={it.key} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                  onMouseEnter={() => setActive(i)} onClick={() => go(it.href)}
                  className={cn("flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2 text-sm", i === active && "bg-subtle")}>
                  <span className="truncate">{it.label}</span>
                  <span className="shrink-0 truncate text-xs text-faint">{it.sub}</span>
                </li>
              ))}
            </ul>
            {q.trim().length >= 2 ? (
              <button type="button" onClick={() => go(`${searchPage}?q=${encodeURIComponent(q)}`)} className="w-full border-t border-border px-3 py-2 text-left text-[13px] text-accent hover:bg-subtle">
                See all results for “{q}”
              </button>
            ) : null}
          </div>
        </div>,
        document.body, // escape the header's backdrop-filter containing block
      ) : null}
    </>
  );
}
