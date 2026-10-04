import { describe, expect, it } from "vitest";
import { addInterval, daysBetween, describeInterval, isDue, planGeneration } from "./schedule";

describe("PM interval math", () => {
  it("adds days, weeks, months and years", () => {
    expect(addInterval("2026-10-04", "day", 10)).toBe("2026-10-14");
    expect(addInterval("2026-12-28", "week", 1)).toBe("2027-01-04");
    expect(addInterval("2026-10-15", "month", 3)).toBe("2027-01-15");
    expect(addInterval("2026-10-15", "year", 1)).toBe("2027-10-15");
  });
  it("clamps month ends", () => {
    expect(addInterval("2027-01-31", "month", 1)).toBe("2027-02-28");
    expect(addInterval("2028-01-31", "month", 1)).toBe("2028-02-29");
    expect(addInterval("2028-02-29", "year", 1)).toBe("2029-02-28");
  });
  it("counts days between dates across DST and years", () => {
    expect(daysBetween("2026-11-01", "2026-11-02")).toBe(1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2026-10-10", "2026-10-04")).toBe(-6);
  });
  it("labels intervals", () => {
    expect(describeInterval("month", 1)).toBe("Monthly");
    expect(describeInterval("month", 3)).toBe("Every 3 months");
  });
});

describe("PM generation plan", () => {
  const s = { nextDueOn: "2026-10-10", intervalUnit: "month" as const, intervalCount: 1, leadDays: 7 };
  it("waits until the lead window opens", () => {
    expect(isDue("2026-10-10", 7, "2026-10-02")).toBe(false);
    expect(planGeneration(s, "2026-10-02")).toBeNull();
  });
  it("opens one work order and advances the schedule", () => {
    expect(planGeneration(s, "2026-10-03")).toEqual({ dueOn: "2026-10-10", nextDueOn: "2026-11-10", skipped: 0 });
    expect(planGeneration(s, "2026-10-20")).toEqual({ dueOn: "2026-10-10", nextDueOn: "2026-11-10", skipped: 0 });
  });
  it("skips missed occurrences instead of creating a backlog", () => {
    expect(planGeneration(s, "2027-01-05")).toEqual({ dueOn: "2027-01-10", nextDueOn: "2027-02-10", skipped: 3 });
  });
  it("handles zero lead days", () => {
    expect(planGeneration({ ...s, leadDays: 0 }, "2026-10-09")).toBeNull();
    expect(planGeneration({ ...s, leadDays: 0 }, "2026-10-10")?.dueOn).toBe("2026-10-10");
  });
});
