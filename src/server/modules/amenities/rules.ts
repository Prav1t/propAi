// pure booking rules: no I/O, fully unit-tested; services load the context and call evaluateBooking()
import { zonedToUtc } from "@/lib/time";

export type AmenityRules = {
  active: boolean;
  opensAtMinute: number; closesAtMinute: number; slotMinutes: number;
  minDurationMinutes: number; maxDurationMinutes: number;
  minNoticeHours: number; maxAdvanceDays: number;
  maxConcurrent: number; capacity: number | null;
  limitCount: number | null; limitPeriodDays: number | null;
  requiresApproval: boolean; feeCents: number; depositCents: number;
  eligibleRoles: string[]; cancellationHours: number;
};

export type BookingRequest = { start: Date; end: Date; guests: number; roleKey: string; staff: boolean; now: Date; timeZone: string };
export type Interval = { start: Date; end: Date };
export type BookingContext = { overlapping: Interval[]; blackouts: (Interval & { reason: string })[]; unitBookingsInPeriod: number };
export type Problem = { code: string; message: string };
export type Decision = { ok: boolean; problems: Problem[]; status: "approved" | "requested"; feeCents: number; depositCents: number };

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// local calendar date and minute-of-day of an instant in a time zone
export function localParts(d: Date, timeZone: string): { date: string; minute: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(d).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

export const fmtMinute = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const parseMinute = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || +m[1] > 24 || +m[2] > 59 || (+m[1] === 24 && +m[2] > 0)) return null;
  return +m[1] * 60 + +m[2];
};

// opening window of an amenity on a local date, as UTC instants
export function dayWindow(rules: Pick<AmenityRules, "opensAtMinute" | "closesAtMinute">, date: string, timeZone: string): Interval {
  // 24:00 is the next local midnight (23 or 25 hours later on DST days)
  const at = (m: number) => (m >= 1440 ? zonedToUtc(`${nextDate(date)}T00:00`, timeZone) : zonedToUtc(`${date}T${fmtMinute(m)}`, timeZone));
  return { start: at(rules.opensAtMinute), end: at(rules.closesAtMinute) };
}

export function nextDate(date: string, days = 1): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

// most bookings in use at the same moment during `window`
export function peakConcurrency(window: Interval, others: Interval[]): number {
  const edges: [number, number][] = [];
  for (const o of others) {
    if (!overlaps(window, o)) continue;
    edges.push([Math.max(o.start.getTime(), window.start.getTime()), 1], [Math.min(o.end.getTime(), window.end.getTime()), -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at the same instant
  let cur = 0, peak = 0;
  for (const [, d] of edges) { cur += d; peak = Math.max(peak, cur); }
  return peak;
}

const ROLE_LABEL: Record<string, string> = { owner: "owners", tenant: "tenants", resident: "residents", occupant: "occupants" };
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

// every rule that fails is reported (not just the first) so the person can fix them together
export function evaluateBooking(r: AmenityRules, q: BookingRequest, ctx: BookingContext): Decision {
  const problems: Problem[] = [];
  const add = (code: string, message: string) => problems.push({ code, message });
  const durMin = (q.end.getTime() - q.start.getTime()) / MIN;

  if (!r.active) add("inactive", "This amenity isn't taking bookings right now.");
  if (!(durMin > 0)) add("range", "The end time must be after the start time.");
  else {
    if (durMin < r.minDurationMinutes) add("too_short", `Bookings must be at least ${r.minDurationMinutes} minutes.`);
    if (durMin > r.maxDurationMinutes) add("too_long", `Bookings can be at most ${r.maxDurationMinutes / 60 >= 1 && r.maxDurationMinutes % 60 === 0 ? `${r.maxDurationMinutes / 60} hours` : `${r.maxDurationMinutes} minutes`}.`);
    const s = localParts(q.start, q.timeZone);
    const e = localParts(new Date(q.end.getTime() - 1), q.timeZone);
    const endMinute = e.minute + 1; // the minute containing end-1ms, exclusive
    if (s.date !== e.date) add("multi_day", "A booking must start and end on the same day.");
    else if (s.minute < r.opensAtMinute || endMinute > r.closesAtMinute) add("hours", `Open ${fmtMinute(r.opensAtMinute)}–${fmtMinute(r.closesAtMinute)}.`);
    if ((s.minute - r.opensAtMinute) % r.slotMinutes !== 0 || durMin % r.slotMinutes !== 0) add("slot", `Choose times in ${r.slotMinutes}-minute steps.`);
  }
  if (q.start.getTime() < q.now.getTime()) add("past", "That time has already passed.");
  else if (!q.staff) {
    if (q.start.getTime() < q.now.getTime() + r.minNoticeHours * HOUR) add("notice", `Book at least ${r.minNoticeHours} hour${r.minNoticeHours === 1 ? "" : "s"} ahead.`);
    if (q.start.getTime() > q.now.getTime() + r.maxAdvanceDays * DAY) add("advance", `Bookings open ${r.maxAdvanceDays} days ahead.`);
  }
  if (!q.staff && r.eligibleRoles.length && !r.eligibleRoles.includes(q.roleKey)) {
    add("eligibility", `Only ${r.eligibleRoles.map((x) => ROLE_LABEL[x] ?? x).join(" and ")} can book this amenity.`);
  }
  if (r.capacity !== null && q.guests > r.capacity) add("capacity", `At most ${r.capacity} people per booking.`);
  if (q.guests < 1) add("guests", "Enter how many people will attend.");
  const req: Interval = { start: q.start, end: q.end };
  const closed = ctx.blackouts.find((b) => overlaps(req, b));
  if (closed) add("blackout", `Closed at that time: ${closed.reason}.`);
  if (durMin > 0 && peakConcurrency(req, ctx.overlapping) + 1 > r.maxConcurrent) {
    add("conflict", r.maxConcurrent === 1 ? "Someone has already booked that time." : "That time is fully booked.");
  }
  if (!q.staff && r.limitCount !== null && r.limitPeriodDays !== null && ctx.unitBookingsInPeriod >= r.limitCount) {
    add("limit", `Each unit can hold ${r.limitCount} booking${r.limitCount === 1 ? "" : "s"} within ${r.limitPeriodDays} days of each other.`);
  }
  return {
    ok: problems.length === 0,
    problems,
    status: q.staff || !r.requiresApproval ? "approved" : "requested",
    feeCents: r.feeCents,
    depositCents: r.depositCents,
  };
}

// plain-language summary of the rules a resident should know before booking
export function describeRules(r: AmenityRules): string[] {
  const out = [`Open ${fmtMinute(r.opensAtMinute)}–${fmtMinute(r.closesAtMinute)}, in ${r.slotMinutes}-minute steps.`];
  out.push(`${r.minDurationMinutes === r.maxDurationMinutes ? `${r.minDurationMinutes} minutes` : `${r.minDurationMinutes} min to ${r.maxDurationMinutes / 60} h`} per booking.`);
  if (r.minNoticeHours) out.push(`Book at least ${r.minNoticeHours} h ahead.`);
  out.push(`Bookings open ${r.maxAdvanceDays} days ahead.`);
  if (r.capacity) out.push(`Up to ${r.capacity} people.`);
  if (r.maxConcurrent > 1) out.push(`Shared: up to ${r.maxConcurrent} bookings at once.`);
  if (r.limitCount && r.limitPeriodDays) out.push(`Limit ${r.limitCount} per unit within ${r.limitPeriodDays} days.`);
  if (r.requiresApproval) out.push("Management approves each booking.");
  if (r.feeCents) out.push(`Fee ${money(r.feeCents)}.`);
  if (r.depositCents) out.push(`Refundable deposit ${money(r.depositCents)}.`);
  out.push(`Cancel up to ${r.cancellationHours} h before the start.`);
  if (r.eligibleRoles.length) out.push(`For ${r.eligibleRoles.map((x) => ROLE_LABEL[x] ?? x).join(" and ")} only.`);
  return out;
}

export const canResidentCancel = (startsAt: Date, cancellationHours: number, now = new Date()) =>
  startsAt.getTime() - now.getTime() >= cancellationHours * HOUR;

export const formatMoney = money;
