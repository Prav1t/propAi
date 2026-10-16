import { describe, expect, it } from "vitest";
import { bucketStarts, pctChange, periodFromDates, previousPeriod, previousQuarterSpan, resolvePeriod } from "./period";
import { fmtChange, fmtValue, roundFor } from "./metrics";
import { csvCell, toCsv } from "./reports";
import { combineHealth, healthGrade, scoreFactor } from "@/lib/analytics-labels";

const TZ = "America/Vancouver";
const now = new Date("2026-10-15T09:00:00Z"); // Oct 15, 2 a.m. in Vancouver

describe("periods", () => {
  it("resolves presets as whole local days", () => {
    const p = resolvePeriod("7d", TZ, now);
    expect([p.fromDate, p.toDate, p.days]).toEqual(["2026-10-09", "2026-10-15", 7]);
    expect(p.from.toISOString()).toBe("2026-10-09T07:00:00.000Z"); // midnight PDT
    expect(p.to.toISOString()).toBe("2026-10-16T07:00:00.000Z");
    expect(resolvePeriod("mtd", TZ, now).fromDate).toBe("2026-10-01");
    expect(resolvePeriod("qtd", TZ, now).fromDate).toBe("2026-10-01");
    expect(resolvePeriod("ytd", TZ, now).fromDate).toBe("2026-01-01");
    expect(resolvePeriod("qtd", TZ, new Date("2026-08-20T18:00:00Z")).fromDate).toBe("2026-07-01");
  });
  it("compares with the same number of days before, or the same span of last quarter", () => {
    const p = resolvePeriod("30d", TZ, now);
    expect(previousPeriod(p, TZ)).toMatchObject({ fromDate: "2026-08-17", toDate: "2026-09-15", days: 30 });
    expect(previousQuarterSpan(resolvePeriod("qtd", TZ, now), TZ)).toMatchObject({ fromDate: "2026-07-01", toDate: "2026-07-15" });
  });
  it("handles a DST change inside the period (25-hour day)", () => {
    const p = periodFromDates("2026-11-01", "2026-11-01", TZ);
    expect((p.to.getTime() - p.from.getTime()) / 3_600_000).toBe(25);
  });
  it("buckets like Postgres date_trunc (weeks start Monday)", () => {
    expect(bucketStarts(periodFromDates("2026-10-01", "2026-10-15", TZ), "week")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(bucketStarts(periodFromDates("2026-08-15", "2026-10-15", TZ), "month")).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(bucketStarts(periodFromDates("2026-10-13", "2026-10-15", TZ), "day")).toEqual(["2026-10-13", "2026-10-14", "2026-10-15"]);
    expect(resolvePeriod("90d", TZ, now).bucket).toBe("week");
  });
  it("percentage change needs a baseline", () => {
    expect(pctChange(15, 10)).toBe(50);
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(0, 0)).toBe(0);
    expect(pctChange(null, 3)).toBeNull();
  });
});

describe("formatting numbers", () => {
  it("formats by unit and rounds consistently", () => {
    expect(fmtValue(1234, "count")).toBe("1,234");
    expect(fmtValue(1234.5, "currency")).toBe("$1,234.50");
    expect(fmtValue(0.5, "hours")).toBe("30 min");
    expect(fmtValue(80, "hours")).toBe("3.3 days");
    expect(fmtValue(81.25, "percent")).toBe("81%");
    expect(fmtValue(null, "count")).toBe("—");
    expect(roundFor("hours", 2.345)).toBe(2.3);
    expect(roundFor("currency", 10.005)).toBe(10.01);
  });
  it("colours a change by whether it's good", () => {
    expect(fmtChange({ change: 20, better: "down", unit: "hours", value: 12, previous: 10 })).toEqual({ text: "▲ 20%", tone: "danger" });
    expect(fmtChange({ change: -10, better: "down", unit: "hours", value: 9, previous: 10 })).toEqual({ text: "▼ 10%", tone: "success" });
    expect(fmtChange({ change: 5, better: null, unit: "currency", value: 105, previous: 100 })).toEqual({ text: "▲ 5%", tone: "neutral" });
    expect(fmtChange({ change: null, better: "up", unit: "count", value: 3, previous: 0 })).toEqual({ text: "was 0", tone: "neutral" });
  });
});

describe("health score maths", () => {
  it("scores each factor with its fixed rule", () => {
    expect(scoreFactor("sla", 81.4)).toBe(81);
    expect(scoreFactor("overdue", 38)).toBe(62);
    expect(scoreFactor("backlog", 18.7)).toBe(44);
    expect(scoreFactor("backlog", 50)).toBe(0);
    expect(scoreFactor("complaints", 4.5)).toBe(55);
    expect(scoreFactor("incidents", 2)).toBe(50);
    expect(scoreFactor("incidents", 9)).toBe(0);
    expect(scoreFactor("inspections", null)).toBeNull();
  });
  it("leaves out factors without data and re-weights the rest", () => {
    const r = combineHealth([{ factor: "sla", score: 80, weight: 25 }, { factor: "incidents", score: 50, weight: 25 }, { factor: "inspections", score: null, weight: 50 }]);
    expect(r.score).toBe(65);
    expect(r.contributions.map((c) => c.points)).toEqual([40, 25, null]);
    expect(combineHealth([{ factor: "sla", score: null, weight: 10 }]).score).toBeNull();
    expect([healthGrade(80), healthGrade(79), healthGrade(60), healthGrade(59), healthGrade(null)]).toEqual(["good", "fair", "fair", "poor", null]);
  });
});

describe("CSV export", () => {
  it("quotes properly and neutralises spreadsheet formulas", () => {
    expect(csvCell('He said "hi", then left')).toBe('"He said ""hi"", then left"');
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(toCsv([{ key: "a", label: "A" }, { key: "b", label: "B, b" }], [{ a: 1, b: "x" }, { a: null, b: "@sum" }])).toBe('A,"B, b"\r\n1,x\r\n,\'@sum\r\n');
  });
});
