import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, generateToken, hashToken, safeEqual } from "./crypto";

const key = randomBytes(32).toString("base64");

describe("crypto", () => {
  it("round-trips AES-256-GCM", () => {
    const c = encrypt("JBSWY3DPEHPK3PXP", key);
    expect(c).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decrypt(c, key)).toBe("JBSWY3DPEHPK3PXP");
  });
  it("uses a fresh IV each time", () => {
    expect(encrypt("x", key)).not.toBe(encrypt("x", key));
  });
  it("detects tampering", () => {
    const [v, iv, tag, ct] = encrypt("secret", key).split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64url")].join("."), key)).toThrow();
  });
  it("rejects the wrong key", () => {
    expect(() => decrypt(encrypt("secret", key), randomBytes(32).toString("base64"))).toThrow();
  });
  it("generates unique 256-bit tokens and stable hashes", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(a);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).toHaveLength(64);
  });
  it("compares in constant time helper", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
