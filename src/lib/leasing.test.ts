import { describe, expect, it } from "vitest";
import { addDays, addMonths, chargePeriods, chargeState, dueDate, money, monthLabel, todayIn } from "./leasing";

describe("lease dates", () => {
  it("steps months across year ends in both directions", () => {
    expect(addMonths("2026-11-01", 1)).toBe("2026-12-01");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(addMonths("2026-03-01", 14)).toBe("2027-05-01");
  });

  it("puts the due day in the month, never past the 28th", () => {
    expect(dueDate("2026-02-01", 1)).toBe("2026-02-01");
    expect(dueDate("2026-02-01", 31)).toBe("2026-02-28");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });

  it("charges every month from the start to today, whole months only", () => {
    expect(chargePeriods({ startsOn: "2026-08-15", endsOn: null, moveOutOn: null }, "2026-11-11")).toEqual(["2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"]);
    expect(chargePeriods({ startsOn: "2026-12-01", endsOn: null, moveOutOn: null }, "2026-11-11")).toEqual([]); // starts later
  });

  it("stops at the end of a fixed term, or at the move-out when notice was given", () => {
    expect(chargePeriods({ startsOn: "2026-06-01", endsOn: "2026-09-30", moveOutOn: null }, "2026-11-11")).toEqual(["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"]);
    expect(chargePeriods({ startsOn: "2026-06-01", endsOn: "2027-05-31", moveOutOn: "2026-08-20" }, "2026-11-11")).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
  });

  it("never produces more periods than the cap", () => {
    expect(chargePeriods({ startsOn: "2010-01-01", endsOn: null, moveOutOn: null }, "2026-11-11", 12)).toHaveLength(12);
  });

  it("knows today in the organization's time zone, not the server's", () => {
    const lateEvening = new Date("2026-11-11T05:30:00Z"); // still the 10th in Vancouver
    expect(todayIn("America/Vancouver", lateEvening)).toBe("2026-11-10");
    expect(todayIn("UTC", lateEvening)).toBe("2026-11-11");
  });
});

describe("rent charge state", () => {
  const c = (paidCents: number, dueOn: string) => chargeState({ amountCents: 200_000, paidCents, dueOn }, "2026-11-11");
  it("is paid, part paid, due or overdue", () => {
    expect(c(200_000, "2026-11-01")).toBe("paid");
    expect(c(50_000, "2026-11-15")).toBe("partial");
    expect(c(0, "2026-11-15")).toBe("due");
    expect(c(0, "2026-11-11")).toBe("due"); // due today is not late yet
    expect(c(50_000, "2026-11-01")).toBe("overdue");
  });

  it("formats money without needless cents", () => {
    expect(money(215_000)).toBe("$2,150");
    expect(money(215_050)).toBe("$2,150.50");
    expect(monthLabel("2026-11-01")).toBe("November 2026");
  });
});
