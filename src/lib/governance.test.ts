import { describe, expect, it } from "vitest";
import { motionOutcome, tallyText } from "./governance";

describe("motionOutcome", () => {
  it.each([
    ["majority", 4, 3, 0, "carried"], ["majority", 3, 3, 0, "defeated"], ["majority", 1, 0, 6, "carried"], ["majority", 0, 0, 7, "defeated"], ["majority", 0, 0, 0, "defeated"],
    ["three_quarters", 3, 1, 0, "carried"], ["three_quarters", 6, 2, 5, "carried"], ["three_quarters", 5, 2, 0, "defeated"], ["three_quarters", 74, 26, 0, "defeated"], ["three_quarters", 75, 25, 0, "carried"],
    ["unanimous", 5, 0, 2, "carried"], ["unanimous", 5, 1, 0, "defeated"], ["unanimous", 0, 0, 5, "defeated"],
  ] as const)("%s with %i for, %i against, %i abstaining is %s", (threshold, f, a, ab, want) => {
    expect(motionOutcome(threshold, { for: f, against: a, abstain: ab })).toBe(want);
  });

  it("treats an unknown threshold as a simple majority", () => {
    expect(motionOutcome("something", { for: 2, against: 1, abstain: 0 })).toBe("carried");
  });

  it("describes a tally in words", () => {
    expect(tallyText({ for: 4, against: 1, abstain: 0 })).toBe("4 for, 1 against");
    expect(tallyText({ for: 4, against: 1, abstain: 2 })).toBe("4 for, 1 against, 2 abstained");
  });
});
