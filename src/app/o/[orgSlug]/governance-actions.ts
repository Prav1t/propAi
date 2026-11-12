"use server";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import type { ActionState } from "@/server/actions";
import { zonedToUtc } from "@/lib/time";
import type { TenantCtx } from "@/server/modules/context";
import { ValidationError } from "@/server/modules/context";
import {
  actionItemSchema, addActionItem, addAgendaItem, addMotion, agendaItemSchema, approveMinutes, castVote, createMeeting, decideMotion, decideSchema,
  meetingSchema, meetingStatusSchema, minutesSchema, motionSchema, saveMinutes, setMeetingStatus, voteSchema,
} from "@/server/modules/meetings/service";
import {
  changeTerms, createLease, endLease, endSchema, giveNotice, leaseSchema, noticeSchema, paymentSchema, recordPayment, termsSchema, withdrawNotice,
} from "@/server/modules/leases/service";

// Server actions for meetings (governance) and leases. Every one resolves the person from the session, checks their
// permission for that property in the service, and writes an audit entry.
const tz = (c: TenantCtx) => c.principal.orgTimezone ?? "UTC";
const none = z.object({});

/* ── meetings ── */
export async function createMeetingAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: meetingSchema, run: (c, d) => createMeeting(c, d, zonedToUtc(d.scheduledAt, tz(c))), done: (m) => ({ redirectTo: `/o/${slug}/meetings/${m.id}` }) });
}
export async function addAgendaItemAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: agendaItemSchema, run: (c, d) => addAgendaItem(c, id, d), done: () => ({ message: "Added to the agenda." }) });
}
export async function saveMinutesAction(slug: string, id: string, _: ActionState, fd: FormData) {
  // per-item minutes arrive as item_<agenda item id>
  const items: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (k.startsWith("item_") && typeof v === "string") items[k.slice(5)] = v;
  return runOrgForm({ orgSlug: slug, fd, schema: minutesSchema, run: (c, d) => saveMinutes(c, id, d, items), done: () => ({ message: "Minutes saved." }) });
}
export async function setMeetingStatusAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: meetingStatusSchema, run: (c, d) => setMeetingStatus(c, id, d.status), done: () => ({ message: "Updated." }) });
}
export async function approveMinutesAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => approveMinutes(c, id), done: () => ({ message: "Minutes approved." }) });
}
export async function addMotionAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: motionSchema, run: (c, d) => addMotion(c, id, d), done: () => ({ message: "Motion added." }) });
}
export async function castVoteAction(slug: string, motionId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: voteSchema, run: (c, d) => castVote(c, motionId, d.choice), done: () => ({ message: "Your vote is recorded." }) });
}
export async function decideMotionAction(slug: string, motionId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: decideSchema, run: (c, d) => decideMotion(c, motionId, d), done: (m) => ({ message: `Motion ${m.number}: ${m.status}.` }) });
}
export async function addActionItemAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: actionItemSchema,
    run: (c, d) => {
      const due = d.dueAt ? zonedToUtc(d.dueAt, tz(c)) : null;
      if (due && Number.isNaN(due.getTime())) throw new ValidationError("Choose a valid date.", "dueAt");
      return addActionItem(c, id, d, due);
    },
    done: () => ({ message: "Action item created as a task." }),
  });
}

/* ── leases ── */
export async function createLeaseAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: leaseSchema, run: (c, d) => createLease(c, d), done: (l) => ({ redirectTo: `/o/${slug}/leases/${l.id}` }) });
}
export async function changeTermsAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: termsSchema, run: (c, d) => changeTerms(c, id, d), done: () => ({ message: "Terms updated. Months already charged keep their amount." }) });
}
export async function giveNoticeAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: noticeSchema, run: (c, d) => giveNotice(c, id, d.moveOutOn), done: () => ({ message: "Notice recorded." }) });
}
export async function withdrawNoticeAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => withdrawNotice(c, id), done: () => ({ message: "Notice withdrawn." }) });
}
export async function endLeaseAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: endSchema, run: (c, d) => endLease(c, id, d.endedOn), done: () => ({ message: "Lease ended." }) });
}
export async function recordPaymentAction(slug: string, chargeId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: paymentSchema, run: (c, d) => recordPayment(c, chargeId, d), done: () => ({ message: "Payment recorded." }) });
}
