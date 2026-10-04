// calendar math for preventive-maintenance schedules (dates are YYYY-MM-DD, no time zone)
export type IntervalUnit = "day" | "week" | "month" | "year";

const parse = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return { y, m, day };
};
const fmt = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addDays(date: string, days: number): string {
  const { y, m, day } = parse(date);
  const t = new Date(Date.UTC(y, m - 1, day + days));
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// month/year steps keep the day of month, clamped to the month's length (Jan 31 + 1 month = Feb 28/29)
export function addInterval(date: string, unit: IntervalUnit, count: number): string {
  if (unit === "day") return addDays(date, count);
  if (unit === "week") return addDays(date, count * 7);
  const { y, m, day } = parse(date);
  const months = unit === "month" ? count : count * 12;
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

// due for a work order once today is within lead_days of the due date
export const isDue = (nextDueOn: string, leadDays: number, today: string) => addDays(nextDueOn, -leadDays) <= today;

export type Generation = { dueOn: string; nextDueOn: string; skipped: number };

// which occurrence a work order is opened for, and the schedule's next due date afterwards.
// Occurrences missed while nothing ran are skipped: one work order for the latest due one, never a backlog.
export function planGeneration(s: { nextDueOn: string; intervalUnit: IntervalUnit; intervalCount: number; leadDays: number }, today: string): Generation | null {
  if (!isDue(s.nextDueOn, s.leadDays, today)) return null;
  let occ = s.nextDueOn;
  let skipped = 0;
  for (let guard = 0; guard < 5000; guard++) {
    const next = addInterval(occ, s.intervalUnit, s.intervalCount);
    if (!isDue(next, s.leadDays, today)) return { dueOn: occ, nextDueOn: next, skipped };
    occ = next;
    skipped++;
  }
  throw new Error("schedule interval too small");
}

export const describeInterval = (unit: IntervalUnit, count: number) =>
  count === 1 ? { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[unit] : `Every ${count} ${unit}s`;

// whole days between two YYYY-MM-DD dates (b - a)
export const daysBetween = (a: string, b: string) => {
  const pa = parse(a);
  const pb = parse(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.day) - Date.UTC(pa.y, pa.m - 1, pa.day)) / 86_400_000);
};
