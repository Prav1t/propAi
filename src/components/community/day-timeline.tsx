import { cn } from "@/lib/cn";

type Block = { start: Date; end: Date; label: string; tone: "busy" | "mine" | "closed" | "pending" };

const fmt = (d: Date, tz: string) => d.toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" });

// the opening window as a bar with booked/closed blocks; the list underneath carries the same information for screen readers
export function DayTimeline({ window, blocks, tz }: { window: { start: Date; end: Date }; blocks: Block[]; tz: string }) {
  const span = window.end.getTime() - window.start.getTime();
  const pct = (d: Date) => Math.min(100, Math.max(0, ((d.getTime() - window.start.getTime()) / span) * 100));
  const hours: Date[] = [];
  for (let t = Math.ceil(window.start.getTime() / 3_600_000) * 3_600_000; t <= window.end.getTime(); t += 3_600_000) hours.push(new Date(t));
  const step = hours.length > 12 ? 3 : hours.length > 6 ? 2 : 1;
  const tone = { busy: "bg-muted/70", mine: "bg-accent", pending: "bg-warning", closed: "bg-[repeating-linear-gradient(45deg,var(--color-border-strong)_0,var(--color-border-strong)_4px,transparent_4px,transparent_8px)]" };
  return (
    <div className="space-y-2">
      <div aria-hidden className="relative h-9 rounded-[var(--radius-md)] border border-border bg-success-soft/40">
        {blocks.map((b, i) => (
          <div key={i} title={`${b.label}: ${fmt(b.start, tz)}–${fmt(b.end, tz)}`}
            className={cn("absolute inset-y-1 rounded-[3px] ring-2 ring-surface", tone[b.tone])}
            style={{ left: `${pct(b.start)}%`, width: `${Math.max(0.8, pct(b.end) - pct(b.start))}%` }} />
        ))}
      </div>
      <div aria-hidden className="relative h-4 text-[11px] text-faint">
        {hours.filter((_, i) => i % step === 0).map((h) => (
          <span key={h.getTime()} className={cn("absolute tabular-nums", pct(h) < 4 ? "" : pct(h) > 96 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${pct(h)}%` }}>{fmt(h, tz).replace(":00", "")}</span>
        ))}
      </div>
      <ul className="space-y-0.5 text-[13px]">
        {blocks.length === 0 ? <li className="text-muted">Nothing booked — open {fmt(window.start, tz)} to {fmt(window.end, tz)}</li> : blocks.map((b, i) => (
          <li key={i} className="flex items-center gap-2">
            <span aria-hidden className={cn("inline-block size-2.5 rounded-sm", tone[b.tone])} />
            <span className="tabular-nums">{fmt(b.start, tz)}–{fmt(b.end, tz)}</span>
            <span className="text-muted">{b.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
