"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionState } from "@/lib/action-state";
import { deleteDraft, draftsAvailable, formFromDraft, isNetworkError, listDrafts, saveDraft, type Draft } from "@/lib/drafts";

type Sent = { title: string; number: number; href: string; uploadFailed: boolean };

// requests saved on this device while offline: sent automatically when the connection comes back (oldest first),
// with a banner saying what's waiting and what went through
export function DraftSync({ userId, orgSlug, send }: { userId: string; orgSlug: string; send: (fd: FormData) => Promise<ActionState> }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [sent, setSent] = useState<Sent[]>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const refresh = useCallback(async () => {
    if (!draftsAvailable()) return;
    setDrafts(await listDrafts(userId, orgSlug).catch(() => []));
  }, [userId, orgSlug]);

  const flush = useCallback(async () => {
    if (running.current || !draftsAvailable() || !navigator.onLine) return;
    running.current = true;
    setBusy(true);
    try {
      for (const d of await listDrafts(userId, orgSlug)) {
        let r: ActionState;
        try {
          r = await send(formFromDraft(d));
        } catch (e) {
          if (isNetworkError(e)) break; // still offline: try again on the next "online"
          throw e;
        }
        if (r.ok) {
          await deleteDraft(d.id);
          const data = r.data as { number: number; href: string; uploadFailed: boolean };
          setSent((s) => [...s, { title: d.title, number: data.number, href: data.href, uploadFailed: data.uploadFailed }]);
        } else {
          // the server refused it (no longer allowed, a field is invalid): keep it and say why
          await saveDraft({ ...d, lastError: r.error ?? "It couldn't be sent." });
        }
      }
    } finally {
      running.current = false;
      setBusy(false);
      await refresh();
    }
  }, [userId, orgSlug, send, refresh]);

  useEffect(() => {
    // initial load and send happen after mount: IndexedDB exists only in the browser
    queueMicrotask(() => { void refresh().then(flush); });
    const onChange = () => void refresh();
    const onOnline = () => void flush();
    window.addEventListener("drafts-changed", onChange);
    window.addEventListener("online", onOnline);
    return () => { window.removeEventListener("drafts-changed", onChange); window.removeEventListener("online", onOnline); };
  }, [refresh, flush]);

  if (!drafts.length && !sent.length) return null;
  const failed = drafts.filter((d) => d.lastError);
  const waiting = drafts.filter((d) => !d.lastError);
  return (
    <div role="status" aria-live="polite" data-testid="draft-sync" className="border-b border-border bg-accent-soft/60 px-4 py-2 text-[13px]">
      {waiting.length ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span><strong className="font-semibold">{waiting.length} request{waiting.length === 1 ? "" : "s"} saved on this device</strong> {busy ? "— sending…" : "— will be sent when you're back online."}</span>
          {!busy ? <button type="button" className="font-medium text-accent underline" onClick={() => void flush()}>Send now</button> : null}
        </p>
      ) : null}
      {failed.map((d) => (
        <p key={d.id} className="mt-1 flex flex-wrap items-center gap-x-3 text-danger">
          <span>“{d.title}” couldn&apos;t be sent: {d.lastError}</span>
          <button type="button" className="font-medium underline" onClick={async () => { await deleteDraft(d.id); await refresh(); }}>Discard</button>
        </p>
      ))}
      {sent.map((s) => (
        <p key={s.href} className="mt-1 flex flex-wrap items-center gap-x-3">
          <span>Sent “{s.title}” as request #{s.number}.{s.uploadFailed ? " Its photos didn't upload — add them on the request." : ""}</span>
          <Link href={s.href} className="font-medium text-accent underline">View</Link>
          <button type="button" className="text-muted underline" onClick={() => setSent((x) => x.filter((y) => y.href !== s.href))}>Dismiss</button>
        </p>
      ))}
    </div>
  );
}
