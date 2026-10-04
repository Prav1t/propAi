import { describe, expect, it } from "vitest";
import { sniff } from "./sniff";

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)));

describe("sniff", () => {
  it("detects images, PDF and video from magic bytes regardless of the name", () => {
    expect(sniff(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "....", [0, 0]), "x.pdf")?.mime).toBe("image/png");
    expect(sniff(bytes("%PDF-1.7\n%....."), "a.png")?.mime).toBe("application/pdf");
    expect(sniff(bytes([0, 0, 0, 0x18], "ftypmp42", [0, 0, 0, 0]))?.mime).toBe("video/mp4");
  });
  it("accepts Office files only when the ZIP really is an OOXML package with a matching extension", () => {
    const docx = bytes([0x50, 0x4b, 0x03, 0x04], "....[Content_Types].xml....");
    expect(sniff(docx, "lease.docx")?.mime).toContain("wordprocessingml");
    expect(sniff(docx, "lease.zip")).toBeNull();
    expect(sniff(bytes([0x50, 0x4b, 0x03, 0x04], "random zip content here"), "x.docx")).toBeNull();
  });
  it("accepts UTF-8 text/CSV by extension, rejects binary disguised as text", () => {
    expect(sniff(bytes("unit,name\n1204,Emma\n"), "list.csv")?.mime).toBe("text/csv");
    expect(sniff(bytes("Quiet hours 11pm–7am"), "rules.txt")?.mime).toBe("text/plain");
    expect(sniff(bytes([0x41, 0x00, 0x42]), "x.txt")).toBeNull();
    expect(sniff(bytes("<script>alert(1)</script>"), "x.html")).toBeNull();
  });
});
