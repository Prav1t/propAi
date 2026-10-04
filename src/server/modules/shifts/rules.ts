// shift validation and "who's on" logic (pure)
export const MAX_SHIFT_HOURS = 16;
export const MAX_ON_CALL_HOURS = 7 * 24;
export const CLOCK_IN_EARLY_MINUTES = 30;

export type ShiftWindow = { startsAt: Date; endsAt: Date; onCall: boolean; status?: string };

export function validateShift(s: ShiftWindow): string | null {
  const hours = (s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000;
  if (!(hours > 0)) return "The shift must end after it starts.";
  const max = s.onCall ? MAX_ON_CALL_HOURS : MAX_SHIFT_HOURS;
  if (hours > max) return s.onCall ? "On-call periods can be at most 7 days." : `Shifts can be at most ${MAX_SHIFT_HOURS} hours.`;
  return null;
}

export const isOnNow = (s: ShiftWindow, now = new Date()) => (s.status ?? "scheduled") === "scheduled" && s.startsAt <= now && now < s.endsAt;

export function clockInProblem(s: ShiftWindow & { clockedInAt: Date | null }, now = new Date()): string | null {
  if ((s.status ?? "scheduled") !== "scheduled") return "This shift was cancelled.";
  if (s.clockedInAt) return "You're already clocked in.";
  if (now.getTime() < s.startsAt.getTime() - CLOCK_IN_EARLY_MINUTES * 60_000) return `You can clock in from ${CLOCK_IN_EARLY_MINUTES} minutes before the shift starts.`;
  if (now >= s.endsAt) return "This shift has ended.";
  return null;
}

// end of a shift entered as start/end clock times: an end at or before the start means the next day
export function endAfterStart(startDate: string, startTime: string, endTime: string, endDate?: string | null): { endDate: string } {
  if (endDate) return { endDate };
  if (endTime > startTime) return { endDate: startDate };
  const [y, m, d] = startDate.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return { endDate: t.toISOString().slice(0, 10) };
}

// hours a shift overlaps a [from, to) window (for weekly totals)
export function overlapHours(s: ShiftWindow, from: Date, to: Date): number {
  const a = Math.max(s.startsAt.getTime(), from.getTime());
  const b = Math.min(s.endsAt.getTime(), to.getTime());
  return b > a ? (b - a) / 3_600_000 : 0;
}
