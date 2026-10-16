import { describe, expect, it } from "vitest";
import {
  actionsFor, describeSchedule, describeWorkflow, evaluateConditions, fieldsFor, nextOccurrence, pluralRole, renderAutomationText, workflowSchema,
  type Subject, type WorkflowInput,
} from "./automation";
import { TEMPLATES } from "./automation-templates";

const TZ = "America/Vancouver";
const local = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

describe("schedules", () => {
  it("finds the next daily, weekday, weekly and monthly slot in the org's time zone", () => {
    const fri = new Date("2026-10-16T20:00:00Z"); // Friday 1 p.m. in Vancouver
    expect(local(nextOccurrence({ frequency: "daily", time: "08:00" }, TZ, fri))).toBe("2026-10-17, 08:00");
    expect(local(nextOccurrence({ frequency: "weekdays", time: "08:00" }, TZ, fri))).toBe("2026-10-19, 08:00"); // skips the weekend
    expect(local(nextOccurrence({ frequency: "weekly", time: "08:00", weekday: 1 }, TZ, fri))).toBe("2026-10-19, 08:00");
    expect(local(nextOccurrence({ frequency: "daily", time: "14:00" }, TZ, fri))).toBe("2026-10-16, 14:00"); // later the same day
    expect(local(nextOccurrence({ frequency: "monthly", time: "09:30", dayOfMonth: 1 }, TZ, fri))).toBe("2026-11-01, 09:30");
  });
  it("runs once per day across both DST changes", () => {
    // fall back (Nov 1, 2026): 01:30 happens twice; spring forward (Mar 14, 2027): 02:30 doesn't exist
    for (const [start, time] of [["2026-10-30T12:00:00Z", "01:30"], ["2027-03-12T12:00:00Z", "02:30"]] as const) {
      let t = new Date(start);
      const days: string[] = [];
      for (let i = 0; i < 5; i++) {
        t = nextOccurrence({ frequency: "daily", time }, TZ, t);
        days.push(local(t).slice(0, 10));
      }
      expect(new Set(days).size).toBe(5); // one run per local date, none skipped or doubled
    }
    const spring = nextOccurrence({ frequency: "daily", time: "02:30" }, TZ, new Date("2027-03-14T08:00:00Z"));
    expect(local(spring).slice(0, 10)).toBe("2027-03-14");
  });
  it("describes schedules in plain words", () => {
    expect(describeSchedule({ frequency: "weekly", time: "08:00", weekday: 1 })).toBe("Every Monday at 8:00 a.m.");
    expect(describeSchedule({ frequency: "monthly", time: "17:30", dayOfMonth: 22 })).toBe("On the 22nd of every month at 5:30 p.m.");
    expect(describeSchedule({ frequency: "weekdays", time: "00:15" })).toBe("Every weekday at 12:15 a.m.");
  });
});

const wo = (fields: Subject["fields"], buildingId: string | null = "b1"): Subject => ({
  type: "work_order", id: "w", ref: "WO-1", title: "t", href: "/x", propertyId: "p", propertyName: "P", buildingId, buildingName: "B", unitLabel: null, fields, submitterUserId: null, assigneeMembershipId: null,
});

describe("conditions", () => {
  const s = wo({ emergency: true, category: "elevator", priority: "high", status: "new", new_status: "acknowledged", unassigned: true, source: true, title: "Elevator stuck on 9" });
  const ok = (t: Parameters<typeof evaluateConditions>[0], c: Parameters<typeof evaluateConditions>[1], subj = s) => evaluateConditions(t, c, subj).ok;
  it("evaluates every operator", () => {
    expect(ok("workorder.created", [])).toBe(true);
    expect(ok("workorder.created", [{ field: "emergency", op: "is_true" }])).toBe(true);
    expect(ok("workorder.created", [{ field: "emergency", op: "is_false" }])).toBe(false);
    expect(ok("workorder.created", [{ field: "category", op: "is", value: ["plumbing", "elevator"] }])).toBe(true);
    expect(ok("workorder.created", [{ field: "category", op: "is_not", value: ["elevator"] }])).toBe(false);
    expect(ok("workorder.created", [{ field: "priority", op: "at_least", value: "high" }])).toBe(true);
    expect(ok("workorder.created", [{ field: "priority", op: "at_least", value: "urgent" }])).toBe(false);
    expect(ok("workorder.created", [{ field: "title", op: "contains", value: "STUCK" }])).toBe(true);
    expect(ok("workorder.created", [{ field: "building", op: "is", value: ["b1"] }])).toBe(true);
    expect(ok("workorder.created", [{ field: "building", op: "is", value: ["b1"] }], wo({}, null))).toBe(false);
    expect(ok("inspection.failed", [{ field: "failed_items", op: "at_least", value: 2 }], { ...s, type: "inspection", fields: { failed_items: 3 } })).toBe(true);
  });
  it("all conditions must hold, and the first failing one is reported", () => {
    const r = evaluateConditions("workorder.created", [{ field: "emergency", op: "is_true" }, { field: "category", op: "is", value: ["plumbing"] }], s);
    expect(r).toEqual({ ok: false, failed: { field: "category", op: "is", value: ["plumbing"] } });
  });
  it("fields only apply to their triggers; unknown fields never match", () => {
    expect(fieldsFor("workorder.created").map((f) => f.key)).not.toContain("new_status");
    expect(fieldsFor("workorder.status_changed").map((f) => f.key)).toContain("new_status");
    expect(ok("workorder.created", [{ field: "new_status", op: "is", value: ["acknowledged"] }])).toBe(false);
    expect(ok("schedule", [{ field: "x", op: "is_true" }], s)).toBe(false);
  });
});

const base: WorkflowInput = { name: "R", description: "", propertyId: null, trigger: "workorder.created", schedule: null, conditions: [], actions: [{ type: "escalate" }] };

describe("rule validation", () => {
  it("accepts every template", () => {
    for (const t of TEMPLATES) expect(workflowSchema.safeParse({ ...t.rule, propertyId: null }).success, t.key).toBe(true);
  });
  it("rejects rules that can't run as written", () => {
    const msg = (r: unknown) => { const p = workflowSchema.safeParse(r); return p.success ? null : p.error.issues[0].message; };
    expect(msg({ ...base, trigger: "schedule" })).toBe("Set when the rule runs.");
    expect(msg({ ...base, schedule: { frequency: "daily", time: "08:00" } })).toBe("Only scheduled rules have a schedule.");
    expect(msg({ ...base, trigger: "package.arrived" })).toMatch(/doesn't apply to this trigger/);
    expect(msg({ ...base, actions: [{ type: "escalate" }, { type: "request_approval", role: "property_manager", note: "" }] })).toBe("Add the steps that should run after approval.");
    expect(msg({ ...base, actions: [{ type: "request_approval", role: "a", note: "" }, { type: "request_approval", role: "b", note: "" }, { type: "escalate" }] })).toBe("A rule can ask for approval once.");
    expect(msg({ ...base, conditions: [{ field: "category", op: "is", value: ["nope"] }] })).toBe("Unknown category.");
    expect(msg({ ...base, conditions: [{ field: "category", op: "is", value: [] }] })).toBe("Choose at least one category value.");
    expect(msg({ ...base, conditions: [{ field: "emergency", op: "contains", value: "x" }] })).toBe("Emergency can't be compared that way.");
    expect(msg({ ...base, actions: [{ type: "notify", to: { roles: [], members: [], onCall: false, submitter: false, assignee: false }, title: "x", message: "" }] })).toBe("Choose who to notify.");
    expect(msg({ ...base, actions: [] })).toBe("Add at least one action.");
    expect(msg({ ...base, trigger: "schedule", schedule: { frequency: "weekly", time: "8am" } })).toMatch(/24-hour time|day of the week/);
  });
  it("offers only actions that make sense for the trigger", () => {
    expect(actionsFor("schedule")).not.toContain("set_priority");
    expect(actionsFor("workorder.created")).toContain("escalate");
    expect(actionsFor("package.arrived")).not.toContain("assistant_draft");
  });
});

describe("plain language", () => {
  it("describes a whole rule with names, not ids", () => {
    const t = TEMPLATES.find((x) => x.key === "elevator_emergency")!;
    const d = describeWorkflow({ ...t.rule, propertyId: "p1" }, { properties: { p1: "Fraser Towers" }, roles: { property_manager: "Property Manager" } });
    expect(d.when).toBe("When a maintenance request is created at Fraser Towers");
    expect(d.conditions).toEqual(["it's marked emergency", "category is Elevator"]);
    expect(d.actions[1]).toBe("Notify Property Managers and whoever is on call: “Elevator emergency: {{ref}} at {{property}}”");
    expect(d.actions[3]).toBe("Ask a Property Manager to approve before continuing");
  });
  it("pluralises role names and fills template variables", () => {
    expect([pluralRole("Property Manager"), pluralRole("Security"), pluralRole("Staff"), pluralRole("Strata Council Member")]).toEqual(["Property Managers", "Security", "Staff", "Strata Council Members"]);
    expect(renderAutomationText("{{ref}} at {{property}} — {{unknown}}", { ref: "WO-9", property: "Fraser Towers" })).toBe("WO-9 at Fraser Towers — {{unknown}}");
    expect(renderAutomationText("{{title}}  {{unit}}", { title: "Leak", unit: null })).toBe("Leak");
  });
});
