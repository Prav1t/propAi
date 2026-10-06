import "server-only";
import { z } from "zod";
import { can } from "../../authz/authorize";
import { createTask, getTask, listTaskAssignees, type TaskInput } from "../../modules/tasks/service";
import { getInspection, inspectionFormOptions, listTemplates, scheduleInspection } from "../../modules/inspections/service";
import { createIncident, getIncident, SEVERITIES } from "../../modules/incidents/service";
import { INCIDENT_TYPES } from "../../db/schema";
import { utcToZonedInput } from "@/lib/time";
import { defineAction, err } from "./registry";
import { atLocal, dateArg, fmtDay, fmtWhen, isToolErr, label, locationArg, pickByName, placeFilter } from "./common";
import { buildingFor, isErr, myUnits, propertyFor, resolveUnit } from "./resolve";

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const opts = (vals: readonly string[]) => vals.map((v) => ({ value: v, label: label(v) }));
const timeArg = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24-hour).");

export const createTaskAction = defineAction({
  name: "create_task",
  title: "Preparing a task",
  description: "Prepare an internal task for staff (optional due date/time, priority and assignee). Runs after approval, or on its own if the organization allows.",
  input: z.object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(5000).optional(),
    location: locationArg,
    due: dateArg.optional().describe("Due date YYYY-MM-DD."),
    dueTime: timeArg.optional().describe("Due time HH:MM (default 17:00)."),
    priority: z.enum(PRIORITIES).optional(),
    assignee: z.string().trim().max(120).optional().describe("Staff member's name."),
  }),
  available: (p) => p.permissions.has("task.manage"),
  riskClass: () => 2,
  policyKeys: () => ["task.create"],
  editable: [
    { key: "title", label: "Title", type: "text" },
    { key: "description", label: "Details", type: "textarea" },
    { key: "due", label: "Due date", type: "date" },
    { key: "priority", label: "Priority", type: "select", options: opts(PRIORITIES) },
  ],
  async prepare(ctx, a, env) {
    const p = ctx.principal;
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return pf;
    const prop = await propertyFor(ctx, pf.place, { allowOrgWide: true });
    if (isErr(prop)) return prop;
    if (prop.propertyId ? !can(p, "task.manage", { orgId: p.orgId, propertyId: prop.propertyId }) : !can(p, "task.manage")) return err("FORBIDDEN", "You can't create tasks there.");
    let assignee: { membershipId: string; name: string } | null = null;
    if (a.assignee) {
      const picked = pickByName(await listTaskAssignees(ctx, prop.propertyId), a.assignee, (x) => x.name, "staff member who can take tasks here");
      if (isToolErr(picked)) return picked;
      assignee = picked;
    }
    const dueUtc = a.due ? atLocal(a.due, a.dueTime, env, "17:00") : null;
    if (a.due && a.due < env.today) return err("INVALID", "That due date is in the past.");
    const input: TaskInput = {
      title: a.title, description: a.description ?? null, propertyId: prop.propertyId, priority: a.priority ?? "normal", dueAt: dueUtc ? utcToZonedInput(dueUtc, env.timeZone) : null,
      assignedMembershipId: assignee?.membershipId ?? null, recurrence: "none", checklist: [], blockedByTaskId: null,
    };
    return {
      ok: true,
      step: {
        title: `Create task “${a.title}”`,
        details: [prop.label, `Priority ${input.priority}${dueUtc ? ` · due ${fmtWhen(dueUtc, env)}` : ""}`, `Assigned to ${assignee?.name ?? "nobody yet"}`, ...(a.description ? [a.description] : [])],
        effects: assignee ? [`${assignee.name} is notified`] : [],
        resolved: { input, dueUtc: dueUtc?.toISOString() ?? null },
        propertyId: prop.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const t = await createTask(ctx, r.input as TaskInput, r.dueUtc ? new Date(String(r.dueUtc)) : null);
    return { summary: `Created the task “${t.title}”.`, record: { ref: "Task", title: t.title, href: env.href(`/tasks/${t.id}`) }, check: { id: t.id } };
  },
  async verify(ctx, o) {
    const d = await getTask(ctx, String(o.check!.id));
    return { ok: true, summary: `The task is open${d.assigneeName ? ` and assigned to ${d.assigneeName}` : ""}.` };
  },
});

export const scheduleInspectionAction = defineAction({
  name: "schedule_inspection",
  title: "Preparing an inspection",
  description: "Prepare scheduling an inspection from one of the organization's checklist templates for a building (optionally one unit) on a date.",
  input: z.object({
    location: z.string().trim().min(1).max(120).describe("Building or property, e.g. 'Tower B'."),
    date: dateArg,
    template: z.string().trim().max(120).optional().describe("Checklist template name, e.g. 'Fire safety'."),
    unit: z.string().trim().max(20).optional(),
    inspector: z.string().trim().max(120).optional(),
    title: z.string().trim().max(160).optional(),
  }),
  available: (p) => p.permissions.has("inspection.manage"),
  riskClass: () => 2,
  policyKeys: () => ["inspection.schedule"],
  editable: [{ key: "date", label: "Date", type: "date" }, { key: "title", label: "Title", type: "text" }],
  async prepare(ctx, a, env) {
    const p = ctx.principal;
    if (a.date < env.today) return err("INVALID", "That date is in the past.");
    const pf = await placeFilter(ctx, a.location);
    if (isErr(pf)) return pf;
    const b = await buildingFor(ctx, pf.place);
    if (isErr(b)) return b;
    if (!can(p, "inspection.manage", { orgId: p.orgId, propertyId: b.propertyId, buildingId: b.buildingId })) return err("FORBIDDEN", "You can't schedule inspections there.");
    const templates = await listTemplates(ctx);
    const t = a.template ? pickByName(templates, a.template, (x) => x.name, "inspection checklist") : templates.length === 1 ? templates[0]
      : err("AMBIGUOUS", "Which checklist should the inspection use?", templates.map((x) => x.name));
    if (isToolErr(t)) return t;
    let unitNumber: string | null = null;
    if (a.unit) {
      const u = await resolveUnit(ctx, a.unit, { propertyId: b.propertyId, buildingId: b.buildingId, label: b.label });
      if (isErr(u)) return u;
      unitNumber = u!.number;
    }
    let inspector: { membershipId: string; name: string } | null = null;
    if (a.inspector) {
      const picked = pickByName(await inspectionFormOptions(ctx, b.propertyId), a.inspector, (x) => x.name, "inspector for this property");
      if (isToolErr(picked)) return picked;
      inspector = picked;
    }
    return {
      ok: true,
      step: {
        title: `Schedule “${a.title ?? t.name}” for ${fmtDay(a.date, env)}`,
        details: [unitNumber ? `Unit ${unitNumber} · ${b.label}` : b.label, `Checklist: ${t.name}`, `Inspector: ${inspector?.name ?? "not assigned yet"}`],
        effects: inspector ? [`It appears on ${inspector.name}'s calendar`] : ["It appears on the inspections calendar"],
        resolved: { templateId: t.id, buildingId: b.buildingId, unitNumber, scheduledFor: a.date, inspectorMembershipId: inspector?.membershipId ?? null, title: a.title ?? null },
        propertyId: b.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const i = await scheduleInspection(ctx, r as Parameters<typeof scheduleInspection>[1]);
    return { summary: `Scheduled “${i.title}” for ${fmtDay(i.scheduledFor, env)}.`, record: { ref: "Inspection", title: i.title, href: env.href(`/inspections/${i.id}`) }, check: { id: i.id } };
  },
  async verify(ctx, o) {
    const d = await getInspection(ctx, String(o.check!.id));
    return { ok: d.inspection.status === "scheduled", summary: `Inspection on file for ${d.inspection.scheduledFor} with ${d.items.length} checklist items.` };
  },
});

export const createIncidentAction = defineAction({
  name: "create_incident",
  title: "Preparing an incident report",
  description: "Prepare an incident report (security, water damage, injury, equipment failure…). Residents can report in their own building. Record facts only; never name someone as responsible.",
  input: z.object({
    title: z.string().trim().min(3).max(160),
    type: z.enum(INCIDENT_TYPES),
    severity: z.enum(SEVERITIES).optional(),
    description: z.string().trim().max(10_000).optional(),
    location: locationArg,
    unit: z.string().trim().max(20).optional(),
    where: z.string().trim().max(200).optional().describe("Spot in the building, e.g. 'P2 ramp'."),
    occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional().describe("Local date and time YYYY-MM-DDTHH:MM; default now."),
  }),
  available: (p) => p.permissions.has("incident.create"),
  riskClass: () => 2,
  policyKeys: () => ["incident.create"],
  editable: [
    { key: "title", label: "Title", type: "text" },
    { key: "description", label: "What happened", type: "textarea" },
    { key: "severity", label: "Severity", type: "select", options: opts(SEVERITIES) },
    { key: "where", label: "Where exactly", type: "text" },
  ],
  async prepare(ctx, a, env) {
    const p = ctx.principal;
    let loc: { propertyId: string; buildingId: string; unitId: string | null; label: string };
    if (p.role.category === "resident") {
      const mine = await myUnits(ctx);
      if (!mine.length) return err("FORBIDDEN", "Your account isn't linked to a unit yet.");
      const unit = a.unit ? mine.find((u) => u.number.toLowerCase() === a.unit!.toLowerCase()) : null;
      const home = unit ?? mine[0];
      loc = { propertyId: home.propertyId, buildingId: home.buildingId, unitId: unit?.id ?? null, label: unit ? unit.label : home.label.split(" · ").slice(1).join(" · ") };
    } else {
      const pf = await placeFilter(ctx, a.location);
      if (isErr(pf)) return pf;
      if (a.unit) {
        const u = await resolveUnit(ctx, a.unit, pf.place);
        if (isErr(u)) return u;
        loc = { propertyId: u!.propertyId, buildingId: u!.buildingId, unitId: u!.id, label: u!.label };
      } else {
        const b = await buildingFor(ctx, pf.place);
        if (isErr(b)) return b;
        loc = { ...b, unitId: null };
      }
      if (!can(p, "incident.create", { orgId: p.orgId, propertyId: loc.propertyId, buildingId: loc.buildingId })) return err("FORBIDDEN", "You can't report incidents there.");
    }
    const occurred = a.occurredAt ? atLocal(a.occurredAt.slice(0, 10), a.occurredAt.slice(11, 16), env) : env.now;
    if (occurred.getTime() > env.now.getTime() + 5 * 60_000) return err("INVALID", "An incident can't be in the future.");
    const severity = a.severity ?? "medium";
    return {
      ok: true,
      step: {
        title: `Report incident “${a.title}”`,
        details: [[loc.label, a.where].filter(Boolean).join(" · "), `${label(a.type)} · ${severity} severity`, `Happened ${fmtWhen(occurred, env)}`, ...(a.description ? [a.description] : [])],
        effects: ["Staff responsible for the building are notified according to severity"],
        resolved: {
          input: { type: a.type, severity, title: a.title, description: a.description ?? "", buildingId: loc.buildingId, unitNumber: null, unitId: loc.unitId, location: a.where ?? null,
            occurredAt: utcToZonedInput(occurred, env.timeZone), peopleInvolved: null, externalReference: null },
          occurredUtc: occurred.toISOString(),
        },
        propertyId: loc.propertyId,
      },
    };
  },
  async execute(ctx, r, env) {
    const i = await createIncident(ctx, r.input as Parameters<typeof createIncident>[1], new Date(String(r.occurredUtc)));
    return { summary: `Reported incident #${i.number} “${i.title}”.`, record: { ref: `Incident #${i.number}`, title: i.title, href: env.href(`/incidents/${i.id}`) }, check: { id: i.id } };
  },
  async verify(ctx, o) {
    const d = await getIncident(ctx, String(o.check!.id));
    return { ok: true, summary: `Incident #${d.incident.number} is ${d.incident.status}.` };
  },
});
