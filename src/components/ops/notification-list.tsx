"use client";
import { useOptimistic, useState, useTransition } from "react";
import type { ActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

export type NotificationItem = {
  id: string; title: string; body: string | null; readAt: boolean; when: string; whenTitle: string; createdAt: string;
  open: (fd: FormData) => Promise<void>; // marks it read and follows its link
};

// "Mark all read" clears the unread markers at once; opening one marks it read on the way to its link
export function NotificationList({ items, markAll }: { items: NotificationItem[]; markAll: () => Promise<ActionState> }) {
  const [shown, markShown] = useOptimistic(items, (cur: NotificationItem[]) => cur.map((n) => ({ ...n, readAt: true })));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const unread = shown.filter((n) => !n.readAt).length;
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <span className="text-[13px] text-muted" aria-live="polite">{unread ? `${unread} unread` : "All read"}</span>
        {unread ? (
          <Button type="button" size="sm" variant="secondary" disabled={pending}
            onClick={() => start(async () => { markShown(null); const r = await markAll(); setError(r.error ?? null); })}>
            Mark all read
          </Button>
        ) : null}
      </div>
      {error ? <p role="alert" className="border-b border-border bg-danger-soft px-4 py-2 text-[13px] text-danger">{error}</p> : null}
      <ul className="divide-y divide-border">
        {shown.map((n) => (
          <li key={n.id} className={cn("flex items-start gap-3 px-4 py-3", !n.readAt && "bg-accent-soft/30")}>
            <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-transparent" : "bg-accent")} />
            <form action={n.open} className="min-w-0 flex-1">
              <button className="block w-full text-left">
                <span className={cn("block text-sm", !n.readAt && "font-medium")}>{n.title}{!n.readAt ? <span className="sr-only"> (unread)</span> : null}</span>
                {n.body ? <span className="block truncate text-[13px] text-muted">{n.body}</span> : null}
                <time className="text-xs text-faint" dateTime={n.createdAt} title={n.whenTitle}>{n.when}</time>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
