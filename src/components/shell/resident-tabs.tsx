"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";

type Tab = { label: string; href: string; icon: string; badge?: number };

// phone bottom bar for residents: the five things they do most
export function ResidentTabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();
  const active = tabs.map((t) => t.href).filter((h) => pathname === h || pathname.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];
  return (
    <nav aria-label="Tab bar" className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => (
          <li key={t.href}>
            <Link href={t.href} aria-current={t.href === active ? "page" : undefined}
              className={cn("relative flex flex-col items-center gap-0.5 py-2 text-[11px]", t.href === active ? "text-accent" : "text-muted")}>
              <Icon name={t.icon} className="size-5" />
              {t.label}
              {t.badge ? <span className="absolute right-[calc(50%-18px)] top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-accent-fg">{t.badge > 9 ? "9+" : t.badge}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
