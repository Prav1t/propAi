// XSS and injection probes on the places user or model text is turned into links or queries (Iteration 11)
import { describe, expect, it } from "vitest";
import { isSafeHref, parseMarkdown } from "./mini-markdown";
import { safeNext } from "./safe-next";
import { toPrefixQuery } from "@/server/modules/scope";

const links = (text: string) => JSON.stringify(parseMarkdown(text)).match(/"href":"[^"]*"/g) ?? [];

describe("assistant markdown never produces a dangerous link", () => {
  it.each([
    "[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](data:text/html,<script>alert(1)</script>)", "[x](vbscript:msgbox)",
    "[x](//evil.example/steal)", "[x](/\\evil.example)", "[x](https://evil.example)", "[x](%2F%2Fevil.example)", "[x]( javascript:alert(1))",
  ])("%s stays text", (md) => {
    expect(links(md)).toEqual([]);
  });

  it("in-app links still work, and HTML comes out as text, not markup", () => {
    expect(links("[WO-1042](/o/pacific/maintenance/abc)")).toEqual(['"href":"/o/pacific/maintenance/abc"']);
    const tree = JSON.stringify(parseMarkdown("<img src=x onerror=alert(1)> **<script>alert(1)</script>**"));
    expect(tree).toContain("<img src=x onerror=alert(1)>"); // a plain string React will escape
    expect(tree).not.toMatch(/"t":"(html|raw)"/);
  });

  it("isSafeHref", () => {
    expect(isSafeHref("/o/x/documents/1#section")).toBe(true);
    for (const bad of ["//x.example", "/\\x.example", "javascript:x", "/a b", "/a\nb", "https://x.example", ""]) expect(isSafeHref(bad)).toBe(false);
  });
});

describe("redirect targets", () => {
  it.each(["//evil.example", "/\\evil.example", "https://evil.example", "/\t/evil.example", "javascript:alert(1)", "evil.example"])("%s is refused", (v) => {
    expect(safeNext(v)).toBeNull();
  });
});

describe("full-text search input can't inject tsquery syntax", () => {
  it.each(["a & b", "a | b", "!a", "a:*", "(a", "a') or ('1'='1", "'; drop table users; --", "a<->b"])("%s", (q) => {
    const out = toPrefixQuery(q);
    if (out) expect(out).toMatch(/^[a-z0-9@._:*&|() -]+$/); // only terms the builder made, with its own operators
    expect(out ?? "").not.toMatch(/[';!<>\\-]{2}|--|;/);
  });
});
