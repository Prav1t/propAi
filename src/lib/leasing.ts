// Leases and rent: labels and date arithmetic. Pure, shared by server and pages. Dates are ISO days (YYYY-MM-DD) in
// the organization's own calendar; nothing here depends on the server's time zone.

export const LEASE_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "accent" }> = {
  active: { label: "Active", tone: "success" }, notice: { label: "Notice given", tone: "warning" }, ended: { label: "Ended", tone: "neutral" }, upcoming: { label: "Starts later", tone: "accent" },
};

export const money = (cents: number, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency, minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(cents / 100);

const pad = (n: number) => String(n).padStart(2, "0");
export const monthStart = (isoDay: string) => `${isoDay.slice(0, 7)}-01`;
export function addMonths(isoMonthStart: string, n: number): string {
  const y = Number(isoMonthStart.slice(0, 4)), m = Number(isoMonthStart.slice(5, 7)) - 1 + n;
  return `${y + Math.floor(m / 12)}-${pad(((m % 12) + 12) % 12 + 1)}-01`;
}
export const dueDate = (period: string, dueDay: number) => `${period.slice(0, 7)}-${pad(Math.min(28, Math.max(1, dueDay)))}`;
export function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const monthLabel = (period: string) => new Date(`${period}T00:00:00Z`).toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" });

// The months a lease is charged for, up to and including the month of `today`: every month from the one it starts
// in to the one it ends in (or the tenant moves out). Whole months only: a mid-month start or end is not pro-rated.
export function chargePeriods(lease: { startsOn: string; endsOn: string | null; moveOutOn: string | null }, today: string, max = 36): string[] {
  const last = [monthStart(today), lease.moveOutOn ? monthStart(lease.moveOutOn) : null, lease.endsOn && !lease.moveOutOn ? monthStart(lease.endsOn) : null].filter(Boolean).sort()[0] as string;
  const out: string[] = [];
  for (let p = monthStart(lease.startsOn); p <= last && out.length < max; p = addMonths(p, 1)) out.push(p);
  return out;
}

export type ChargeState = "paid" | "partial" | "overdue" | "due";
export function chargeState(c: { amountCents: number; paidCents: number; dueOn: string }, today: string): ChargeState {
  if (c.paidCents >= c.amountCents) return "paid";
  if (c.dueOn < today) return "overdue";
  return c.paidCents > 0 ? "partial" : "due";
}
export const CHARGE_STATE: Record<ChargeState, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  paid: { label: "Paid", tone: "success" }, partial: { label: "Part paid", tone: "warning" }, overdue: { label: "Overdue", tone: "danger" }, due: { label: "Due", tone: "neutral" },
};

// today's date in a time zone, as an ISO day
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
