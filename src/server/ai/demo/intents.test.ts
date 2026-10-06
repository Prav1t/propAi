import { describe, expect, it } from "vitest";
import { planDemo, extractAmenity, extractLocation, extractTopic, extractUnit } from "./intents";
import { addDaysIso, parseDateRange, parseDuration, parseTime } from "./dates";
import { ACTION_TOOL_NAMES, TOOL_NAMES } from "../tools/names";
import { composeFromResults } from "../providers/demo";

const ALL = new Set<string>(TOOL_NAMES);
const RESIDENT = new Set<string>(["my_home", "search_work_orders", "get_work_order", "search_bookings", "check_amenity_availability", "search_packages", "search_visitors", "recent_announcements", "search_complaints", "search_incidents",
  "create_work_order", "comment_on_work_order", "create_booking", "cancel_booking", "register_visitor", "create_incident"]);
const READ_ONLY = new Set<string>([...ALL].filter((n) => !(ACTION_TOOL_NAMES as readonly string[]).includes(n)));
const staff = { today: "2026-10-04", timeZone: "America/Vancouver", resident: false, orgSlug: "acme" };
const resident = { ...staff, resident: true };

const plan = (q: string, tools = ALL, h = staff) => planDemo(q, tools, h);
const call = (q: string, tools = ALL, h = staff) => {
  const p = plan(q, tools, h);
  if (p.kind !== "tools") throw new Error(`expected tools for "${q}", got reply: ${p.text}`);
  return p.calls;
};

describe("demo intent planner — the six scenarios from the brief", () => {
  it("overdue work across properties", () => {
    expect(call("Show me all overdue maintenance requests across my properties.")).toEqual([{ name: "search_work_orders", input: { view: "overdue" } }]);
  });
  it("create a work order: looks for duplicates, then prepares the work order (and the assignment) as a plan", () => {
    expect(call("Create a maintenance request for the broken elevator in Tower B and assign Summit Elevator.")).toEqual([
      { name: "search_work_orders", input: { view: "open", category: "elevator", location: "Tower B", limit: 3 } },
      { name: "create_work_order", input: { title: "Broken elevator", category: "elevator", location: "Tower B", assignVendor: "Summit Elevator" } },
    ]);
  });
  it("slowest vendor this month", () => {
    expect(call("Which vendor has been the slowest this month?")).toEqual([{ name: "vendor_performance", input: { from: "2026-09-04", to: "2026-10-04" } }]);
  });
  it("book the party room: prepares the booking, which runs the real booking rules", () => {
    expect(call("Book the party room tomorrow at 7 PM.", RESIDENT, resident)).toEqual([{ name: "create_booking", input: { amenity: "party room", date: "2026-10-05", start: "19:00" } }]);
    // without a time it checks availability and asks
    const p = plan("Book the party room tomorrow", RESIDENT, resident);
    expect(p).toMatchObject({ kind: "tools", calls: [{ name: "check_amenity_availability", input: { amenity: "party room", date: "2026-10-05" } }] });
    expect(p.kind === "tools" && p.note).toMatch(/start time/);
  });
  it("today's incidents", () => {
    expect(call("Summarize today's incidents.")).toEqual([{ name: "search_incidents", input: { since: "2026-10-04", until: "2026-10-04" } }]);
  });
  it("messaging residents drafts an announcement for approval, with the date spelled out", () => {
    const [c] = call("Send residents a message saying the pool will be closed tomorrow.");
    expect(c.name).toBe("send_announcement");
    expect(c.input).toMatchObject({ title: "The pool will be closed tomorrow", audience: "residents", category: "maintenance", tone: "professional", about: "the pool will be closed tomorrow" });
    expect(String(c.input.body)).toContain("The pool will be closed tomorrow (Monday, October 5).");
  });
});

describe("demo intent planner — permissions and phrasing", () => {
  it("never offers a tool the role doesn't have", () => {
    const p = plan("Show me all residents in another building", RESIDENT, resident);
    expect(p).toMatchObject({ kind: "reply" });
    expect(p.kind === "reply" && p.text).toMatch(/can't look up other residents/);
  });
  it("routes a range of everyday questions", () => {
    expect(call("Do I have any packages?", RESIDENT, resident)[0]).toEqual({ name: "search_packages", input: { view: "waiting" } });
    expect(call("Which packages have been here more than 7 days?")[0].input).toMatchObject({ olderThanDays: 7 });
    expect(call("Which packages are waiting at the desk?")[0].name).toBe("search_packages");
    expect(call("Who's on shift right now?")[0].name).toBe("whos_on_shift");
    expect(call("Who's on site right now?")[0]).toEqual({ name: "search_visitors", input: { view: "on_site" } });
    expect(call("What happened during the previous shift?")[0].name).toBe("shift_summary");
    expect(call("Who has complained about the gym this week?")[0]).toEqual({ name: "search_complaints", input: { view: "all", q: "gym", since: "2026-09-28" } });
    expect(call("Tell me about RTU-4")[0]).toEqual({ name: "asset_history", input: { asset: "RTU-4" } });
    expect(call("Find recurring HVAC problems across my properties")[0]).toEqual({ name: "asset_history", input: { recurring: true, category: "hvac" } });
    expect(call("What's the status of WO-1042?")[0]).toEqual({ name: "get_work_order", input: { number: 1042 } });
    expect(call("What emergencies are open?")[0].input).toMatchObject({ view: "emergency" });
    expect(call("What's the emergency number for my building?", RESIDENT, resident)[0].name).toBe("my_home");
    expect(call("What preventive maintenance is due this week?")[0]).toMatchObject({ name: "calendar_range", input: { sources: ["pm"] } });
    expect(call("Give me my morning briefing").map((c) => c.name)).toEqual(["ops_kpis", "search_work_orders", "search_incidents"]);
    expect(call("Show open work orders at Harbour Centre")[0].input).toEqual({ view: "open", location: "Harbour Centre" });
  });
  it("treats 'tell me about' as a question, not a message to send", () => {
    expect(call("Tell me about the generator")[0].name).toBe("asset_history");
    expect(call("Tell residents that the gym is closed")[0].name).toBe("send_announcement");
  });
  it("without action tools, a change request is answered honestly instead of prepared", () => {
    const p = plan("Send residents a message saying the pool will be closed tomorrow.", READ_ONLY);
    expect(p.kind === "reply" && p.text).toMatch(/can't send announcements with your access/);
  });
  it("falls back to an honest description of demo mode", () => {
    const p = plan("Write me a poem about elevators");
    expect(p.kind === "reply" && p.text).toMatch(/demo mode without a language model/);
  });
});

describe("demo extraction helpers", () => {
  it("finds places, units, amenities and topics", () => {
    expect(extractLocation("overdue work in Tower B please")).toBe("Tower B");
    expect(extractLocation("anything at Fraser Towers?")).toBe("Fraser Towers");
    expect(extractLocation("book for Unit 1204 on Monday")).toBeUndefined();
    expect(extractUnit("who lives in unit 1204")).toBe("1204");
    expect(extractUnit("packages for #602")).toBe("602");
    expect(extractAmenity("is the party room free")).toBe("party room");
    expect(extractAmenity("rooftop bbq tonight")).toBe("rooftop");
    expect(extractTopic("complaints about noise at night")).toBe("noise");
  });
  it("parses relative dates, times and durations in the org's calendar", () => {
    expect(parseDateRange("tomorrow evening", "2026-10-04")).toMatchObject({ from: "2026-10-05", to: "2026-10-05" });
    expect(parseDateRange("on Saturday", "2026-10-04")).toMatchObject({ from: "2026-10-10" }); // Oct 4 2026 is a Sunday
    expect(parseDateRange("next week", "2026-10-04")).toMatchObject({ from: "2026-10-05", to: "2026-10-11" });
    expect(parseDateRange("this week", "2026-10-04")).toMatchObject({ from: "2026-09-28", to: "2026-10-04" });
    expect(parseDateRange("Dec 3", "2026-10-04")).toMatchObject({ from: "2026-12-03" });
    expect(parseDateRange("Jan 3", "2026-10-04")).toMatchObject({ from: "2027-01-03" });
    expect(parseDateRange("nothing here", "2026-10-04")).toBeNull();
    expect(parseTime("at 7 PM")).toBe("19:00");
    expect(parseTime("7:30pm")).toBe("19:30");
    expect(parseTime("12 a.m.")).toBe("00:00");
    expect(parseTime("at 18:45")).toBe("18:45");
    expect(parseTime("at 7")).toBe("19:00");
    expect(parseTime("for 7 days")).toBeNull();
    expect(parseDuration("for 2 hours")).toBe(120);
    expect(parseDuration("for 90 minutes")).toBe(90);
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("demo answers come only from tool results", () => {
  it("writes the summary, spells out highlights only when there are no record cards, and asks on ambiguity", () => {
    const text = composeFromResults([
      { name: "a", content: JSON.stringify({ ok: true, summary: "3 overdue work orders.", items: [{ ref: "WO-1" }], highlights: ["WO-1 …"], note: "Showing 1 of 3." }) },
      { name: "b", content: JSON.stringify({ ok: true, summary: "Open 9–5.", highlights: ["Fee $50"] }) },
      { name: "c", content: JSON.stringify({ ok: false, code: "AMBIGUOUS", message: "Two gyms.", options: ["Gym · A", "Gym · B"] }) },
      { name: "d", content: JSON.stringify({ ok: false, code: "FORBIDDEN", message: "secret detail" }) },
    ]);
    expect(text).toContain("3 overdue work orders.");
    expect(text).not.toContain("WO-1 …");
    expect(text).toContain("- Fee $50");
    expect(text).toMatch(/- Gym · A\n- Gym · B\n\nWhich one did you mean\?/);
    expect(text).toContain("I can't look that up with your access.");
    expect(text).not.toContain("secret detail");
  });
});
