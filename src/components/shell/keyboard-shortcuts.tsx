"use client";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "@/lib/use-focus-trap";
import { Icon } from "./icons";

export type Jump = { key: string; label: string; href: string };

const Key = ({ k }: { k: string }) => <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-border-strong bg-subtle px-1.5 font-sans text-[12px]">{k}</kbd>;

// Single-key shortcuts for people who live in the app: "?" lists them, "g" then a letter goes somewhere, "c" starts
// a new request. They never fire while typing in a field or with a modifier held, and only places this person can
// open are offered.
export function KeyboardShortcuts({ jumps, create }: { jumps: Jump[]; create: { href: string; label: string } | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false); // "g" pressed, waiting for the second key
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useFocusTrap(dialog, open, { onEscape: close });

  useEffect(() => {
    const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [role=dialog]");
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (pending) {
        const j = jumps.find((x) => x.key === e.key.toLowerCase());
        setPending(false);
        if (timer.current) clearTimeout(timer.current);
        if (j) { e.preventDefault(); router.push(j.href); }
        return;
      }
      if (e.key === "?") { e.preventDefault(); setOpen(true); }
      else if (e.key === "g") {
        setPending(true);
        timer.current = setTimeout(() => setPending(false), 1500);
      } else if (e.key === "c" && create) { e.preventDefault(); router.push(create.href); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (timer.current) clearTimeout(timer.current); };
  }, [jumps, create, pending, router]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="hidden size-9 items-center justify-center rounded-[var(--radius-md)] text-muted hover:bg-subtle hover:text-fg lg:inline-flex" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        <Icon name="keyboard" className="size-[18px]" />
      </button>
      {pending ? <span role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-fg px-3 py-1 text-[12px] text-bg shadow">Go to… <span className="opacity-70">(press a letter)</span></span> : null}
      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh]" onMouseDown={close}>
          <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="kbd-title" onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-[var(--radius-lg)] border border-border bg-surface p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="kbd-title" className="text-sm font-semibold">Keyboard shortcuts</h2>
              <button type="button" onClick={close} className="inline-flex size-8 items-center justify-center rounded text-muted hover:bg-subtle" aria-label="Close"><Icon name="close" className="size-4" /></button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
              <dt><Key k="Ctrl" /> <Key k="K" /></dt><dd>Search and commands</dd>
              <dt><Key k="?" /></dt><dd>This list</dd>
              {create ? <><dt><Key k="C" /></dt><dd>{create.label}</dd></> : null}
              <dt><Key k="/" /></dt><dd>Type a question (on the assistant page)</dd>
              {jumps.map((j) => <Fragment key={j.key}><dt><Key k="G" /> <Key k={j.key.toUpperCase()} /></dt><dd>Go to {j.label}</dd></Fragment>)}
            </dl>
            <p className="mt-3 text-[12px] text-faint">Shortcuts don&apos;t fire while you&apos;re typing in a field.</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
