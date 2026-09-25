import { describe, expect, it } from "vitest";
import { hashPassword, passwordSchema, verifyPassword } from "./password";

describe("password policy", () => {
  it("rejects short, common and low-variety passwords", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("password123").success).toBe(false);
    expect(passwordSchema.safeParse("aaaaaaaaaaaa").success).toBe(false);
  });
  it("accepts a reasonable passphrase", () => {
    expect(passwordSchema.safeParse("correct horse battery").success).toBe(true);
  });
});

describe("argon2id hashing", () => {
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery")).toBe(true);
    expect(await verifyPassword(h, "wrong horse battery")).toBe(false);
  });
  it("returns false for malformed hashes instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});
