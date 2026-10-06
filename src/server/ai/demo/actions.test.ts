import { describe, expect, it } from "vitest";
import { planDemo } from "./intents";
import { draftMessage, draftNotice, isConfirmation, toneOf } from "./actions";
import { TOOL_NAMES } from "../tools/names";
import { composeFromResults } from "../providers/demo";
import type { ChatMessage } from "../types";

const ALL = new Set<string>(TOOL_NAMES);
const staff = { today: "2026-10-04", timeZone: "America/Vancouver", resident: false, orgSlug: "acme" };
const resident = { ...staff, resident: true };
const calls = (q: string, h = staff, history?: ChatMessage[]) => {
  const p = planDemo(q, ALL, h, history);
  if (p.kind !== "tools") throw new Error(`expected tools for "${q}", got: ${p.text}`);
  return p.calls;
};
const one = (q: string, h = staff) => {
  const c = calls(q, h);
  return c[c.length - 1];
};

describe("demo planner — change requests become prepared actions", () => {
  it("front desk: packages, visitors", () => {
    expect(one("A package arrived for unit 1204 in Tower A from Amazon")).toEqual({ name: "log_package", input: { unit: "1204", location: "Tower A", carrier: "Amazon" } });
    expect(one("Log a package for unit 602 (UPS)").input).toMatchObject({ unit: "602", carrier: "UPS" });
    expect(one("Register a visitor named Arjun Patel from Summit Elevator Services for Tower B tomorrow at 9 AM")).toEqual({
      name: "register_visitor", input: { name: "Arjun Patel", date: "2026-10-05", from: "09:00", location: "Tower B", company: "Summit Elevator Services", kind: "contractor" },
    });
    expect(one("Invite my guest Sam Lee tomorrow at 6 PM", resident)).toEqual({ name: "register_visitor", input: { name: "Sam Lee", date: "2026-10-05", from: "18:00" } });
  });
  it("work orders by number: assign, status, notes", () => {
    expect(one("Assign WO-1043 to Coastline Electric")).toEqual({ name: "assign_work_order", input: { number: 1043, vendor: "Coastline Electric" } });
    expect(one("Reassign work order 88 to Luis Moreno")).toEqual({ name: "assign_work_order", input: { number: 88, staff: "Luis Moreno" } });
    expect(one("Mark WO-1043 as in progress")).toEqual({ name: "update_work_order_status", input: { number: 1043, status: "in_progress" } });
    expect(one("Mark WO-12 completed with notes: replaced the cartridge")).toEqual({ name: "update_work_order_status", input: { number: 12, status: "completed", resolutionNotes: "replaced the cartridge" } });
    expect(one("Cancel WO-77")).toEqual({ name: "update_work_order_status", input: { number: 77, status: "cancelled" } });
    expect(one("Add a note to WO-1043: technician arriving at 3 PM")).toEqual({ name: "comment_on_work_order", input: { number: 1043, body: "technician arriving at 3 PM", visibility: "internal" } });
  });
  it("tasks, inspections, incidents", () => {
    expect(one("Create a task to replace the lobby light bulbs at Harbour Centre by Friday")).toEqual({ name: "create_task", input: { title: "Replace the lobby light bulbs", location: "Harbour Centre", due: "2026-10-09" } });
    expect(one("Add a task: call the elevator inspector, assign it to Luis Moreno").input).toMatchObject({ title: "Call the elevator inspector", assignee: "Luis Moreno" });
    expect(one("Schedule a fire safety inspection for Tower B on Tuesday")).toEqual({ name: "schedule_inspection", input: { location: "Tower B", date: "2026-10-06", template: "fire safety" } });
    expect(one("Report an incident: water leaking from the ceiling in the P2 garage at Kingsway Residences")).toEqual({
      name: "create_incident",
      input: { title: "Water leaking from the ceiling in the P2 garage at Kingsway Residences", type: "water_damage", description: "water leaking from the ceiling in the P2 garage at Kingsway Residences", location: "Kingsway Residences", where: "P2 garage" },
    });
  });
  it("bookings and cancellations", () => {
    expect(one("Book the meeting room on Friday at 2pm for 2 hours for 8 people for unit 1204")).toEqual({
      name: "create_booking", input: { amenity: "meeting room", date: "2026-10-09", start: "14:00", durationMinutes: 120, guests: 8, unit: "1204" },
    });
    expect(one("Cancel my party room booking on Saturday", resident)).toEqual({ name: "cancel_booking", input: { amenity: "party room", date: "2026-10-10" } });
    expect(one("Cancel booking #42 because the room is flooded")).toEqual({ name: "cancel_booking", input: { booking: 42, reason: "the room is flooded" } });
  });
  it("residents describing a problem get a work order for their own unit (no duplicate search, no assignment)", () => {
    expect(calls("My kitchen sink is leaking badly and water is spreading across the floor — please file a request", resident)).toEqual([{
      name: "create_work_order",
      input: { title: "Kitchen sink is leaking badly", description: "My kitchen sink is leaking badly and water is spreading across the floor — please file a request", category: "plumbing" },
    }]);
  });
  it("messages: one resident vs everyone", () => {
    const [m] = calls("Message the resident of unit 1204 in Tower B saying their replacement fob is ready at the front desk");
    expect(m.name).toBe("message_resident");
    expect(m.input).toMatchObject({ unit: "1204", location: "Tower B", subject: "Your replacement fob is ready at the front desk" });
    expect(String(m.input.body)).toContain("Your replacement fob is ready at the front desk.");
    expect(one("Tell Maria Chen that her parking permit is ready").input).toMatchObject({ resident: "Maria Chen", subject: "Your parking permit is ready" });
    const [a] = calls("Notify everyone in Tower B that the elevator will be unavailable from 2–5 PM, keep it urgent");
    expect(a.name).toBe("send_announcement");
    expect(a.input).toMatchObject({ location: "Tower B", tone: "urgent", category: "maintenance" });
    expect(String(a.input.title)).toMatch(/^Important: The elevator will be unavailable from 2–5 PM/);
  });
  it("questions are still answered by looking things up", () => {
    expect(one("Which packages arrived for unit 602?").name).toBe("search_packages");
    expect(one("Is the party room free tomorrow at 7 PM?", resident).name).toBe("check_amenity_availability");
    expect(one("Show me open work orders in Tower B").name).toBe("search_work_orders");
  });
  it("a typed 'yes' never approves anything", () => {
    for (const q of ["yes", "Yes, go ahead!", "ok do it", "approve", "sounds good thanks"]) {
      expect(isConfirmation(q)).toBe(true);
      const p = planDemo(q, ALL, staff);
      expect(p.kind === "reply" && p.text).toMatch(/can't approve changes myself/);
    }
    expect(isConfirmation("yes, and also book the gym")).toBe(false);
  });
  it("redrafts the last message in another tone from the same facts", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Send residents of Tower B a notice saying the water will be off tomorrow from 9 to 11 AM" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "send_announcement", input: { title: "x", body: "y", location: "Tower B", audience: "residents", tone: "professional", about: "the water will be off tomorrow from 9 to 11 AM" } }] },
      { role: "tool", toolCallId: "c1", name: "send_announcement", content: "{}" },
      { role: "assistant", content: "Prepared." },
    ];
    const [c] = calls("make it friendlier", staff, history);
    expect(c.name).toBe("send_announcement");
    expect(c.input).toMatchObject({ location: "Tower B", audience: "residents", tone: "friendly" });
    expect(String(c.input.body)).toMatch(/^Hi neighbours,\n\nQuick heads-up: the water will be off tomorrow \(Monday, October 5\) from 9 to 11 AM\./);
    // nothing to redraft → not a redraft
    expect(planDemo("make it friendlier", ALL, staff, []).kind).toBe("reply");
  });
});

describe("drafting templates", () => {
  it("covers the five tones without adding facts", () => {
    for (const tone of ["professional", "friendly", "concise", "formal", "urgent"] as const) {
      const d = draftNotice("the gym is closed today for floor repairs", tone, "2026-10-04");
      expect(d.body).toContain("today (Sunday, October 4)");
      expect(d.body).toMatch(/floor repairs/);
      expect(d.body).not.toMatch(/\d{1,2}(:\d{2})? ?(am|pm)/i); // no invented times
    }
    expect(draftMessage("their package is at the desk", "concise", "2026-10-04").body).toBe("Your package is at the desk.");
    expect(toneOf("make it more formal")).toBe("formal");
    expect(toneOf("shorter please")).toBe("concise");
    expect(toneOf("hello")).toBeUndefined();
  });
});

describe("demo answers for prepared and executed actions", () => {
  const pending = (title: string, tool = "create_work_order") => ({ name: tool, content: JSON.stringify({ ok: true, status: "awaiting_approval", summary: `Prepared, not done yet: ${title}. It runs only if the user approves the plan shown with your reply.` }) });
  it("never says a prepared step was done", () => {
    const text = composeFromResults([
      { name: "search_work_orders", content: JSON.stringify({ ok: true, summary: "1 open elevator work order.", count: 1, items: [{ ref: "WO-1" }] }) },
      pending("Create work order “Broken elevator”"),
    ]);
    expect(text).toMatch(/already a similar open request/);
    expect(text).toContain("I've prepared this for you to approve: **Create work order “Broken elevator”**.");
    expect(text).toMatch(/Nothing has changed yet/);
    expect(text).not.toMatch(/\b(created|done|sent|notified)\b/i);
  });
  it("lists several prepared steps and offers redrafts only for communications", () => {
    const text = composeFromResults([pending("Create task “A”", "create_task"), pending("Send the announcement “B”", "send_announcement")]);
    expect(text).toMatch(/I've prepared 2 changes for you to approve:\n- Create task “A”\n- Send the announcement “B”/);
    expect(text).toMatch(/redraft/);
    expect(composeFromResults([pending("Create task “A”", "create_task")])).not.toMatch(/redraft/);
  });
  it("reports policy-run actions and refusals plainly", () => {
    expect(composeFromResults([{ name: "create_task", content: JSON.stringify({ ok: true, status: "executed", summary: "Done (your organization lets X do this without asking): Created the task “A”.", note: "Checked: The task is open." }) }]))
      .toBe("Done (your organization lets X do this without asking): Created the task “A”.\n\nChecked: The task is open.");
    expect(composeFromResults([{ name: "send_announcement", content: JSON.stringify({ ok: false, code: "POLICY_DENIED", message: "Your organization doesn't let X do this." }) }])).toBe("Your organization doesn't let X do this.");
  });
});

describe("demo planner — several changes in one request", () => {
  it("a work order and a notice to residents go into the same plan, in order", () => {
    const c = calls("The elevator in Tower B is broken. Create a work order, assign Summit Elevator and notify the residents");
    expect(c.map((x) => x.name)).toEqual(["search_work_orders", "create_work_order", "send_announcement"]);
    expect(c[1].input).toMatchObject({ category: "elevator", location: "Tower B", assignVendor: "Summit Elevator" });
    expect(String(c[2].input.body)).toMatch(/a repair request has been filed/);
  });
});
