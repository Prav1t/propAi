import { describe, expect, it } from "vitest";
import { detectCarrier, normalizeTracking } from "./carrier";

describe("detectCarrier", () => {
  it.each([
    ["1Z999AA10123456784", "UPS", true],
    ["1z 999 aa1 0123 456 784", "UPS", true],
    ["TBA123456789012", "Amazon", true],
    ["7316 0000 1234 5678", "Canada Post", true],
    ["RR123456789CA", "Canada Post", true],
    ["9400111899223197428490", "USPS", true],
    ["LZ123456789US", "USPS", true],
    ["123456789012345", "FedEx", true],
    ["123456789012", "FedEx", false],
    ["1234567890", "DHL", false],
    ["RR123456789DE", "Other", false],
  ])("%s → %s", (raw, carrier, confident) => {
    expect(detectCarrier(raw)).toEqual({ carrier, confident });
  });
  it("returns null for unknown formats", () => {
    expect(detectCarrier("hello")).toBeNull();
    expect(detectCarrier("")).toBeNull();
  });
  it("normalizes spacing and case", () => {
    expect(normalizeTracking(" ab-12 cd ")).toBe("AB12CD");
  });
});
