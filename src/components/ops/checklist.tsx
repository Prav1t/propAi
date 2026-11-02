"use client";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import type { ActionState } from "@/lib/action-state";

type Item = { id: string; label: string; done: boolean };

// ticks show immediately; the server confirms (or the tick rolls back with the reason). While a tick is being saved
// the header says so, and leaving the page asks first, so a quick tick-and-go isn't lost.
export function Checklist({ items, canWork, toggle }: { items: Item[]; canWork: boolean; toggle: (itemId: string, done: boolean) => Promise<ActionState> }) {
  const [shown, setShown] = useOptimistic(items, (cur: Item[], change: { id: string; done: boolean }) => cur.map((i) => (i.id === change.id ? { ...i, done: change.done } : i)));
  const [error, setError] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const done = shown.filter((i) => i.done).length;
  useEffect(() => {
    if (!saving) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saving]);
  const onChange = (id: string, value: boolean) =>
    start(async () => {
      setShown({ id, done: value });
      const r = await toggle(id, value);
      setError(r.error ?? null);
    });
  return (
    <div>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Checklist</h2>
        <span className="text-[13px] text-muted" aria-live="polite">{done} of {shown.length} done{saving ? <span className="text-faint"> · Saving…</span> : null}</span>
      </div>
      {error ? <p role="alert" className="border-b border-border bg-danger-soft px-4 py-2 text-[13px] text-danger">{error}</p> : null}
      <ul className="divide-y divide-border">
        {shown.map((c) => (
          <li key={c.id}>
            <label className={`flex min-h-11 items-center gap-3 px-4 py-2 text-sm ${canWork ? "cursor-pointer hover:bg-subtle/60" : ""}`}>
              <input type="checkbox" className="size-4 shrink-0 accent-[var(--color-accent)]" checked={c.done} disabled={!canWork}
                onChange={(e) => onChange(c.id, e.target.checked)} />
              <span className={c.done ? "text-muted line-through" : ""}>{c.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
