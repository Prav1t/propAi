import { describe, expect, it } from "vitest";
import { FOLLOW_UPS, followUps } from "./assistant-followups";
import { planDemo } from "@/server/ai/demo/intents";
import { TOOL_NAMES } from "@/server/ai/tools/names";

describe("assistant follow-up suggestions", () => {
  it("come from the tools the answer used, skipping what was already asked", () => {
    expect(followUps({ tools: ["search_work_orders"], asked: ["What emergencies are open?"], resident: false, starters: [] }))
      .toEqual(["Which work orders are unassigned?", "Which vendors are missing their SLA?"]);
  });
  it("fill up from the mode's starter questions and stop at the limit", () => {
    expect(followUps({ tools: [], asked: [], resident: true, starters: ["Do I have any packages?", "Book the gym", "x", "y"] })).toEqual(["Do I have any packages?", "Book the gym", "x"]);
    expect(followUps({ tools: ["asset_history", "search_work_orders"], asked: [], resident: false, starters: ["z"], limit: 2 })).toHaveLength(2);
  });
  it("residents get resident phrasings only", () => {
    const r = followUps({ tools: ["search_packages", "search_work_orders"], asked: [], resident: true, starters: [] });
    expect(r).not.toContain("Which packages have been here more than 7 days?");
    expect(r).toContain("Show my bookings");
  });
  it("ignore case and trailing punctuation when deduplicating", () => {
    expect(followUps({ tools: ["vendor_performance"], asked: ["show overdue work orders"], resident: false, starters: [] })).toEqual(["What emergencies are open?"]);
  });

  // a suggestion the demo assistant doesn't recognise would send people to a dead end
  it("every suggestion is understood by the demo assistant (a specific lookup, not a fallback)", () => {
    const tools = new Set<string>(TOOL_NAMES);
    const hints = { today: "2026-10-25", timeZone: "America/Vancouver", orgSlug: "acme" };
    for (const [tool, s] of Object.entries(FOLLOW_UPS)) {
      for (const [who, list] of [["staff", s.staff], ["resident", s.resident]] as const) {
        for (const q of list ?? []) {
          const p = planDemo(q, tools, { ...hints, resident: who === "resident" });
          expect(p.kind, `${tool} → "${q}"`).toBe("tools");
          if (p.kind === "tools" && !/rules/.test(q)) expect(p.calls[0].name, `"${q}" fell back to a knowledge search`).not.toBe("search_knowledge");
        }
      }
    }
  });
});
