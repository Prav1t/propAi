import { describe, expect, it } from "vitest";
import { currentTotp, hashRecoveryCode, newRecoveryCodes, newTotpSecret, totpUri, verifyTotp } from "./totp";

describe("TOTP", () => {
  it("accepts the current code and rejects others", () => {
    const s = newTotpSecret();
    expect(verifyTotp(currentTotp(s), s)).toBe(true);
    expect(verifyTotp("000000", s) && verifyTotp("111111", s)).toBe(false);
    expect(verifyTotp("12345", s)).toBe(false);
    expect(verifyTotp("abcdef", s)).toBe(false);
  });
  it("tolerates spaces the user types", () => {
    const s = newTotpSecret();
    const c = currentTotp(s);
    expect(verifyTotp(`${c.slice(0, 3)} ${c.slice(3)}`, s)).toBe(true);
  });
  it("builds an otpauth URI", () => {
    expect(totpUri("ABC", "a@b.test", "Brand")).toMatch(/^otpauth:\/\/totp\//);
  });
  it("creates 10 unique, well-formed recovery codes; hashing is case-insensitive", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(hashRecoveryCode(codes[0].toUpperCase())).toBe(hashRecoveryCode(codes[0]));
  });
});
