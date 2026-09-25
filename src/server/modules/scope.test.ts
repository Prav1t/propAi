import { describe, expect, it } from "vitest";
import { pageArgs, toPage, toPrefixQuery } from "./scope";

describe("toPrefixQuery", () => {
  it("builds prefix AND queries", () => {
    expect(toPrefixQuery("Fraser Tow")).toBe("fraser:* & tow:*");
  });
  it("strips tsquery operators and punctuation", () => {
    expect(toPrefixQuery("a & b | !c :* (d) 'e'")).toBe("a:* & b:* & c:* & d:* & e:*");
    expect(toPrefixQuery("&|!():*")).toBeNull();
    expect(toPrefixQuery("")).toBeNull();
  });
  it("folds accents and keeps emails/phones searchable", () => {
    expect(toPrefixQuery("Café")).toBe("cafe:*");
    expect(toPrefixQuery("emma@demo.test")).toBe("emma@demo.test:*");
    expect(toPrefixQuery("604-555")).toBe("604555:*");
  });
  it("caps the number of terms", () => {
    expect(toPrefixQuery("a b c d e f g h i j")!.split("&")).toHaveLength(8);
  });
});

describe("pagination", () => {
  it("clamps page and size", () => {
    expect(pageArgs(0)).toEqual({ page: 1, pageSize: 25, offset: 0 });
    expect(pageArgs(3, 500)).toEqual({ page: 3, pageSize: 100, offset: 200 });
    expect(pageArgs(Number.NaN)).toEqual({ page: 1, pageSize: 25, offset: 0 });
  });
  it("computes page count", () => {
    expect(toPage([], 51, 1, 25).pageCount).toBe(3);
    expect(toPage([], 0, 1, 25).pageCount).toBe(1);
  });
});
