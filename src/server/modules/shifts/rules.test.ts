import { describe, expect, it } from "vitest";
import { clockInProblem, endAfterStart, isOnNow, overlapHours, validateShift } from "./rules";

const at = (s: string) => new Date(s);

describe("shift rules", () => {
  it("limits regular shifts to 16 hours and on-call periods to 7 days", () => {
    expect(validateShift({ startsAt: at("2026-10-04T15:00:00Z"), endsAt: at("2026-10-04T23:00:00Z"), onCall: false })).toBeNull();
    expect(validateShift({ startsAt: at("2026-10-04T15:00:00Z"), endsAt: at("2026-10-05T09:00:00Z"), onCall: false })).toMatch(/16 hours/);
    expect(validateShift({ startsAt: at("2026-10-04T15:00:00Z"), endsAt: at("2026-10-07T15:00:00Z"), onCall: true })).toBeNull();
    expect(validateShift({ startsAt: at("2026-10-04T15:00:00Z"), endsAt: at("2026-10-04T15:00:00Z"), onCall: false })).toMatch(/after it starts/);
  });
  it("treats an end time before the start as the next day", () => {
    expect(endAfterStart("2026-10-04", "23:00", "07:00")).toEqual({ endDate: "2026-10-05" });
    expect(endAfterStart("2026-12-31", "23:00", "07:00")).toEqual({ endDate: "2027-01-01" });
    expect(endAfterStart("2026-10-04", "07:00", "15:00")).toEqual({ endDate: "2026-10-04" });
    expect(endAfterStart("2026-10-04", "17:00", "08:00", "2026-10-06")).toEqual({ endDate: "2026-10-06" });
  });
  it("knows who is on now", () => {
    const s = { startsAt: at("2026-10-04T15:00:00Z"), endsAt: at("2026-10-04T23:00:00Z"), onCall: false };
    expect(isOnNow(s, at("2026-10-04T15:00:00Z"))).toBe(true);
    expect(isOnNow(s, at("2026-10-04T23:00:00Z"))).toBe(false);
    expect(isOnNow({ ...s, status: "cancelled" }, at("2026-10-04T16:00:00Z"))).toBe(false);
  });
  it("allows clocking in from 30 minutes early until the end, once", () => {
    const s = { startsAt: at("2026-10-04T15:00:00Z"), endsAt: at("2026-10-04T23:00:00Z"), onCall: false, clockedInAt: null };
    expect(clockInProblem(s, at("2026-10-04T14:20:00Z"))).toMatch(/30 minutes/);
    expect(clockInProblem(s, at("2026-10-04T14:40:00Z"))).toBeNull();
    expect(clockInProblem(s, at("2026-10-04T23:00:00Z"))).toMatch(/ended/);
    expect(clockInProblem({ ...s, clockedInAt: at("2026-10-04T14:50:00Z") }, at("2026-10-04T15:10:00Z"))).toMatch(/already/);
  });
  it("counts hours inside a window", () => {
    const s = { startsAt: at("2026-10-04T20:00:00Z"), endsAt: at("2026-10-05T04:00:00Z"), onCall: false };
    expect(overlapHours(s, at("2026-10-05T00:00:00Z"), at("2026-10-06T00:00:00Z"))).toBe(4);
  });
});
