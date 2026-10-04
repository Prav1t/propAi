import { describe, expect, it } from "vitest";
import { renderTemplate, templateVariables } from "./template";

describe("renderTemplate", () => {
  it("fills known variables with flexible spacing", () => {
    const r = renderTemplate("Hello {{resident_first_name}}, unit {{ unit }} at {{property}}.", { resident_first_name: "Emma", unit: "1204", property: "Fraser Towers" });
    expect(r).toEqual({ text: "Hello Emma, unit 1204 at Fraser Towers.", unknown: [], missing: [] });
  });
  it("reports unknown variables and leaves them visible", () => {
    const r = renderTemplate("Pay {{balance}} by {{today}}", { today: "Oct 3" });
    expect(r.text).toBe("Pay {{balance}} by Oct 3");
    expect(r.unknown).toEqual(["balance"]);
  });
  it("blanks and reports missing values", () => {
    const r = renderTemplate("Hi {{resident_name}}!", {});
    expect(r).toEqual({ text: "Hi !", unknown: [], missing: ["resident_name"] });
  });
  it("lists variables once", () => {
    expect(templateVariables("{{unit}} {{unit}} {{x}}")).toEqual(["unit", "x"]);
  });
});
