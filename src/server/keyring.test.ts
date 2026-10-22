import { describe, expect, it } from "vitest";
import { ciphertextKeyId, encrypt } from "./auth/crypto";
import { needsReseal, seal, unseal, type Keyring } from "./keyring";

const k1 = Buffer.alloc(32, 1).toString("base64");
const k2 = Buffer.alloc(32, 2).toString("base64");
const ring = (current: string, keys: Record<string, string>): Keyring => ({ currentId: current, keys: new Map(Object.entries(keys)) });

describe("keyring (F-10)", () => {
  it("seals with the current key and names it", () => {
    const r = ring("k2", { k2, k1 });
    const v = seal("whsec_abc", r);
    expect(v.startsWith("v2.k2.")).toBe(true);
    expect(ciphertextKeyId(v)).toBe("k2");
    expect(unseal(v, r)).toBe("whsec_abc");
    expect(seal("whsec_abc", r)).not.toBe(v); // random IV
  });

  it("still reads values sealed with a retired key, and older v1 values (key k1)", () => {
    const old = seal("mfa-secret", ring("k1", { k1 }));
    const legacy = encrypt("mfa-secret", k1);
    const rotated = ring("k2", { k2, k1 });
    expect(unseal(old, rotated)).toBe("mfa-secret");
    expect(unseal(legacy, rotated)).toBe("mfa-secret");
    expect(needsReseal(old, rotated)).toBe(true);
    expect(needsReseal(legacy, ring("k1", { k1 }))).toBe(true); // v1 has no key id: always re-sealed
    expect(needsReseal(seal("x", rotated), rotated)).toBe(false);
  });

  it("fails loudly when the needed key isn't configured", () => {
    const v = seal("x", ring("k1", { k1 }));
    expect(() => unseal(v, ring("k2", { k2 }))).toThrow(/k1/);
  });

  it("the key id is authenticated: relabelling a ciphertext breaks it, as does any edit", () => {
    const r = ring("k1", { k1, k3: k1 });
    const v = seal("secret", r);
    expect(() => unseal(v.replace("v2.k1.", "v2.k3."), r)).toThrow();
    const parts = v.split(".");
    parts[4] = parts[4].slice(0, -2) + (parts[4].endsWith("A") ? "BA" : "AA");
    expect(() => unseal(parts.join("."), r)).toThrow();
  });
});
