"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { initialActionState } from "@/lib/action-state";
import { sanitizeViewQuery } from "@/lib/views";
import { deleteViewAction, saveViewAction } from "@/app/o/[orgSlug]/view-actions";
import { Button, SubmitButton } from "./button";
import { Input } from "./form";

export type SavedView = { id: string; name: string; query: string };

// a person's own named filter sets for a list page: apply with one click, save the current filters, delete
export function SavedViews({ orgSlug, page, views }: { orgSlug: string; page: string; views: SavedView[] }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = sanitizeViewQuery(params.toString());
  const active = views.find((v) => v.query === current);
  const [state, save] = useActionState(saveViewAction.bind(null, orgSlug, page, current), initialActionState);
  const [deleting, startDelete] = useTransition();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => { if (state.ok) router.refresh(); }, [state, router]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative ml-auto">
      <Button type="button" size="sm" variant="ghost" aria-expanded={open} aria-controls="saved-views" onClick={() => setOpen((o) => !o)}>
        {active ? `View: ${active.name}` : "Saved views"}{views.length ? <span className="rounded-full bg-subtle px-1.5 text-[11px] tabular-nums text-muted">{views.length}</span> : null}
      </Button>
      {open ? (
        <div id="saved-views" role="region" aria-label="Saved views" className="absolute right-0 z-30 mt-1 w-72 rounded-[var(--radius-lg)] border border-border bg-surface p-2 shadow-lg">
          {views.length ? (
            <ul className="mb-2 max-h-64 overflow-y-auto">
              {views.map((v) => (
                <li key={v.id} className="flex items-center gap-1">
                  <Link href={`${pathname}?${v.query}`} onClick={() => setOpen(false)} aria-current={v.id === active?.id ? "true" : undefined}
                    className={`flex min-h-9 flex-1 items-center truncate rounded px-2 text-[13px] hover:bg-subtle pointer-coarse:min-h-11 ${v.id === active?.id ? "font-medium text-accent" : ""}`}>
                    {v.name}
                  </Link>
                  <button type="button" aria-label={`Delete view ${v.name}`} disabled={deleting}
                    onClick={() => startDelete(async () => { const r = await deleteViewAction(orgSlug, v.id); setDeleteError(r.error ?? null); if (!r.error) router.refresh(); })}
                    className="inline-flex size-8 items-center justify-center rounded text-faint hover:bg-subtle hover:text-danger pointer-coarse:size-11">×</button>
                </li>
              ))}
            </ul>
          ) : <p className="mb-2 px-2 py-1 text-[13px] text-muted">Save the filters you use often and come back to them in one click.</p>}
          {deleteError ? <p role="alert" className="mb-2 px-2 text-xs text-danger">{deleteError}</p> : null}
          <form action={save} className="border-t border-border px-1 pt-2">
            <label htmlFor="view-name" className="block text-xs font-medium text-muted">{current ? "Save the current filters as" : "Choose filters first, then save them here"}</label>
            <div className="mt-1 flex gap-2">
              <Input id="view-name" name="name" maxLength={60} required disabled={!current} defaultValue={active?.name ?? ""} placeholder="e.g. Overdue plumbing" className="h-8 text-[13px]" />
              <SubmitButton size="sm" variant="secondary" disabled={!current} pendingLabel="…">Save</SubmitButton>
            </div>
            {state.error ? <p role="alert" className="mt-1 text-xs text-danger">{state.fieldErrors?.name ?? state.error}</p> : state.ok ? <p role="status" className="mt-1 text-xs text-success">{state.message}</p> : null}
          </form>
        </div>
      ) : null}
    </div>
  );
}
