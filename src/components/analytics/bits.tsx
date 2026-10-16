import Link from "next/link";
import { cn } from "@/lib/cn";
import { fmtChange, fmtValue, type MetricValue } from "@/server/analytics/metrics";
import { HEALTH_GRADE, type HealthGrade } from "@/lib/analytics-labels";

// a KPI tile: the number, its change against the previous period (coloured by whether that's good), and the definition on hover
export function MetricTile({ m, href, periodDays }: { m: MetricValue; href?: string; periodDays: number }) {
  const ch = fmtChange(m);
  const inner = (
    <div className="h-full rounded-[var(--radius-lg)] border border-border bg-surface px-4 py-3" title={m.description}>
      <p className="text-[12px] text-muted">{m.label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{fmtValue(m.value, m.unit)}</p>
      <p className="mt-0.5 text-[11px] text-faint">
        {m.snapshot ? "right now" : ch ? (
          <>
            <span className={cn("font-medium", ch.tone === "success" && "text-success", ch.tone === "danger" && "text-danger", ch.tone === "neutral" && "text-muted")}>{ch.text}</span>
            {" "}vs previous {periodDays} days{m.previous !== null && m.change !== null ? ` (${fmtValue(m.previous, m.unit)})` : ""}
          </>
        ) : "no earlier data"}
      </p>
    </div>
  );
  return href ? <Link href={href} className="block rounded-[var(--radius-lg)] [&>div]:hover:border-border-strong">{inner}</Link> : inner;
}

export function HealthBadge({ score, grade }: { score: number | null; grade: HealthGrade | null }) {
  if (score === null || !grade) return <span className="text-[13px] text-faint">Not enough data</span>;
  const g = HEALTH_GRADE[grade];
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-base font-semibold tabular-nums">{score}</span>
      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", g.tone === "success" && "bg-success-soft text-success", g.tone === "warning" && "bg-warning-soft text-warning", g.tone === "danger" && "bg-danger-soft text-danger")}>{g.label}</span>
    </span>
  );
}

// 0–100 meter: the track is a light step of the fill's own hue
export function Meter({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <span className="text-[12px] text-faint">—</span>;
  const tone = value >= 80 ? "success" : value >= 60 ? "warning" : "danger";
  return (
    <span className="flex items-center gap-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
      <span className={cn("h-1.5 w-20 overflow-hidden rounded-full", tone === "success" && "bg-success-soft", tone === "warning" && "bg-warning-soft", tone === "danger" && "bg-danger-soft")}>
        <span className={cn("block h-full rounded-full", tone === "success" && "bg-success", tone === "warning" && "bg-warning", tone === "danger" && "bg-danger")} style={{ width: `${Math.max(2, value)}%` }} />
      </span>
      <span className="w-7 text-right text-[12px] tabular-nums text-muted">{value}</span>
    </span>
  );
}

export function SectionTitle({ id, children, action }: { id: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h2 id={id} className="text-sm font-semibold">{children}</h2>
      {action}
    </div>
  );
}
