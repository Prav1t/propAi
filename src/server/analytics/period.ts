// Reporting periods (pure, unit-tested). A period is [from, to) in UTC, built from whole local days in the org's zone.
import { zonedToUtc } from "@/lib/time";

export const PERIOD_PRESETS = ["7d", "30d", "90d", "365d", "mtd", "qtd", "ytd"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export type Bucket = "day" | "week" | "month";

export type Period = {
  from: Date; to: Date; // [from, to)
  fromDate: string; toDate: string; // inclusive local dates, YYYY-MM-DD
  days: number; label: string; bucket: Bucket;
};

export const PRESET_LABEL: Record<PeriodPreset, string> = {
  "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", "365d": "Last 12 months", mtd: "This month", qtd: "This quarter", ytd: "This year",
};

export const localDate = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000) + 1;
}

const dayStart = (iso: string, tz: string) => zonedToUtc(`${iso}T00:00`, tz);

export const bucketFor = (days: number): Bucket => (days <= 31 ? "day" : days <= 120 ? "week" : "month");

function fmtDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

// inclusive local dates → [from, to)
export function periodFromDates(fromDate: string, toDate: string, timeZone: string, label?: string): Period {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) throw new Error("invalid period");
  const days = daysBetween(fromDate, toDate);
  return {
    from: dayStart(fromDate, timeZone), to: dayStart(addDays(toDate, 1), timeZone), fromDate, toDate, days,
    label: label ?? `${fmtDay(fromDate)} – ${fmtDay(toDate)}`, bucket: bucketFor(days),
  };
}

export function resolvePeriod(preset: PeriodPreset, timeZone: string, now = new Date()): Period {
  const today = localDate(now, timeZone);
  const [y, m] = today.split("-").map(Number);
  const start = (() => {
    switch (preset) {
      case "7d": return addDays(today, -6);
      case "30d": return addDays(today, -29);
      case "90d": return addDays(today, -89);
      case "365d": return addDays(today, -364);
      case "mtd": return `${today.slice(0, 7)}-01`;
      case "qtd": return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
      case "ytd": return `${y}-01-01`;
    }
  })();
  return periodFromDates(start, today, timeZone, PRESET_LABEL[preset]);
}

// the same number of days immediately before
export function previousPeriod(p: Period, timeZone: string): Period {
  const toDate = addDays(p.fromDate, -1);
  const fromDate = addDays(toDate, -(p.days - 1));
  return periodFromDates(fromDate, toDate, timeZone, `previous ${p.days} days`);
}

// the matching span of the previous quarter ("this quarter so far" vs "the same days of last quarter")
export function previousQuarterSpan(p: Period, timeZone: string): Period {
  const [y, m] = p.fromDate.split("-").map(Number);
  const prevStart = new Date(Date.UTC(y, m - 1 - 3, 1)).toISOString().slice(0, 10);
  const prevEnd = addDays(prevStart, p.days - 1);
  return periodFromDates(prevStart, prevEnd, timeZone);
}

// relative change in percent; null when there's no baseline to compare with
export function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

// bucket start dates (local, YYYY-MM-DD) covering the period, matching Postgres date_trunc
export function bucketStarts(p: Period, bucket: Bucket = p.bucket): string[] {
  const out: string[] = [];
  const startOf = (iso: string) => {
    if (bucket === "day") return iso;
    if (bucket === "month") return `${iso.slice(0, 7)}-01`;
    const [y, m, d] = iso.split("-").map(Number);
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0, like date_trunc('week')
    return addDays(iso, -dow);
  };
  let cur = startOf(p.fromDate);
  while (cur <= p.toDate) {
    out.push(cur);
    if (bucket === "day") cur = addDays(cur, 1);
    else if (bucket === "week") cur = addDays(cur, 7);
    else {
      const [y, m] = cur.split("-").map(Number);
      cur = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    }
  }
  return out;
}

export function bucketLabel(iso: string, bucket: Bucket): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (bucket === "month") return dt.toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", year: "2-digit" });
  return dt.toLocaleDateString("en-CA", { timeZone: "UTC", month: "short", day: "numeric" });
}
