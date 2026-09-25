"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { logoutAction } from "@/app/(auth)/actions";
import { Avatar } from "@/components/ui/primitives";

// accessible disclosure menu for account actions
export function UserMenu({ name, email, isPlatformAdmin }: { name: string; email: string; isPlatformAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, []);
  const item = "block w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-subtle";
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-[var(--radius-md)] p-1 hover:bg-subtle" aria-label="Account menu">
        <Avatar name={name} />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-56 rounded-[var(--radius-lg)] border border-border bg-surface p-1 shadow-lg">
          <div className="px-2 py-1.5">
            <p className="truncate text-[13px] font-medium">{name}</p>
            <p className="truncate text-xs text-faint">{email}</p>
          </div>
          <div className="my-1 h-px bg-border" />
          <Link role="menuitem" className={item} href="/account" onClick={() => setOpen(false)}>Account settings</Link>
          <Link role="menuitem" className={item} href="/orgs" onClick={() => setOpen(false)}>Switch organization</Link>
          {isPlatformAdmin ? <Link role="menuitem" className={item} href="/admin" onClick={() => setOpen(false)}>Platform admin</Link> : null}
          <div className="my-1 h-px bg-border" />
          <form action={logoutAction}>
            <button role="menuitem" type="submit" className={item}>Sign out</button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
