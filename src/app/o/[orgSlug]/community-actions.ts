"use server";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import type { ActionState } from "@/server/actions";
import {
  addBlackout, amenitySchema, blackoutSchema, bookingSchema, cancelBooking, cancelSchema, createAmenity, createBooking, damageSchema, decideBooking,
  decisionSchema, deleteBlackout, paymentSchema, reportDamage, updateAmenity, updateBookingPayment,
} from "@/server/modules/amenities/service";
import { logPackage, packageSchema, releasePackages, releaseSchema, returnPackage, returnSchema } from "@/server/modules/packages/service";
import { announcementSchema, archiveAnnouncement, createAnnouncement, updateAnnouncement } from "@/server/modules/announcements/service";
import {
  createMessageTemplate, deleteMessageTemplate, newThreadSchema, postMessage, postSchema, startThread, templateSchema, threadUpdateSchema, updateThread,
} from "@/server/modules/messaging/service";
import { addDocumentVersion, createDocument, documentMetaSchema, documentSchema, setDocumentArchived, updateDocument } from "@/server/modules/documents/service";

const none = z.object({}).passthrough();
const base = (s: string) => `/o/${s}`;
const firstFile = (fd: FormData, name = "files") => fd.getAll(name).find((f): f is File => f instanceof File && f.size > 0) ?? null;
const allFiles = (fd: FormData, name = "files") => fd.getAll(name).filter((f): f is File => f instanceof File && f.size > 0);
const strings = (fd: FormData, name: string) => fd.getAll(name).filter((v): v is string => typeof v === "string" && !!v);

/* ───── amenities & bookings ───── */

export async function createAmenityAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: amenitySchema, run: createAmenity, done: (a) => ({ redirectTo: `${base(slug)}/amenities/${a.id}` }) });
}
export async function updateAmenityAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: amenitySchema, run: (c, d) => updateAmenity(c, id, d), done: () => ({ message: "Amenity saved." }) });
}
export async function addBlackoutAction(slug: string, amenityId: string, _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: blackoutSchema, run: (c, d) => addBlackout(c, amenityId, d),
    done: (r) => ({ message: r.affected ? `Closure added. ${r.affected} existing booking${r.affected === 1 ? " overlaps" : "s overlap"} it — review and cancel ${r.affected === 1 ? "it" : "them"} if needed.` : "Closure added." }),
  });
}
export async function deleteBlackoutAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteBlackout(c, id), done: () => ({ message: "Closure removed." }) });
}
export async function createBookingAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: bookingSchema, run: createBooking, done: (b) => ({ redirectTo: `${base(slug)}/amenities/bookings/${b.id}?created=1` }) });
}
export async function decideBookingAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: decisionSchema, run: (c, d) => decideBooking(c, id, d), done: (b) => ({ message: b.status === "approved" ? "Booking approved." : "Booking declined." }) });
}
export async function cancelBookingAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: cancelSchema, run: (c, d) => cancelBooking(c, id, d), done: () => ({ message: "Booking cancelled." }) });
}
export async function bookingPaymentAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: paymentSchema, run: (c, d) => updateBookingPayment(c, id, d), done: () => ({ message: "Payment status saved." }) });
}
export async function bookingDamageAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: damageSchema, run: (c, d) => reportDamage(c, id, d), done: (b) => ({ message: b.damageWorkOrderId ? "Damage recorded and a repair work order opened." : "Damage recorded." }) });
}

/* ───── packages ───── */

export async function logPackageAction(slug: string, _: ActionState, fd: FormData) {
  const photos = allFiles(fd);
  const r = await runOrgForm({
    orgSlug: slug, fd, schema: packageSchema, run: (c, d) => logPackage(c, d, photos),
    done: (x) => ({ message: `Logged for Unit ${x.unitNumber}, ${x.buildingName}.${x.occupantCount ? " The resident has been notified." : " Nobody is listed in this unit — follow up manually."}` }),
  });
  return r;
}
const idsSchema = releaseSchema.extend({ ids: z.string().optional() });
export async function releasePackagesAction(slug: string, _: ActionState, fd: FormData) {
  const ids = strings(fd, "ids");
  return runOrgForm({ orgSlug: slug, fd, schema: idsSchema, run: (c, d) => releasePackages(c, ids, d), done: (n) => ({ message: `${n} package${n === 1 ? "" : "s"} released.` }) });
}
export async function returnPackageAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: returnSchema, run: (c, d) => returnPackage(c, id, d), done: () => ({ message: "Marked as returned to sender." }) });
}

/* ───── announcements ───── */

export async function createAnnouncementAction(slug: string, _: ActionState, fd: FormData) {
  const buildingIds = strings(fd, "buildingIds");
  return runOrgForm({ orgSlug: slug, fd, schema: announcementSchema, run: (c, d) => createAnnouncement(c, d, buildingIds), done: (a) => ({ redirectTo: `${base(slug)}/announcements/${a.id}` }) });
}
export async function updateAnnouncementAction(slug: string, id: string, _: ActionState, fd: FormData) {
  const buildingIds = strings(fd, "buildingIds");
  return runOrgForm({ orgSlug: slug, fd, schema: announcementSchema, run: (c, d) => updateAnnouncement(c, id, d, buildingIds), done: (a) => ({ message: a.status === "published" ? "Saved." : a.status === "scheduled" ? "Scheduled." : "Draft saved." }) });
}
export async function archiveAnnouncementAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => archiveAnnouncement(c, id), done: () => ({ redirectTo: `${base(slug)}/announcements` }) });
}

/* ───── messages ───── */

export async function startThreadAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: newThreadSchema, run: startThread, done: (t) => ({ redirectTo: `${base(slug)}/messages/${t.id}` }) });
}
export async function postMessageAction(slug: string, threadId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: postSchema, run: (c, d) => postMessage(c, threadId, d), done: (m) => ({ message: m.internal ? "Internal note added." : "Sent." }) });
}
export async function updateThreadAction(slug: string, threadId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: threadUpdateSchema, run: (c, d) => updateThread(c, threadId, d), done: (t) => ({ message: t.status === "closed" ? "Conversation closed." : "Saved." }) });
}
export async function createTemplateAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: templateSchema, run: createMessageTemplate, done: (t) => ({ message: `Template “${t.name}” saved.` }) });
}
export async function deleteTemplateAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteMessageTemplate(c, id), done: () => ({ message: "Template deleted." }) });
}

/* ───── documents ───── */

export async function createDocumentAction(slug: string, _: ActionState, fd: FormData) {
  const file = firstFile(fd);
  return runOrgForm({ orgSlug: slug, fd, schema: documentSchema, run: (c, d) => createDocument(c, d, file), done: (d) => ({ redirectTo: `${base(slug)}/documents/${d.id}` }) });
}
const versionSchema = z.object({ notes: z.string().trim().max(500).optional() });
export async function addVersionAction(slug: string, id: string, _: ActionState, fd: FormData) {
  const file = firstFile(fd);
  return runOrgForm({ orgSlug: slug, fd, schema: versionSchema, run: (c, d) => addDocumentVersion(c, id, file, d.notes || null), done: (v) => ({ message: `Version ${v} is now current.` }) });
}
export async function updateDocumentAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: documentMetaSchema, run: (c, d) => updateDocument(c, id, d), done: () => ({ message: "Saved." }) });
}
export async function archiveDocumentAction(slug: string, id: string, archived: boolean, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => setDocumentArchived(c, id, archived), done: () => ({ message: archived ? "Archived." : "Restored." }) });
}
