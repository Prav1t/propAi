import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext (open-redirect guard)", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNext("/o/acme/dashboard?x=1")).toBe("/o/acme/dashboard?x=1");
  });
  it.each(["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "evil", "", null, "/a\nb"])("rejects %s", (v) => {
    expect(safeNext(v as string | null)).toBeNull();
  });
});
