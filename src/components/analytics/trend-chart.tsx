"use client";
import { useEffect, useId, useRef, useState } from "react";

// Line chart for one or two series over time (Iteration 9). 2px lines, hairline grid, one y-axis, a legend for
// two series, end labels, a crosshair tooltip on hover and keyboard focus, and a table view so nothing is hover-only.

export type TrendSeries = { key: string; label: string; values: (number | null)[] };

const COLORS = ["var(--color-series-1)", "var(--color-series-2)"];
const H = 200;
const PAD = { top: 12, right: 44, bottom: 24, left: 40 };

function niceMax(v: number) {
  if (v <= 0) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => v / m <= 4) ?? 10 * pow;
  return Math.ceil(v / step) * step;
}
const compact = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}K` : String(Math.round(v * 10) / 10));
const FORMAT = {
  count: compact, hours: (v: number) => `${compact(v)} h`, percent: (v: number) => `${Math.round(v)}%`, currency: (v: number) => `$${compact(v)}`,
};

export function TrendChart({ title, series, labels, unit = "count", unitLabel }: {
  title: string; series: TrendSeries[]; labels: string[]; unit?: keyof typeof FORMAT; unitLabel?: string;
}) {
  const format = FORMAT[unit];
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = labels.length;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = niceMax(Math.max(0, ...all));
  const iw = w - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const path = (vals: (number | null)[]) => vals.reduce((d, v, i) => (v === null ? d : `${d}${d && vals[i - 1] !== null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`), "");
  const xTicks = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : [...Array(n).keys()];
  const lastIdx = (vals: (number | null)[]) => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return i; return -1; };

  // end labels only when they don't collide; otherwise the legend and tooltip carry identity
  const ends = series.map((s, si) => ({ si, i: lastIdx(s.values) })).filter((e) => e.i >= 0);
  const endY = ends.map((e) => y(series[e.si].values[e.i] as number));
  const endLabels = ends.length < 2 || Math.abs(endY[0] - endY[1]) >= 14;

  const onMove = (clientX: number) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r || n === 0) return;
    const rel = clientX - r.left - PAD.left;
    setHover(Math.max(0, Math.min(n - 1, Math.round((rel / Math.max(1, iw)) * (n - 1)))));
  };

  return (
    <figure className="px-4 pb-3 pt-2">
      <figcaption className="sr-only">{title}</figcaption>
      {series.length > 1 ? (
        <ul className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted" aria-label="Legend">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5"><svg width="14" height="4" aria-hidden><line x1="0" y1="2" x2="14" y2="2" stroke={COLORS[i]} strokeWidth="2" strokeLinecap="round" /></svg>{s.label}</li>
          ))}
        </ul>
      ) : null}
      <div ref={wrap} className="relative" onPointerMove={(e) => onMove(e.clientX)} onPointerLeave={() => setHover(null)}>
        <svg
          width={w} height={H} role="img" aria-labelledby={`${id}-t`} tabIndex={0} className="block max-w-full outline-offset-2"
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
            if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n) - 1));
            if (e.key === "Escape") setHover(null);
          }}
          onBlur={() => setHover(null)}
        >
          <title id={`${id}-t`}>{`${title}. Use the table below for every value.`}</title>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={w - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--color-grid)" strokeWidth="1" />
              <text x={PAD.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize="11" fill="var(--color-faint)">{format(t)}</text>
            </g>
          ))}
          {xTicks.map((i) => (
            <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="11" fill="var(--color-faint)">{labels[i]}</text>
          ))}
          {series.map((s, si) => <path key={s.key} d={path(s.values)} fill="none" stroke={COLORS[si]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
          {ends.map((e) => {
            const v = series[e.si].values[e.i] as number;
            return (
              <g key={e.si}>
                <circle cx={x(e.i)} cy={y(v)} r="4" fill={COLORS[e.si]} stroke="var(--color-surface)" strokeWidth="2" />
                {endLabels ? <text x={x(e.i) + 8} y={y(v) + 4} fontSize="11" fontWeight="600" fill="var(--color-fg)">{format(v)}</text> : null}
              </g>
            );
          })}
          {hover !== null ? (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} stroke="var(--color-border-strong)" strokeWidth="1" />
              {series.map((s, si) => (s.values[hover] !== null ? <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] as number)} r="4" fill={COLORS[si]} stroke="var(--color-surface)" strokeWidth="2" /> : null))}
            </g>
          ) : null}
        </svg>
        {hover !== null ? (
          <div role="status" className="pointer-events-none absolute top-1 z-10 min-w-32 rounded-[var(--radius-md)] border border-border bg-surface px-2.5 py-1.5 text-[12px] shadow-sm"
            style={{ left: Math.min(Math.max(0, x(hover) + 10), w - 150) }}>
            <p className="mb-0.5 text-faint">{labels[hover]}</p>
            {series.map((s, si) => (
              <p key={s.key} className="flex items-center gap-1.5">
                <svg width="10" height="4" aria-hidden><line x1="0" y1="2" x2="10" y2="2" stroke={COLORS[si]} strokeWidth="2" strokeLinecap="round" /></svg>
                <strong className="tabular-nums">{s.values[hover] === null ? "—" : format(s.values[hover] as number)}</strong>
                <span className="text-muted">{s.label}</span>
              </p>
            ))}
          </div>
        ) : null}
      </div>
      <details className="mt-1 text-[12px]">
        <summary className="cursor-pointer text-muted hover:text-fg">Show as table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left tabular-nums">
            <thead><tr className="text-faint"><th className="py-1 pr-3 font-medium">{unitLabel ?? "Period"}</th>{series.map((s) => <th key={s.key} className="py-1 pr-3 text-right font-medium">{s.label}</th>)}</tr></thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={l} className="border-t border-border">
                  <td className="py-1 pr-3">{l}</td>
                  {series.map((s) => <td key={s.key} className="py-1 pr-3 text-right">{s.values[i] === null ? "—" : format(s.values[i] as number)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
