import { describe, expect, it } from "vitest";
import { firstReport, isClientAbort, requestErrorFields } from "./request-error";

describe("request error log fields", () => {
  const ctx = { routePath: "/o/[orgSlug]/maintenance/[id]", routeType: "render" };

  it("keeps the digest and request id that the error page and response header show", () => {
    const err = Object.assign(new Error("boom"), { digest: "123456789" });
    const f = requestErrorFields(err, { path: "/o/acme/maintenance/abc", method: "GET", headers: { "x-request-id": "req-1" } }, ctx);
    expect(f).toMatchObject({ digest: "123456789", requestId: "req-1", method: "GET", path: "/o/acme/maintenance/abc", route: ctx.routePath, routeType: "render" });
    expect(f.error.message).toBe("boom");
  });

  it("drops query strings, which can carry one-time tokens", () => {
    const f = requestErrorFields(new Error("x"), { path: "/reset-password?token=secret-token-value", method: "GET", headers: {} }, ctx);
    expect(f.path).toBe("/reset-password");
    expect(JSON.stringify(f)).not.toContain("secret-token-value");
  });

  it("handles non-Error values and repeated headers", () => {
    const f = requestErrorFields("plain failure", { path: "/x", method: "POST", headers: { "x-request-id": ["a", "b"] } }, ctx);
    expect(f.error.message).toBe("plain failure");
    expect(f.requestId).toBe("a");
    expect(f.digest).toBeUndefined();
  });
});

describe("one log line per failure", () => {
  it("drops repeats of the same digest within a request, but not other requests or later repeats", () => {
    const t = 1_000_000;
    expect(firstReport({ digest: "d1", requestId: "r1" }, t)).toBe(true);
    expect(firstReport({ digest: "d1", requestId: "r1" }, t + 5)).toBe(false); // the HTML pass of the same render
    expect(firstReport({ digest: "d1", requestId: "r2" }, t + 10)).toBe(true); // another request failing the same way
    expect(firstReport({ digest: "d1", requestId: "r1" }, t + 60_000)).toBe(true); // window passed
    expect(firstReport({ requestId: "r1" }, t)).toBe(true); // no digest: always logged
  });
});

describe("client disconnects", () => {
  it("are told apart from server failures", () => {
    expect(isClientAbort(new Error("The destination stream errored while writing data."))).toBe(true);
    expect(isClientAbort(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
    expect(isClientAbort(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe(true);
    expect(isClientAbort(new Error("relation \"work_orders\" does not exist"))).toBe(false);
    expect(isClientAbort(new Error("Injected test fault at dashboard"))).toBe(false);
    expect(isClientAbort(new Error("current transaction is aborted, commands ignored until end of transaction block"))).toBe(false);
    expect(isClientAbort("string")).toBe(false);
    expect(isClientAbort(null)).toBe(false);
  });
});
