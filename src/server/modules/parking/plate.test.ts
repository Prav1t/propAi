import { describe, expect, it } from "vitest";
import { isPlausiblePlate, normalizePlate, permitState } from "./plate";

describe("plates", () => {
  it("normalises spacing, dashes and case", () => {
    expect(normalizePlate(" abc-123 ")).toBe("ABC123");
    expect(normalizePlate("Kx7 42m")).toBe("KX742M");
    expect(normalizePlate(null)).toBe("");
  });
  it("rejects implausible plates", () => {
    expect(isPlausiblePlate("ABC123")).toBe(true);
    expect(isPlausiblePlate("A")).toBe(false);
    expect(isPlausiblePlate("ABCDEFGHI")).toBe(false);
  });
});

describe("permit state", () => {
  const now = new Date("2026-10-04T12:00:00Z");
  it("is active inside its window, open-ended when no end", () => {
    expect(permitState({ status: "active", validFrom: new Date("2026-10-01T00:00:00Z"), validUntil: null }, now)).toBe("active");
    expect(permitState({ status: "active", validFrom: new Date("2026-10-01T00:00:00Z"), validUntil: new Date("2026-10-05T00:00:00Z") }, now)).toBe("active");
  });
  it("is scheduled before, expired after, revoked when revoked", () => {
    expect(permitState({ status: "active", validFrom: new Date("2026-10-05T00:00:00Z"), validUntil: null }, now)).toBe("scheduled");
    expect(permitState({ status: "active", validFrom: new Date("2026-09-01T00:00:00Z"), validUntil: now }, now)).toBe("expired");
    expect(permitState({ status: "revoked", validFrom: new Date("2026-09-01T00:00:00Z"), validUntil: null }, now)).toBe("revoked");
  });
});
