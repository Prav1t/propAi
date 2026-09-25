import { describe, expect, it, vi } from "vitest";
vi.mock("../../db/client", () => ({}));
import { slugify } from "./service";

describe("slugify", () => {
  it("makes URL-safe slugs", () => {
    expect(slugify("Pacific Properties Management")).toBe("pacific-properties-management");
    expect(slugify("  Café & Co.  ")).toBe("cafe-co");
    expect(slugify("!!")).toBe("org");
  });
});
