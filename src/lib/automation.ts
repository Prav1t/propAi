// Automation rules (Iteration 9): the catalog of triggers, conditions and actions, their validation, and the
// plain-language sentences shown in the builder, on the rule page and in run logs. Shared by client and server — no I/O.
import { z } from "zod";
import { WO_CATEGORY, PRIORITY, COMPLAINT_CATEGORY, INCIDENT_TYPE, INSPECTION_KIND, SEVERITY, WO_STATUS } from "./ops-labels";
import { AMENITY_KIND, DOCUMENT_CATEGORY, PACKAGE_SIZE } from "./community-labels";
import { zonedToUtc } from "./time";

/* ───────────── triggers ───────────── */

export type SubjectType = "work_order" | "complaint" | "incident" | "inspection" | "booking" | "package" | "document";

export const TRIGGERS = {
  "workorder.created": { label: "A maintenance request is created", subject: "work_order" },
  "workorder.status_changed": { label: "A maintenance request changes status", subject: "work_order" },
  "workorder.assigned": { label: "A maintenance request is assigned", subject: "work_order" },
  "workorder.sla_approaching": { label: "A maintenance request is close to its resolution target", subject: "work_order" },
  "workorder.sla_breached": { label: "A maintenance request misses its resolution target", subject: "work_order" },
  "complaint.created": { label: "A complaint is submitted", subject: "complaint" },
  "incident.created": { label: "An incident is reported", subject: "incident" },
  "inspection.failed": { label: "An inspection fails", subject: "inspection" },
  "booking.created": { label: "An amenity booking is made", subject: "booking" },
  "package.arrived": { label: "A package arrives", subject: "package" },
  "document.uploaded": { label: "A document is uploaded", subject: "document" },
  schedule: { label: "On a schedule", subject: null },
} as const satisfies Record<string, { label: string; subject: SubjectType | null }>;
export type TriggerType = keyof typeof TRIGGERS;
export const TRIGGER_TYPES = Object.keys(TRIGGERS) as TriggerType[];
export const subjectOf = (t: TriggerType): SubjectType | null => TRIGGERS[t].subject;

export const SUBJECT_LABEL: Record<SubjectType, string> = {
  work_order: "request", complaint: "complaint", incident: "incident", inspection: "inspection", booking: "booking", package: "package", document: "document",
};

/* ───────────── schedules ───────────── */

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const scheduleSchema = z.object({
  frequency: z.enum(["daily", "weekdays", "weekly", "monthly"]),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 08:00."),
  weekday: z.coerce.number().int().min(0).max(6).optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
}).superRefine((s, c) => {
  if (s.frequency === "weekly" && s.weekday === undefined) c.addIssue({ code: "custom", message: "Choose a day of the week.", path: ["weekday"] });
  if (s.frequency === "monthly" && s.dayOfMonth === undefined) c.addIssue({ code: "custom", message: "Choose a day of the month (1–28).", path: ["dayOfMonth"] });
});
export type Schedule = z.infer<typeof scheduleSchema>;

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// the first scheduled moment strictly after `after`, as wall-clock time in the org's zone (DST-safe: a 02:30 that
// doesn't exist on the spring-forward day runs at the zone's equivalent instant, and a repeated 01:30 runs once)
export function nextOccurrence(s: Schedule, timeZone: string, after: Date): Date {
  const local = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(after);
  const [y, m, d] = local.split("-").map(Number);
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    const dow = day.getUTCDay();
    const dom = day.getUTCDate();
    const due = s.frequency === "daily" || (s.frequency === "weekdays" && dow >= 1 && dow <= 5)
      || (s.frequency === "weekly" && dow === s.weekday) || (s.frequency === "monthly" && dom === s.dayOfMonth);
    if (!due) continue;
    const at = zonedToUtc(`${ymd(day.getUTCFullYear(), day.getUTCMonth() + 1, dom)}T${s.time}`, timeZone);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error("no upcoming occurrence");
}

const time12 = (t: string) => {
  const [h, mm] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "a.m." : "p.m."}`;
};
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

export function describeSchedule(s: Schedule): string {
  const at = time12(s.time);
  if (s.frequency === "daily") return `Every day at ${at}`;
  if (s.frequency === "weekdays") return `Every weekday at ${at}`;
  if (s.frequency === "weekly") return `Every ${WEEKDAYS[s.weekday ?? 1]} at ${at}`;
  return `On the ${ordinal(s.dayOfMonth ?? 1)} of every month at ${at}`;
}

/* ───────────── conditions ───────────── */

export type FieldType = "enum" | "rank" | "bool" | "text" | "number" | "building";
export type FieldDef = { key: string; label: string; type: FieldType; options?: Record<string, string>; ranks?: readonly string[]; only?: TriggerType[] };

const labelsOf = (m: Record<string, { label: string }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.label]));
const PRIORITY_RANK = ["low", "normal", "high", "urgent"] as const;
const SEVERITY_RANK = ["low", "medium", "high", "critical"] as const;

export const FIELDS: Record<SubjectType, FieldDef[]> = {
  work_order: [
    { key: "emergency", label: "Emergency", type: "bool" },
    { key: "category", label: "Category", type: "enum", options: WO_CATEGORY },
    { key: "priority", label: "Priority", type: "rank", options: labelsOf(PRIORITY), ranks: PRIORITY_RANK },
    { key: "new_status", label: "New status", type: "enum", options: labelsOf(WO_STATUS), only: ["workorder.status_changed"] },
    { key: "status", label: "Current status", type: "enum", options: labelsOf(WO_STATUS) },
    { key: "building", label: "Building", type: "building" },
    { key: "unassigned", label: "Nobody assigned", type: "bool" },
    { key: "source", label: "Reported by a resident", type: "bool" },
    { key: "title", label: "Title", type: "text" },
  ],
  complaint: [
    { key: "category", label: "Category", type: "enum", options: COMPLAINT_CATEGORY },
    { key: "priority", label: "Priority", type: "rank", options: labelsOf(PRIORITY), ranks: PRIORITY_RANK },
    { key: "building", label: "Building", type: "building" },
    { key: "title", label: "Subject", type: "text" },
  ],
  incident: [
    { key: "type", label: "Type", type: "enum", options: INCIDENT_TYPE },
    { key: "severity", label: "Severity", type: "rank", options: labelsOf(SEVERITY), ranks: SEVERITY_RANK },
    { key: "building", label: "Building", type: "building" },
    { key: "title", label: "Title", type: "text" },
  ],
  inspection: [
    { key: "kind", label: "Kind", type: "enum", options: INSPECTION_KIND },
    { key: "failed_items", label: "Failed items", type: "number" },
    { key: "building", label: "Building", type: "building" },
  ],
  booking: [
    { key: "amenity_kind", label: "Amenity", type: "enum", options: AMENITY_KIND },
    { key: "needs_approval", label: "Needs approval", type: "bool" },
    { key: "building", label: "Building", type: "building" },
  ],
  package: [
    { key: "perishable", label: "Perishable", type: "bool" },
    { key: "size", label: "Size", type: "enum", options: PACKAGE_SIZE },
    { key: "carrier", label: "Carrier", type: "text" },
    { key: "building", label: "Building", type: "building" },
  ],
  document: [
    { key: "category", label: "Category", type: "enum", options: DOCUMENT_CATEGORY },
    { key: "title", label: "Title", type: "text" },
  ],
};

export const OPS: Record<FieldType, { value: string; label: string }[]> = {
  enum: [{ value: "is", label: "is any of" }, { value: "is_not", label: "is none of" }],
  building: [{ value: "is", label: "is any of" }, { value: "is_not", label: "is none of" }],
  rank: [{ value: "at_least", label: "is at least" }, { value: "is", label: "is any of" }],
  bool: [{ value: "is_true", label: "is yes" }, { value: "is_false", label: "is no" }],
  text: [{ value: "contains", label: "contains" }],
  number: [{ value: "at_least", label: "is at least" }],
};

export const conditionSchema = z.object({
  field: z.string().min(1).max(40),
  op: z.enum(["is", "is_not", "at_least", "is_true", "is_false", "contains"]),
  value: z.union([z.array(z.string().max(80)).max(30), z.string().max(120), z.number(), z.boolean()]).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

export function fieldsFor(trigger: TriggerType): FieldDef[] {
  const s = subjectOf(trigger);
  return s ? FIELDS[s].filter((f) => !f.only || f.only.includes(trigger)) : [];
}

// a normalised snapshot of the record that triggered the rule; conditions are evaluated against it
export type Subject = {
  type: SubjectType; id: string; ref: string; title: string; href: string;
  propertyId: string | null; propertyName: string | null; buildingId: string | null; buildingName: string | null; unitLabel: string | null;
  fields: Record<string, string | number | boolean | null>;
  submitterUserId: string | null; assigneeMembershipId: string | null;
};

const asList = (v: Condition["value"]) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [String(v)]);

// every condition must hold; returns the first one that doesn't, for dry runs and run logs
export function evaluateConditions(trigger: TriggerType, conditions: Condition[], s: Subject | null): { ok: true } | { ok: false; failed: Condition } {
  const defs = fieldsFor(trigger);
  for (const c of conditions) {
    const def = defs.find((d) => d.key === c.field);
    if (!def || !s) return { ok: false, failed: c };
    const v = def.type === "building" ? s.buildingId : s.fields[c.field];
    let pass: boolean;
    switch (c.op) {
      case "is_true": pass = v === true; break;
      case "is_false": pass = v === false || v === null || v === undefined; break;
      case "is": pass = v !== null && v !== undefined && asList(c.value).includes(String(v)); break;
      case "is_not": pass = v === null || v === undefined || !asList(c.value).includes(String(v)); break;
      case "contains": pass = typeof v === "string" && typeof c.value === "string" && !!c.value.trim() && v.toLowerCase().includes(c.value.trim().toLowerCase()); break;
      case "at_least":
        if (def.type === "number") pass = typeof v === "number" && v >= Number(c.value);
        else pass = !!def.ranks && typeof v === "string" && def.ranks.indexOf(v) >= def.ranks.indexOf(String(c.value)) && def.ranks.includes(String(c.value));
        break;
    }
    if (!pass) return { ok: false, failed: c };
  }
  return { ok: true };
}

/* ───────────── actions ───────────── */

// {{variables}} available in notification, task and announcement text
export const AUTOMATION_VARIABLES = {
  ref: "Record number (e.g. WO-1042)", title: "Record title", property: "Property name", building: "Building name", unit: "Unit",
  category: "Category", priority: "Priority", status: "Status", rule: "This rule's name", date: "Today's date",
} as const;
export type AutomationVars = Partial<Record<keyof typeof AUTOMATION_VARIABLES, string | null>>;

export function renderAutomationText(text: string, vars: AutomationVars): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, name: string) => (name in AUTOMATION_VARIABLES ? (vars[name as keyof AutomationVars] ?? "") : whole)).replace(/[ \t]{2,}/g, " ").trim();
}

const recipientsSchema = z.object({
  roles: z.array(z.string().max(40)).max(10).default([]), // role keys, resolved to people whose scope covers the record's property
  members: z.array(z.string().uuid()).max(20).default([]),
  onCall: z.boolean().default(false), // whoever is on call at the property when the rule runs
  submitter: z.boolean().default(false), // the resident or staff member who reported it
  assignee: z.boolean().default(false),
});
export type Recipients = z.infer<typeof recipientsSchema>;

const text = (max: number, msg: string) => z.string().trim().min(1, msg).max(max);

export const ACTION_SCHEMAS = {
  set_priority: z.object({ type: z.literal("set_priority"), priority: z.enum(PRIORITY_RANK) }),
  set_status: z.object({ type: z.literal("set_status"), status: z.enum(["acknowledged", "in_progress", "awaiting_vendor", "awaiting_resident"]) }),
  assign: z.object({ type: z.literal("assign"), target: z.enum(["member", "vendor", "on_call"]), membershipId: z.string().uuid().optional(), vendorId: z.string().uuid().optional() })
    .refine((a) => (a.target === "member" ? !!a.membershipId : a.target === "vendor" ? !!a.vendorId : true), { message: "Choose who to assign." }),
  escalate: z.object({ type: z.literal("escalate") }),
  notify: z.object({ type: z.literal("notify"), to: recipientsSchema, title: text(200, "Add a notification title."), message: z.string().trim().max(1000).default("") })
    .refine((a) => a.to.roles.length || a.to.members.length || a.to.onCall || a.to.submitter || a.to.assignee, { message: "Choose who to notify." }),
  create_task: z.object({
    type: z.literal("create_task"), title: text(200, "Give the task a title."), details: z.string().trim().max(2000).default(""),
    assignTo: z.enum(["nobody", "member", "on_call"]).default("nobody"), membershipId: z.string().uuid().optional(),
    dueInMinutes: z.coerce.number().int().min(5).max(60 * 24 * 30).default(240), priority: z.enum(PRIORITY_RANK).default("normal"),
  }).refine((a) => a.assignTo !== "member" || !!a.membershipId, { message: "Choose who gets the task." }),
  draft_announcement: z.object({
    type: z.literal("draft_announcement"), title: text(140, "Add a title."), body: z.string().trim().min(5, "Write the announcement.").max(5000),
    audience: z.enum(["everyone", "residents", "staff"]).default("residents"),
  }),
  request_approval: z.object({ type: z.literal("request_approval"), role: z.string().min(1, "Choose who approves.").max(40), note: z.string().trim().max(500).default("") }),
  assistant_draft: z.object({ type: z.literal("assistant_draft"), instruction: z.string().trim().max(500).default("") }),
  send_report: z.object({ type: z.literal("send_report"), report: z.enum(["maintenance", "sla", "vendors", "complaints", "incidents", "workload", "health"]), period: z.enum(["7d", "30d"]).default("7d"), to: recipientsSchema }),
} as const;
export type ActionType = keyof typeof ACTION_SCHEMAS;
export const actionSchema = z.discriminatedUnion("type", [
  ACTION_SCHEMAS.set_priority, ACTION_SCHEMAS.set_status, ACTION_SCHEMAS.assign, ACTION_SCHEMAS.escalate, ACTION_SCHEMAS.notify, ACTION_SCHEMAS.create_task,
  ACTION_SCHEMAS.draft_announcement, ACTION_SCHEMAS.request_approval, ACTION_SCHEMAS.assistant_draft, ACTION_SCHEMAS.send_report,
]);
export type WorkflowAction = z.infer<typeof actionSchema>;

export const ACTIONS: Record<ActionType, { label: string; subjects: (SubjectType | "schedule")[]; help: string }> = {
  set_priority: { label: "Set priority", subjects: ["work_order"], help: "Changes the request's priority; SLA targets are recalculated." },
  set_status: { label: "Change status", subjects: ["work_order"], help: "Moves the request along (never completes or cancels it)." },
  assign: { label: "Assign", subjects: ["work_order"], help: "Assigns a staff member, a vendor or whoever is on call." },
  escalate: { label: "Escalate", subjects: ["work_order"], help: "Raises the request to urgent and alerts the property's managers." },
  notify: { label: "Notify people", subjects: ["work_order", "complaint", "incident", "inspection", "booking", "package", "document", "schedule"], help: "In-app notification, and email for people who get email for automation notices." },
  create_task: { label: "Create a task", subjects: ["work_order", "complaint", "incident", "inspection", "booking", "package", "document", "schedule"], help: "A task linked to the record, with a due time." },
  draft_announcement: { label: "Draft an announcement", subjects: ["work_order", "incident", "schedule"], help: "Saved as a draft — a person reviews and publishes it." },
  request_approval: { label: "Ask for approval", subjects: ["work_order", "complaint", "incident", "inspection", "booking", "package", "document", "schedule"], help: "Pauses the rule until someone with the role approves; the remaining steps run after that." },
  assistant_draft: { label: "Assistant draft", subjects: ["work_order", "complaint", "incident"], help: "The assistant writes a summary as an internal note marked as a draft. Nothing is sent." },
  send_report: { label: "Send a report", subjects: ["schedule", "work_order", "complaint", "incident", "inspection", "booking", "package", "document"], help: "Sends the report's headline numbers with a link to the full report." },
};

export function actionsFor(trigger: TriggerType): ActionType[] {
  const s = subjectOf(trigger) ?? "schedule";
  return (Object.keys(ACTIONS) as ActionType[]).filter((a) => ACTIONS[a].subjects.includes(s));
}

export const REPORT_LABEL: Record<string, string> = {
  maintenance: "Maintenance requests", sla: "SLA by property", vendors: "Vendor performance", complaints: "Complaints", incidents: "Incidents", workload: "Staff workload", health: "Property health",
  inspections: "Inspections", amenities: "Amenity utilisation", packages: "Packages",
};

/* ───────────── the whole rule ───────────── */

export const workflowSchema = z.object({
  name: text(120, "Give the rule a name."),
  description: z.string().trim().max(1000).default(""),
  propertyId: z.string().uuid().nullable(),
  trigger: z.enum(TRIGGER_TYPES as [TriggerType, ...TriggerType[]]),
  schedule: scheduleSchema.nullable().default(null),
  conditions: z.array(conditionSchema).max(10).default([]),
  actions: z.array(actionSchema).min(1, "Add at least one action.").max(12),
}).superRefine((w, c) => {
  if (w.trigger === "schedule" && !w.schedule) c.addIssue({ code: "custom", message: "Set when the rule runs.", path: ["schedule"] });
  if (w.trigger !== "schedule" && w.schedule) c.addIssue({ code: "custom", message: "Only scheduled rules have a schedule.", path: ["schedule"] });
  const fields = fieldsFor(w.trigger);
  w.conditions.forEach((cond, i) => {
    const def = fields.find((f) => f.key === cond.field);
    if (!def) return c.addIssue({ code: "custom", message: `“${cond.field}” isn't something this trigger can check.`, path: ["conditions", i] });
    if (!OPS[def.type].some((o) => o.value === cond.op)) c.addIssue({ code: "custom", message: `${def.label} can't be compared that way.`, path: ["conditions", i] });
    if (["is", "is_not"].includes(cond.op) && !asList(cond.value).length) c.addIssue({ code: "custom", message: `Choose at least one ${def.label.toLowerCase()} value.`, path: ["conditions", i] });
    if ((def.type === "enum" || def.type === "rank") && def.options && asList(cond.value).some((v) => !(v in def.options!))) c.addIssue({ code: "custom", message: `Unknown ${def.label.toLowerCase()}.`, path: ["conditions", i] });
    if (cond.op === "contains" && (typeof cond.value !== "string" || !cond.value.trim())) c.addIssue({ code: "custom", message: "Enter the text to look for.", path: ["conditions", i] });
    if (cond.op === "at_least" && def.type === "number" && !Number.isFinite(Number(cond.value))) c.addIssue({ code: "custom", message: "Enter a number.", path: ["conditions", i] });
  });
  const allowed = actionsFor(w.trigger);
  w.actions.forEach((a, i) => {
    if (!allowed.includes(a.type)) c.addIssue({ code: "custom", message: `“${ACTIONS[a.type].label}” doesn't apply to this trigger.`, path: ["actions", i] });
  });
  const approvals = w.actions.filter((a) => a.type === "request_approval").length;
  if (approvals > 1) c.addIssue({ code: "custom", message: "A rule can ask for approval once.", path: ["actions"] });
  if (w.actions.at(-1)?.type === "request_approval") c.addIssue({ code: "custom", message: "Add the steps that should run after approval.", path: ["actions"] });
});
export type WorkflowInput = z.infer<typeof workflowSchema>;

/* ───────────── plain language ───────────── */

// ids → names for the sentences (buildings, people, vendors, roles, properties)
export type NameBook = { buildings?: Record<string, string>; members?: Record<string, string>; vendors?: Record<string, string>; roles?: Record<string, string>; properties?: Record<string, string> };

// "Property Manager" → "Property Managers"; "Security" and "Staff" stay as they are
export const pluralRole = (name: string) => (/(staff|security)$/i.test(name) ? name : /[^aeiou]y$/i.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`);

const join = (xs: string[], last = "or") => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${last} ${xs.at(-1)}`);

export function describeCondition(trigger: TriggerType, c: Condition, n: NameBook = {}): string {
  const def = fieldsFor(trigger).find((d) => d.key === c.field);
  if (!def) return `${c.field} (no longer available)`;
  const name = (v: string) => (def.type === "building" ? n.buildings?.[v] ?? "a removed building" : def.options?.[v] ?? v);
  const vals = asList(c.value).map(name);
  switch (c.op) {
    case "is_true": return def.key === "source" ? "it was reported by a resident" : def.key === "unassigned" ? "nobody is assigned" : `it's marked ${def.label.toLowerCase()}`;
    case "is_false": return def.key === "source" ? "it wasn't reported by a resident" : def.key === "unassigned" ? "someone is assigned" : `it's not marked ${def.label.toLowerCase()}`;
    case "is": return `${def.label.toLowerCase()} is ${join(vals)}`;
    case "is_not": return `${def.label.toLowerCase()} isn't ${join(vals, "or")}`;
    case "contains": return `${def.label.toLowerCase()} contains “${String(c.value ?? "")}”`;
    case "at_least": return def.type === "number" ? `${def.label.toLowerCase()} is ${String(c.value)} or more` : `${def.label.toLowerCase()} is ${name(String(c.value)).toLowerCase()} or higher`;
  }
}

function describeRecipients(r: Recipients, n: NameBook): string {
  const parts = [
    ...r.roles.map((k) => pluralRole(n.roles?.[k] ?? k)),
    ...r.members.map((m) => n.members?.[m] ?? "a removed person"),
    r.onCall ? "whoever is on call" : "", r.submitter ? "the person who reported it" : "", r.assignee ? "whoever is assigned" : "",
  ].filter(Boolean);
  return join(parts, "and") || "nobody";
}

const mins = (m: number) => (m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`);

export function describeAction(a: WorkflowAction, n: NameBook = {}): string {
  switch (a.type) {
    case "set_priority": return `Set the priority to ${PRIORITY[a.priority]?.label.toLowerCase() ?? a.priority}`;
    case "set_status": return `Change the status to ${WO_STATUS[a.status]?.label.toLowerCase() ?? a.status}`;
    case "assign": return a.target === "on_call" ? "Assign whoever is on call" : a.target === "vendor" ? `Assign ${n.vendors?.[a.vendorId ?? ""] ?? "a removed vendor"}` : `Assign ${n.members?.[a.membershipId ?? ""] ?? "a removed person"}`;
    case "escalate": return "Escalate: raise it to urgent and alert the property's managers";
    case "notify": return `Notify ${describeRecipients(a.to, n)}: “${a.title}”`;
    case "create_task": return `Create a task “${a.title}”${a.assignTo === "on_call" ? " for whoever is on call" : a.assignTo === "member" ? ` for ${n.members?.[a.membershipId ?? ""] ?? "a removed person"}` : ""}, due ${mins(a.dueInMinutes)} later`;
    case "draft_announcement": return `Draft an announcement “${a.title}” for review (not published)`;
    case "request_approval": return `Ask a ${n.roles?.[a.role] ?? a.role} to approve before continuing`;
    case "assistant_draft": return "Have the assistant draft a summary as an internal note (nothing is sent)";
    case "send_report": return `Send the ${REPORT_LABEL[a.report]?.toLowerCase() ?? a.report} report (last ${a.period === "7d" ? "7" : "30"} days) to ${describeRecipients(a.to, n)}`;
  }
}

export function describeTrigger(w: { trigger: TriggerType; schedule?: Schedule | null; propertyId: string | null }, n: NameBook = {}): string {
  const where = w.propertyId ? ` at ${n.properties?.[w.propertyId] ?? "a removed property"}` : " at any property";
  if (w.trigger === "schedule" && w.schedule) return `${describeSchedule(w.schedule)}${w.propertyId ? ` for ${n.properties?.[w.propertyId] ?? "a removed property"}` : " for every property"}`;
  return `When ${TRIGGERS[w.trigger].label.replace(/^A /, "a ").replace(/^An /, "an ")}${where}`;
}

// "When a maintenance request is created at Fraser Towers, if it's marked emergency and category is elevator: …"
export function describeWorkflow(w: Pick<WorkflowInput, "trigger" | "schedule" | "propertyId" | "conditions" | "actions">, n: NameBook = {}) {
  return {
    when: describeTrigger(w, n),
    conditions: w.conditions.map((c) => describeCondition(w.trigger, c, n)),
    actions: w.actions.map((a) => describeAction(a, n)),
  };
}
