// Starter rules for the builder (Iteration 9). Each is an ordinary rule the manager reviews and adjusts before saving.
import type { WorkflowInput } from "./automation";

const none = { roles: [] as string[], members: [] as string[], onCall: false, submitter: false, assignee: false };

export const TEMPLATES: { key: string; title: string; about: string; rule: Omit<WorkflowInput, "propertyId"> }[] = [
  {
    key: "elevator_emergency", title: "Elevator emergencies", about: "Raise to urgent, alert managers and whoever is on call, open a check-in task, and tell the resident only after a manager approves.",
    rule: {
      name: "Elevator emergencies", description: "", trigger: "workorder.created", schedule: null,
      conditions: [{ field: "emergency", op: "is_true" }, { field: "category", op: "is", value: ["elevator"] }],
      actions: [
        { type: "set_priority", priority: "urgent" },
        { type: "notify", to: { ...none, roles: ["property_manager"], onCall: true }, title: "Elevator emergency: {{ref}} at {{property}}", message: "{{title}} — {{building}} {{unit}}" },
        { type: "create_task", title: "Confirm nobody is trapped — {{ref}}", details: "Check the car, call the resident back, and update the request.", assignTo: "on_call", dueInMinutes: 60, priority: "urgent" },
        { type: "request_approval", role: "property_manager", note: "Approve to tell the resident a technician is being dispatched." },
        { type: "notify", to: { ...none, submitter: true }, title: "A technician is on the way for {{ref}}", message: "We've dispatched a technician for “{{title}}”. We'll update the request as soon as we know more." },
      ],
    },
  },
  {
    key: "sla_warning", title: "Requests close to their target", about: "Tell the assignee and the property's managers before a request misses its resolution target.",
    rule: {
      name: "Due-soon warning", description: "", trigger: "workorder.sla_approaching", schedule: null, conditions: [],
      actions: [{ type: "notify", to: { ...none, roles: ["property_manager"], assignee: true }, title: "Due soon: {{ref}} {{title}}", message: "{{priority}} priority at {{property}} — it's close to its resolution target." }],
    },
  },
  {
    key: "urgent_complaint", title: "Urgent complaints", about: "High or urgent complaints alert the managers and create a call-back task.",
    rule: {
      name: "Urgent complaints", description: "", trigger: "complaint.created", schedule: null,
      conditions: [{ field: "priority", op: "at_least", value: "high" }],
      actions: [
        { type: "notify", to: { ...none, roles: ["property_manager"] }, title: "Urgent complaint {{ref}}: {{title}}", message: "{{category}} at {{property}}" },
        { type: "create_task", title: "Call the resident about {{ref}}", details: "", assignTo: "nobody", dueInMinutes: 240, priority: "high" },
      ],
    },
  },
  {
    key: "perishable", title: "Perishable packages", about: "When a perishable package is logged, remind the desk to reach the resident within the hour.",
    rule: {
      name: "Perishable packages", description: "", trigger: "package.arrived", schedule: null,
      conditions: [{ field: "perishable", op: "is_true" }],
      actions: [{ type: "create_task", title: "Reach the resident in unit {{unit}} about a perishable package", details: "", assignTo: "on_call", dueInMinutes: 60, priority: "high" }],
    },
  },
  {
    key: "failed_inspection", title: "Failed inspection follow-up", about: "A failed inspection gets a corrective-work task and a note to the managers.",
    rule: {
      name: "Failed inspection follow-up", description: "", trigger: "inspection.failed", schedule: null,
      conditions: [{ field: "failed_items", op: "at_least", value: 1 }],
      actions: [
        { type: "create_task", title: "Plan corrective work: {{title}}", details: "Review the failed items and open work orders for each.", assignTo: "nobody", dueInMinutes: 4320, priority: "high" },
        { type: "notify", to: { ...none, roles: ["property_manager"] }, title: "Inspection failed: {{title}}", message: "{{property}}" },
      ],
    },
  },
  {
    key: "serious_incident", title: "Serious incidents", about: "High or critical incidents alert managers and whoever is on call, and the assistant drafts a summary for the file.",
    rule: {
      name: "Serious incidents", description: "", trigger: "incident.created", schedule: null,
      conditions: [{ field: "severity", op: "at_least", value: "high" }],
      actions: [
        { type: "notify", to: { ...none, roles: ["property_manager"], onCall: true }, title: "{{priority}} incident {{ref}}: {{title}}", message: "{{property}} {{building}}" },
        { type: "assistant_draft", instruction: "Summarise what happened and what has been done so far." },
      ],
    },
  },
  {
    key: "weekly_report", title: "Weekly maintenance report", about: "Every Monday morning, the property managers get last week's numbers with a link to the full report.",
    rule: {
      name: "Weekly maintenance report", description: "", trigger: "schedule", schedule: { frequency: "weekly", time: "08:00", weekday: 1 }, conditions: [],
      actions: [{ type: "send_report", report: "maintenance", period: "7d", to: { ...none, roles: ["property_manager"] } }],
    },
  },
];
