"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { logoutAction } from "@/app/(auth)/actions";
import { Avatar } from "@/components/ui/primitives";
import { clearDrafts } from "@/lib/drafts";

// account menu following the WAI-ARIA menu button pattern: focus moves into the menu, arrow keys move between items,
// Escape closes and returns focus to the button, Tab closes and moves on
export function UserMenu({ name, email, isPlatformAdmin }: { name: string; email: string; isPlatformAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const cleared = useRef(false);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const move = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); button.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };
  const item = "block w-full rounded px-2 py-2 text-left text-[13px] hover:bg-subtle focus:bg-subtle focus:outline-none";
  return (
    <div ref={ref} className="relative">
      <button ref={button} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? "account-menu" : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}
        className="inline-flex size-11 items-center justify-center rounded-[var(--radius-md)] hover:bg-subtle sm:size-9" aria-label="Account menu">
        <Avatar name={name} />
      </button>
      {open ? (
        <div ref={menu} id="account-menu" role="menu" aria-label="Account" onKeyDown={onMenuKey} className="absolute right-0 z-30 mt-1 w-56 rounded-[var(--radius-lg)] border border-border bg-surface p-1 shadow-lg">
          <div className="px-2 py-1.5" role="none">
            <p className="truncate text-[13px] font-medium">{name}</p>
            <p className="truncate text-xs text-faint">{email}</p>
          </div>
          <div className="my-1 h-px bg-border" role="none" />
          <Link role="menuitem" tabIndex={-1} className={item} href="/account" onClick={() => setOpen(false)}>Account settings</Link>
          <Link role="menuitem" tabIndex={-1} className={item} href="/orgs" onClick={() => setOpen(false)}>Switch organization</Link>
          {isPlatformAdmin ? <Link role="menuitem" tabIndex={-1} className={item} href="/admin" onClick={() => setOpen(false)}>Platform admin</Link> : null}
          <div className="my-1 h-px bg-border" role="none" />
          <form action={logoutAction} role="none" onSubmit={async (e) => {
            // requests saved on this device for offline sending go with the session (shared devices)
            if (cleared.current) return;
            e.preventDefault();
            const form = e.currentTarget;
            await clearDrafts();
            cleared.current = true;
            form.requestSubmit();
          }}>
            <button role="menuitem" tabIndex={-1} type="submit" className={item}>Sign out</button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
