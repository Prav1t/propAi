"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { Logo } from "@/components/brand/logo";
import { Icon } from "./icons";

export type SidebarSection = { title?: string; items: { label: string; href: string; icon: string }[] };

function NavLinks({ sections, onNavigate }: { sections: SidebarSection[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  // longest matching href wins so /settings doesn't light up for /settings/members
  const all = sections.flatMap((s) => s.items.map((i) => i.href));
  const active = all.filter((h) => pathname === h || pathname.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];
  return (
    <nav aria-label="Main" className="space-y-5">
      {sections.map((s, i) => (
        <div key={i}>
          {s.title ? <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-faint">{s.title}</p> : null}
          <ul className="space-y-0.5">
            {s.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={item.href === active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-[13px] text-muted hover:bg-subtle hover:text-fg",
                    item.href === active && "bg-subtle font-medium text-fg",
                  )}
                >
                  <Icon name={item.icon} />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function OrgSwitcher({ orgName, roleName }: { orgName: string; roleName: string }) {
  return (
    <Link href="/orgs?all=1" className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border px-2.5 py-2 hover:bg-subtle" title="Switch organization">
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{orgName}</span>
        <span className="block truncate text-xs text-faint">{roleName}</span>
      </span>
      <Icon name="chevrons" className="size-4 shrink-0 text-faint" />
    </Link>
  );
}

type Props = { sections: SidebarSection[]; orgName: string; roleName: string };

function Body({ sections, orgName, roleName, onNavigate }: Props & { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="px-1 pt-1"><Logo /></div>
      <OrgSwitcher orgName={orgName} roleName={roleName} />
      <div className="flex-1 overflow-y-auto"><NavLinks sections={sections} onNavigate={onNavigate} /></div>
    </div>
  );
}

// desktop: fixed sidebar (must render outside any transformed/filtered ancestor)
export function DesktopSidebar(props: Props) {
  return (
    <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 border-r border-border bg-surface lg:block">
      <Body {...props} />
    </aside>
  );
}

// mobile: menu button + slide-over drawer
export function MobileNav(props: Props) {
  const [open, setOpen] = useState(false); // links close the drawer via onNavigate
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="rounded-[var(--radius-md)] p-1.5 text-muted hover:bg-subtle lg:hidden" aria-label="Open navigation" aria-expanded={open}>
        <Icon name="menu" className="size-5" />
      </button>
      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85%] border-r border-border bg-surface shadow-xl">
            <button type="button" onClick={() => setOpen(false)} className="absolute right-2 top-2 rounded p-1.5 text-muted hover:bg-subtle" aria-label="Close navigation">
              <Icon name="close" className="size-5" />
            </button>
            <Body {...props} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
