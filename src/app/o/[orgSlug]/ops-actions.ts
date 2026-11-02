"use server";
import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { runOrgForm } from "@/server/form-action";
import type { ActionState } from "@/server/actions";
import { zonedToUtc } from "@/lib/time";
import type { TenantCtx } from "@/server/modules/context";
import { ValidationError } from "@/server/modules/context";
import {
  assignSchema, assignWorkOrder, commentOnWorkOrder, commentSchema, createWoSchema, createWorkOrder, detailsSchema,
  scheduleSchema, scheduleWorkOrder, transitionSchema, transitionWorkOrder, updateWorkOrderDetails,
} from "@/server/modules/maintenance/service";
import { createRule, deleteRule, deleteSla, ruleSchema, setRuleActive, slaSchema, upsertSla } from "@/server/modules/maintenance/config";
import { WO_CATEGORIES } from "@/server/modules/maintenance/rules";
import { assignTask, commentOnTask, createTask, setTaskStatus, taskSchema, TASK_STATUSES, toggleChecklistItem } from "@/server/modules/tasks/service";
import {
  archiveTemplate, completeInspection, completeSchema, createFollowUpWorkOrder, createTemplate, itemSchema, recordItem,
  scheduleInspection, scheduleInspectionSchema, templateSchema,
} from "@/server/modules/inspections/service";
import { createIncident, incidentSchema, incidentUpdateSchema, updateIncident } from "@/server/modules/incidents/service";
import { commentOnComplaint, complaintCommentSchema, complaintSchema, complaintUpdateSchema, createComplaint, updateComplaint } from "@/server/modules/complaints/service";
import { markRead, NOTIFICATION_KINDS, savePreferences } from "@/server/modules/notifications/service";
import { uploadFiles, type Attachable } from "@/server/files/service";
import type { Visibility } from "@/server/modules/ops/core";

const none = z.object({}).passthrough();
const base = (s: string) => `/o/${s}`;
const tz = (c: TenantCtx) => c.principal.orgTimezone ?? "UTC";
const filesFrom = (fd: FormData) => fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

/* ───── maintenance ───── */

// the form carries a draft reference (clientRef): submitting twice, or sending a draft saved while offline after the
// first attempt actually arrived, gives back the same request instead of a duplicate
const clientRefOf = (fd: FormData) => { const v = fd.get("clientRef"); return typeof v === "string" && v ? v : null; };

export async function createWorkOrderAction(slug: string, _: ActionState, fd: FormData) {
  const files = filesFrom(fd);
  let uploadFailed = false;
  return runOrgForm({
    orgSlug: slug, fd, schema: createWoSchema,
    run: async (c, d) => {
      const r = await createWorkOrder(c, d, { clientRef: clientRefOf(fd) });
      // the request is saved even if a photo is rejected; the page tells the user to retry the upload
      if (files.length && !r.duplicate) await uploadFiles(c, "work_order", r.workOrder.id, files, "public").catch(() => { uploadFailed = true; });
      return r;
    },
    done: (r) => ({ redirectTo: `${base(slug)}/maintenance/${r.workOrder.id}?created=1${uploadFailed ? "&upload=failed" : ""}` }),
  });
}

// sends a request that was saved on the device while offline (no redirect: it runs in the background)
export async function sendWorkOrderDraftAction(slug: string, fd: FormData): Promise<ActionState> {
  const files = filesFrom(fd);
  if (!clientRefOf(fd)) return { error: "Invalid draft." };
  let uploadFailed = false;
  return runOrgForm({
    orgSlug: slug, fd, schema: createWoSchema,
    run: async (c, d) => {
      const r = await createWorkOrder(c, d, { clientRef: clientRefOf(fd) });
      if (files.length && !r.duplicate) await uploadFiles(c, "work_order", r.workOrder.id, files, "public").catch(() => { uploadFailed = true; });
      return r;
    },
    done: (r) => ({ message: `Request #${r.workOrder.number} sent.`, data: { id: r.workOrder.id, number: r.workOrder.number, href: `${base(slug)}/maintenance/${r.workOrder.id}`, uploadFailed } }),
  });
}

export async function transitionWorkOrderAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: transitionSchema, run: (c, d) => transitionWorkOrder(c, id, d), done: (w) => ({ message: `Moved to ${w.status.replace(/_/g, " ")}.` }) });
}

export async function assignWorkOrderAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: assignSchema, run: (c, d) => assignWorkOrder(c, id, d), done: () => ({ message: "Assignment saved." }) });
}

export async function scheduleWorkOrderAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: scheduleSchema, run: (c, d) => scheduleWorkOrder(c, id, d, zonedToUtc(d.start, tz(c))), done: () => ({ message: "Visit scheduled." }) });
}

export async function commentWorkOrderAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: commentSchema, run: (c, d) => commentOnWorkOrder(c, id, d), done: () => ({ message: "Comment posted." }) });
}

export async function updateWorkOrderDetailsAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: detailsSchema, run: (c, d) => updateWorkOrderDetails(c, id, d), done: () => ({ message: "Details saved." }) });
}

/* ───── attachments (any supported record) ───── */

const visibilitySchema = z.object({ visibility: z.enum(["public", "vendor", "internal"]).default("public") });

export async function uploadAttachmentAction(slug: string, entityType: Attachable, entityId: string, _: ActionState, fd: FormData) {
  const files = filesFrom(fd);
  return runOrgForm({
    orgSlug: slug, fd, schema: visibilitySchema,
    run: (c, d) => uploadFiles(c, entityType, entityId, files, d.visibility as Visibility),
    done: (rows) => ({ message: `Uploaded ${rows.length} file${rows.length === 1 ? "" : "s"}.` }),
  });
}

/* ───── maintenance settings ───── */

export async function upsertSlaAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: slaSchema, run: upsertSla, done: () => ({ message: "SLA target saved." }) });
}
export async function deleteSlaAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteSla(c, id), done: () => ({ message: "Override removed." }) });
}
export async function createRuleAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: ruleSchema, run: createRule, done: (r) => ({ message: `Rule “${r.name}” created.` }) });
}
export async function setRuleActiveAction(slug: string, id: string, active: boolean, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => setRuleActive(c, id, active), done: () => ({ message: active ? "Rule enabled." : "Rule disabled." }) });
}
export async function deleteRuleAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteRule(c, id), done: () => ({ message: "Rule deleted." }) });
}

/* ───── tasks ───── */

export async function createTaskAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: taskSchema,
    run: (c, d) => {
      const due = d.dueAt ? zonedToUtc(d.dueAt, tz(c)) : null;
      if (due && Number.isNaN(due.getTime())) throw new ValidationError("Invalid due date.", "dueAt");
      return createTask(c, d, due);
    },
    done: (t) => ({ redirectTo: `${base(slug)}/tasks/${t.id}` }),
  });
}
const taskStatusSchema = z.object({ status: z.enum(TASK_STATUSES), note: z.string().trim().max(2000).optional() });
export async function setTaskStatusAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: taskStatusSchema, run: (c, d) => setTaskStatus(c, id, d.status, d.note || null), done: () => ({ message: "Status updated." }) });
}
// called directly by the optimistic checklist (no form); the same checks as every org form
export async function setChecklistItemAction(slug: string, itemId: string, done: boolean): Promise<ActionState> {
  if (typeof itemId !== "string" || typeof done !== "boolean") return { error: "Invalid request." };
  return runOrgForm({ orgSlug: slug, fd: new FormData(), schema: none, run: (c) => toggleChecklistItem(c, itemId, done), done: () => ({ message: "Saved." }) });
}
const memberSchema = z.object({ membershipId: z.union([z.literal(""), z.string().uuid()]).optional().transform((v) => v || null) });
export async function assignTaskAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: memberSchema, run: (c, d) => assignTask(c, id, d.membershipId), done: () => ({ message: "Assignment saved." }) });
}
const bodySchema = z.object({ body: z.string().trim().min(1, "Write a comment.").max(4000) });
export async function commentTaskAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: bodySchema, run: (c, d) => commentOnTask(c, id, d.body), done: () => ({ message: "Comment posted." }) });
}

/* ───── inspections ───── */

export async function createTemplateAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: templateSchema, run: createTemplate, done: (t) => ({ message: `Template “${t.name}” created.` }) });
}
export async function archiveTemplateAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => archiveTemplate(c, id), done: () => ({ message: "Template archived." }) });
}
export async function scheduleInspectionAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: scheduleInspectionSchema, run: scheduleInspection, done: (i) => ({ redirectTo: `${base(slug)}/inspections/${i.id}` }) });
}
export async function recordItemAction(slug: string, itemId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: itemSchema, run: (c, d) => recordItem(c, itemId, d), done: () => ({ message: "Saved." }) });
}
export async function completeInspectionAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: completeSchema, run: (c, d) => completeInspection(c, id, d), done: (i) => ({ message: i.result === "pass" ? "Inspection passed and signed." : "Inspection completed with failures — create follow-ups below." }) });
}
const followUpSchema = z.object({ category: z.enum(WO_CATEGORIES) });
export async function followUpWorkOrderAction(slug: string, itemId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: followUpSchema, run: (c, d) => createFollowUpWorkOrder(c, itemId, d.category), done: (w) => ({ message: `Work order #${w.number} created.` }) });
}

/* ───── incidents ───── */

export async function createIncidentAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: incidentSchema, run: (c, d) => createIncident(c, d, zonedToUtc(d.occurredAt, tz(c))), done: (i) => ({ redirectTo: `${base(slug)}/incidents/${i.id}` }) });
}
export async function updateIncidentAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: incidentUpdateSchema, run: (c, d) => updateIncident(c, id, d), done: () => ({ message: "Incident updated." }) });
}

/* ───── complaints ───── */

export async function createComplaintAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: complaintSchema, run: createComplaint, done: (c) => ({ redirectTo: `${base(slug)}/complaints/${c.id}` }) });
}
export async function updateComplaintAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: complaintUpdateSchema, run: (c, d) => updateComplaint(c, id, d), done: () => ({ message: "Complaint updated." }) });
}
export async function commentComplaintAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: complaintCommentSchema, run: (c, d) => commentOnComplaint(c, id, d), done: () => ({ message: "Message sent." }) });
}

/* ───── notifications ───── */


// called directly by the optimistic notification list
export async function markAllReadAction(slug: string): Promise<ActionState> {
  return runOrgForm({ orgSlug: slug, fd: new FormData(), schema: none, run: (c) => markRead(c, "all"), done: () => ({ message: "Marked as read." }) });
}

// opening a notification marks it read, then follows its link (only same-org relative links are followed)
export async function openNotificationAction(slug: string, id: string, href: string | null) {
  const { getOrgContext } = await import("@/server/org-context");
  const { ctx } = await getOrgContext(slug);
  await markRead(ctx, id);
  revalidatePath(base(slug), "layout");
  const safe = href && href.startsWith(`${base(slug)}/`) && !href.startsWith("//") ? href : `${base(slug)}/notifications`;
  redirect(safe);
}

export async function savePreferencesAction(slug: string, _: ActionState, fd: FormData) {
  const withPush = fd.get("withPush") === "1";
  const prefs = Object.keys(NOTIFICATION_KINDS).map((kind) => ({ kind, email: fd.get(`email:${kind}`) === "on", inApp: fd.get(`app:${kind}`) === "on", ...(withPush ? { push: fd.get(`push:${kind}`) === "on" } : {}) }));
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => savePreferences(c, prefs), done: () => ({ message: "Preferences saved." }) });
}

/* ───── bulk changes on the maintenance list ───── */

export async function bulkWorkOrdersAction(slug: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const { bulkSchema, bulkUpdateWorkOrders } = await import("@/server/modules/maintenance/bulk");
  const ids = fd.getAll("ids").filter((x): x is string => typeof x === "string");
  return runOrgForm({
    orgSlug: slug, fd, schema: bulkSchema,
    run: (c, d) => bulkUpdateWorkOrders(c, ids, d),
    done: (r) => {
      const parts = [r.changed ? `Updated ${r.changed} work order${r.changed === 1 ? "" : "s"}.` : "Nothing was changed."];
      if (r.unchanged) parts.push(`${r.unchanged} already ${r.unchanged === 1 ? "was" : "were"} that way.`);
      if (r.failed.length) parts.push(`${r.failed.length} couldn't be changed:\n${r.failed.slice(0, 8).map((f) => `• ${f.number ? `#${f.number}` : "One request"}: ${f.reason}`).join("\n")}${r.failed.length > 8 ? `\n…and ${r.failed.length - 8} more` : ""}`);
      return { message: parts.join(" "), data: { changed: r.changed, failed: r.failed.length } };
    },
  });
}

/* ───── push notifications on this device ───── */

// a person's own devices: allowed in read-only mode (it changes no shared data); consent is recorded by the service
export async function subscribePushAction(slug: string, subscription: unknown): Promise<ActionState> {
  const { subscribePush, subscriptionSchema } = await import("@/server/push/service");
  const parsed = subscriptionSchema.safeParse(subscription);
  if (!parsed.success) return { error: "This browser gave an unexpected subscription." };
  return runOrgForm({ orgSlug: slug, fd: new FormData(), schema: none, allowReadOnly: true,
    run: (c) => subscribePush(c, parsed.data, c.meta?.userAgent ?? null), done: () => ({ message: "Push notifications are on for this device." }) });
}

export async function unsubscribePushAction(slug: string, endpoint: string): Promise<ActionState> {
  const { unsubscribePush } = await import("@/server/push/service");
  if (typeof endpoint !== "string" || endpoint.length > 800) return { error: "Invalid device." };
  return runOrgForm({ orgSlug: slug, fd: new FormData(), schema: none, allowReadOnly: true,
    run: (c) => unsubscribePush(c, endpoint), done: () => ({ message: "Push notifications are off for that device." }) });
}
