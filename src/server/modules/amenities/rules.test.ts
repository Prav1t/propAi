import { describe, expect, it } from "vitest";
import { canResidentCancel, dayWindow, describeRules, evaluateBooking, localParts, parseMinute, peakConcurrency, type AmenityRules } from "./rules";
import { zonedToUtc } from "@/lib/time";

const TZ = "America/Vancouver";
const at = (local: string) => zonedToUtc(local, TZ);
const base: AmenityRules = {
  active: true, opensAtMinute: 8 * 60, closesAtMinute: 23 * 60, slotMinutes: 30, minDurationMinutes: 60, maxDurationMinutes: 240,
  minNoticeHours: 24, maxAdvanceDays: 60, maxConcurrent: 1, capacity: 40, limitCount: 2, limitPeriodDays: 30,
  requiresApproval: true, feeCents: 5000, depositCents: 25000, eligibleRoles: [], cancellationHours: 48,
};
const now = at("2026-10-01T10:00");
const req = (s: string, e: string, extra: Partial<Parameters<typeof evaluateBooking>[1]> = {}) => ({ start: at(s), end: at(e), guests: 10, roleKey: "resident", staff: false, now, timeZone: TZ, ...extra });
const empty = { overlapping: [], blackouts: [], unitBookingsInPeriod: 0 };
const codes = (d: ReturnType<typeof evaluateBooking>) => d.problems.map((p) => p.code);

describe("evaluateBooking", () => {
  it("accepts a valid request and asks for approval when configured", () => {
    const d = evaluateBooking(base, req("2026-10-03T18:00", "2026-10-03T22:00"), empty);
    expect(d.ok).toBe(true);
    expect(d.status).toBe("requested");
    expect(d.feeCents).toBe(5000);
    expect(evaluateBooking({ ...base, requiresApproval: false }, req("2026-10-03T18:00", "2026-10-03T22:00"), empty).status).toBe("approved");
  });
  it("enforces opening hours in the property's time zone", () => {
    expect(codes(evaluateBooking(base, req("2026-10-03T07:00", "2026-10-03T09:00"), empty))).toContain("hours");
    expect(codes(evaluateBooking(base, req("2026-10-03T21:30", "2026-10-03T23:30"), empty))).toContain("hours");
    expect(evaluateBooking(base, req("2026-10-03T21:00", "2026-10-03T23:00"), empty).ok).toBe(true);
  });
  it("allows bookings ending exactly at midnight when open until 24:00", () => {
    const late = { ...base, closesAtMinute: 1440 };
    expect(evaluateBooking(late, req("2026-10-03T22:00", "2026-10-04T00:00"), empty).ok).toBe(true);
    expect(codes(evaluateBooking(late, req("2026-10-03T23:00", "2026-10-04T01:00"), empty))).toContain("multi_day");
  });
  it("enforces duration and slot steps", () => {
    expect(codes(evaluateBooking(base, req("2026-10-03T18:00", "2026-10-03T18:30"), empty))).toContain("too_short");
    expect(codes(evaluateBooking(base, req("2026-10-03T10:00", "2026-10-03T15:00"), empty))).toContain("too_long");
    expect(codes(evaluateBooking(base, req("2026-10-03T18:15", "2026-10-03T19:45"), empty))).toContain("slot");
    expect(codes(evaluateBooking(base, req("2026-10-03T18:00", "2026-10-03T17:00"), empty))).toContain("range");
  });
  it("enforces notice and the booking window for residents but not staff", () => {
    expect(codes(evaluateBooking(base, req("2026-10-01T18:00", "2026-10-01T20:00"), empty))).toContain("notice");
    expect(codes(evaluateBooking(base, req("2026-12-15T18:00", "2026-12-15T20:00"), empty))).toContain("advance");
    expect(evaluateBooking(base, req("2026-10-01T18:00", "2026-10-01T20:00", { staff: true }), empty).ok).toBe(true);
    expect(codes(evaluateBooking(base, req("2026-09-30T18:00", "2026-09-30T20:00", { staff: true }), empty))).toContain("past");
  });
  it("staff bookings are approved immediately", () => {
    expect(evaluateBooking(base, req("2026-10-03T18:00", "2026-10-03T20:00", { staff: true }), empty).status).toBe("approved");
  });
  it("blocks overlaps on exclusive amenities but allows back-to-back", () => {
    const busy = { ...empty, overlapping: [{ start: at("2026-10-03T18:00"), end: at("2026-10-03T20:00") }] };
    expect(codes(evaluateBooking(base, req("2026-10-03T19:00", "2026-10-03T21:00"), busy))).toContain("conflict");
    expect(evaluateBooking(base, req("2026-10-03T20:00", "2026-10-03T22:00"), busy).ok).toBe(true);
  });
  it("shared amenities allow up to maxConcurrent overlapping bookings", () => {
    const gym = { ...base, maxConcurrent: 2, requiresApproval: false };
    const one = { ...empty, overlapping: [{ start: at("2026-10-03T18:00"), end: at("2026-10-03T19:00") }] };
    expect(evaluateBooking(gym, req("2026-10-03T18:00", "2026-10-03T19:00"), one).ok).toBe(true);
    const two = { ...empty, overlapping: [...one.overlapping, { start: at("2026-10-03T18:30"), end: at("2026-10-03T19:30") }] };
    expect(codes(evaluateBooking(gym, req("2026-10-03T18:00", "2026-10-03T19:00"), two))).toContain("conflict");
    // two bookings that don't overlap each other only make one concurrent at a time
    const apart = { ...empty, overlapping: [{ start: at("2026-10-03T18:00"), end: at("2026-10-03T18:30") }, { start: at("2026-10-03T18:30"), end: at("2026-10-03T19:00") }] };
    expect(evaluateBooking(gym, req("2026-10-03T18:00", "2026-10-03T19:00"), apart).ok).toBe(true);
  });
  it("respects blackouts, capacity, eligibility and per-unit limits", () => {
    const closed = { ...empty, blackouts: [{ start: at("2026-10-03T00:00"), end: at("2026-10-04T00:00"), reason: "floor refinishing" }] };
    const d = evaluateBooking(base, req("2026-10-03T18:00", "2026-10-03T20:00"), closed);
    expect(d.problems.find((p) => p.code === "blackout")?.message).toContain("floor refinishing");
    expect(codes(evaluateBooking(base, req("2026-10-03T18:00", "2026-10-03T20:00", { guests: 41 }), empty))).toContain("capacity");
    expect(codes(evaluateBooking({ ...base, eligibleRoles: ["owner"] }, req("2026-10-03T18:00", "2026-10-03T20:00"), empty))).toContain("eligibility");
    expect(evaluateBooking({ ...base, eligibleRoles: ["owner"] }, req("2026-10-03T18:00", "2026-10-03T20:00", { roleKey: "owner" }), empty).ok).toBe(true);
    expect(codes(evaluateBooking(base, req("2026-10-03T18:00", "2026-10-03T20:00"), { ...empty, unitBookingsInPeriod: 2 }))).toContain("limit");
    expect(codes(evaluateBooking({ ...base, active: false }, req("2026-10-03T18:00", "2026-10-03T20:00"), empty))).toContain("inactive");
  });
  it("reports every failing rule at once", () => {
    expect(codes(evaluateBooking(base, req("2026-10-01T06:00", "2026-10-01T06:15", { guests: 99 }), empty)).length).toBeGreaterThanOrEqual(4);
  });
});

describe("helpers", () => {
  it("peak concurrency counts simultaneous overlap only", () => {
    const w = { start: at("2026-10-03T10:00"), end: at("2026-10-03T12:00") };
    expect(peakConcurrency(w, [])).toBe(0);
    expect(peakConcurrency(w, [{ start: at("2026-10-03T09:00"), end: at("2026-10-03T10:00") }])).toBe(0);
    expect(peakConcurrency(w, [{ start: at("2026-10-03T10:00"), end: at("2026-10-03T11:00") }, { start: at("2026-10-03T10:30"), end: at("2026-10-03T11:30") }])).toBe(2);
  });
  it("day window and local parts are DST-safe", () => {
    const w = dayWindow(base, "2026-11-01", TZ); // DST ends this morning in Vancouver
    expect(localParts(w.start, TZ)).toEqual({ date: "2026-11-01", minute: 480 });
    expect(localParts(w.end, TZ)).toEqual({ date: "2026-11-01", minute: 1380 });
    expect(dayWindow({ opensAtMinute: 0, closesAtMinute: 1440 }, "2026-11-01", TZ).end.getTime() - dayWindow({ opensAtMinute: 0, closesAtMinute: 1440 }, "2026-11-01", TZ).start.getTime()).toBe(25 * 3_600_000);
  });
  it("parses HH:MM and summarises rules", () => {
    expect(parseMinute("07:30")).toBe(450);
    expect(parseMinute("24:00")).toBe(1440);
    expect(parseMinute("25:00")).toBeNull();
    expect(describeRules(base).join(" ")).toMatch(/approves[^]*Fee \$50\.00[^]*deposit \$250\.00/);
  });
  it("cancellation cut-off", () => {
    expect(canResidentCancel(at("2026-10-05T18:00"), 48, now)).toBe(true);
    expect(canResidentCancel(at("2026-10-02T18:00"), 48, now)).toBe(false);
  });
});
