"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { Icon } from "./icons";
import { LinkPending } from "./sidebar";

type Tab = { label: string; href: string; icon: string; badge?: number };

// phone bottom bar with the places a role goes most (see bottomTabsFor); hidden on wide screens, where the sidebar shows
export function BottomTabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();
  const path = (h: string) => h.split("?")[0];
  const active = tabs.map((t) => path(t.href)).filter((h) => pathname === h || pathname.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];
  return (
    <nav aria-label="Tab bar" className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <ul className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => (
          <li key={t.href}>
            <Link href={t.href} aria-current={path(t.href) === active ? "page" : undefined}
              className={cn("relative flex min-h-14 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px]", path(t.href) === active ? "font-medium text-accent" : "text-muted")}>
              <Icon name={t.icon} className="size-5" />
              <span className="flex items-center gap-1">{t.label}<LinkPending className="size-2.5" /></span>
              {t.badge ? <span className="absolute right-[calc(50%-20px)] top-1 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-accent-fg" aria-label={`${t.badge} new`}>{t.badge > 9 ? "9+" : t.badge}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
