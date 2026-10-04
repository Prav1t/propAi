import { describe, expect, it } from "vitest";
import { hashPass, isOverstay, newPass, passState, tokenFromScan } from "./pass";

const from = new Date("2026-10-04T18:00:00Z");
const until = new Date("2026-10-04T23:00:00Z");
const v = (status: string) => ({ status, expectedFrom: from, expectedUntil: until });

describe("guest passes", () => {
  it("stores only a hash of a random token", () => {
    const a = newPass();
    const b = newPass();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashPass(a.token));
    expect(a.hash).not.toContain(a.token);
  });
  it("reads tokens from scanned pass URLs or typed text, and rejects junk", () => {
    const { token } = newPass();
    expect(tokenFromScan(`https://app.example.com/pass/${token}`)).toBe(token);
    expect(tokenFromScan(`http://localhost:3000/pass/${token}?x=1`)).toBe(token);
    expect(tokenFromScan(` ${token} `)).toBe(token);
    expect(tokenFromScan("1Z999AA10123456784")).toBeNull();
    expect(tokenFromScan("'; drop table visitors; --")).toBeNull();
  });
  it("is valid from an hour before the window until its end", () => {
    expect(passState(v("expected"), new Date("2026-10-04T16:30:00Z"))).toBe("upcoming");
    expect(passState(v("expected"), new Date("2026-10-04T17:10:00Z"))).toBe("valid");
    expect(passState(v("expected"), new Date("2026-10-04T22:59:00Z"))).toBe("valid");
    expect(passState(v("expected"), new Date("2026-10-04T23:01:00Z"))).toBe("expired");
  });
  it("reflects check-in, check-out, cancellation and denial", () => {
    expect(passState(v("checked_in"))).toBe("on_site");
    expect(passState(v("checked_out"))).toBe("used");
    expect(passState(v("cancelled"))).toBe("cancelled");
    expect(passState(v("denied"))).toBe("denied");
  });
  it("flags guests still on site after their window", () => {
    expect(isOverstay(v("checked_in"), new Date("2026-10-05T01:00:00Z"))).toBe(true);
    expect(isOverstay(v("checked_in"), new Date("2026-10-04T20:00:00Z"))).toBe(false);
    expect(isOverstay(v("checked_out"), new Date("2026-10-05T01:00:00Z"))).toBe(false);
  });
});
