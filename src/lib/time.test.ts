import { describe, expect, it } from "vitest";
import { relative, utcToZonedInput, zonedToUtc } from "./time";

describe("time zones", () => {
  it("converts Vancouver wall time to UTC across DST", () => {
    expect(zonedToUtc("2026-01-15T09:00", "America/Vancouver").toISOString()).toBe("2026-01-15T17:00:00.000Z"); // PST
    expect(zonedToUtc("2026-07-15T09:00", "America/Vancouver").toISOString()).toBe("2026-07-15T16:00:00.000Z"); // PDT
  });
  it("round-trips for datetime-local inputs", () => {
    const d = zonedToUtc("2026-03-20T14:30", "America/Toronto");
    expect(utcToZonedInput(d, "America/Toronto")).toBe("2026-03-20T14:30");
  });
  it("rejects malformed input", () => {
    expect(Number.isNaN(zonedToUtc("tomorrow", "UTC").getTime())).toBe(true);
  });
  it("formats relative times", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(relative(new Date("2026-01-01T03:00:00Z"), now)).toBe("in 3h");
    expect(relative(new Date("2025-12-30T00:00:00Z"), now)).toBe("2d ago");
  });
});
