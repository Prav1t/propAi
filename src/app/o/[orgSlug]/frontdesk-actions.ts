"use server";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import { getOrgContext } from "@/server/org-context";
import { toActionError, type ActionState } from "@/server/actions";
import { env } from "@/server/env";
import {
  cancelVisitor, checkInSchema, checkInVisitor, checkOutVisitor, denySchema, denyVisitor, regeneratePass, registerVisitor, resolvePass, visitorSchema,
} from "@/server/modules/visitors/service";
import {
  addVehicle, bulkSpaceSchema, createSpace, createSpaces, issuePermit, lookupPlate, permitSchema, removeVehicle, reportViolation, resolveSchema, resolveViolation,
  reviewSchema, reviewViolation, revokePermit, revokeSchema, spaceSchema, updateSpace, vehicleSchema, violationSchema, warnSchema, warnViolation,
} from "@/server/modules/parking/service";
import { acknowledgeHandoff, cancelShift, clockIn, clockOut, createHandoff, createShifts, handoffSchema, shiftSchema } from "@/server/modules/shifts/service";
import { assetSchema, createAsset, createPmSchedule, generatePmNow, pmSchema, setAssetStatus, setPmActive, statusSchema, updateAsset } from "@/server/modules/assets/service";

const none = z.object({}).passthrough();
const base = (s: string) => `/o/${s}`;
const allFiles = (fd: FormData, name = "files") => fd.getAll(name).filter((f): f is File => f instanceof File && f.size > 0);

// share card for a new guest pass: the link and a QR of it (the token is never stored in plain text)
async function passCard(visitorId: string, token: string) {
  const url = `${env().APP_URL}/pass/${token}`;
  return { visitorId, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220, errorCorrectionLevel: "M" }) };
}

/* ───── visitors ───── */

export async function registerVisitorAction(slug: string, _: ActionState, fd: FormData) {
  let card: Awaited<ReturnType<typeof passCard>> | null = null;
  return runOrgForm({
    orgSlug: slug, fd, schema: visitorSchema,
    run: async (c, d) => {
      const r = await registerVisitor(c, d);
      if (r.passToken) card = await passCard(r.visitor.id, r.passToken);
      return r;
    },
    done: (r) => (r.visitor.status === "checked_in"
      ? { redirectTo: `${base(slug)}/visitors/${r.visitor.id}?arrived=1` }
      : { message: `${r.visitor.name} is on the list. Share the pass below.`, data: card }),
  });
}
export async function regeneratePassAction(slug: string, id: string, _: ActionState, fd: FormData) {
  let card: Awaited<ReturnType<typeof passCard>> | null = null;
  return runOrgForm({
    orgSlug: slug, fd, schema: none,
    run: async (c) => { const r = await regeneratePass(c, id); card = await passCard(r.visitorId, r.passToken); return r; },
    done: () => ({ message: "New pass ready. The old link no longer works.", data: card }),
  });
}
export async function checkInVisitorAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: checkInSchema, run: (c, d) => checkInVisitor(c, id, d), done: (r) => ({ message: r.parking ? `Checked in. Visitor parking: space ${r.parking.spaceCode}.` : "Checked in. The host has been notified." }) });
}
export async function checkOutVisitorAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => checkOutVisitor(c, id), done: () => ({ message: "Checked out." }) });
}
export async function denyVisitorAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: denySchema, run: (c, d) => denyVisitor(c, id, d), done: () => ({ message: "Recorded. The host has been told." }) });
}
export async function cancelVisitorAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => cancelVisitor(c, id), done: () => ({ message: "Visit cancelled. The pass no longer works." }) });
}
// front desk scanner / paste box → the visit
export async function scanPassAction(slug: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const code = String(fd.get("code") ?? "");
  let id: string;
  try {
    const { ctx } = await getOrgContext(slug);
    id = await resolvePass(ctx, code);
  } catch (e) {
    return toActionError(e, {});
  }
  redirect(`${base(slug)}/visitors/${id}?scanned=1`);
}

/* ───── parking ───── */

export async function createSpaceAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: spaceSchema, run: createSpace, done: (s) => ({ message: `Space ${s.code} added.` }) });
}
export async function updateSpaceAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: spaceSchema, run: (c, d) => updateSpace(c, id, d), done: (s) => ({ message: `Space ${s.code} saved.` }) });
}
export async function bulkSpacesAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: bulkSpaceSchema, run: createSpaces, done: (r) => ({ message: `Added ${r.created} space${r.created === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} already existed)` : ""}.` }) });
}
export async function addVehicleAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: vehicleSchema, run: addVehicle, done: (v) => ({ message: `${v.plate} registered.` }) });
}
export async function removeVehicleAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => removeVehicle(c, id), done: (r) => ({ message: r.revoked ? `Vehicle removed and ${r.revoked} permit${r.revoked === 1 ? "" : "s"} revoked.` : "Vehicle removed." }) });
}
export async function issuePermitAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: permitSchema, run: issuePermit, done: (r) => ({ message: `Permit #${r.number} issued for ${r.plate}.` }) });
}
export async function revokePermitAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: revokeSchema, run: (c, d) => revokePermit(c, id, d), done: () => ({ message: "Permit revoked." }) });
}
export async function reportViolationAction(slug: string, _: ActionState, fd: FormData) {
  const photos = allFiles(fd);
  return runOrgForm({ orgSlug: slug, fd, schema: violationSchema, run: (c, d) => reportViolation(c, d, photos), done: (v) => ({ redirectTo: `${base(slug)}/parking/violations/${v.id}` }) });
}
export async function reviewViolationAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: reviewSchema, run: (c, d) => reviewViolation(c, id, d), done: (v) => ({ message: v.status === "confirmed" ? "Confirmed. You can now issue a notice or resolve it." : "Dismissed." }) });
}
export async function warnViolationAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: warnSchema, run: (c, d) => warnViolation(c, id, d), done: (r) => ({ message: r.notified ? "Notice issued. The unit's residents have been notified." : "Notice recorded. No registered resident matches this plate, so nobody was notified." }) });
}
export async function resolveViolationAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: resolveSchema, run: (c, d) => resolveViolation(c, id, d), done: () => ({ message: "Resolved." }) });
}
export async function lookupPlateAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: z.object({ plate: z.string().min(1, "Enter a plate.") }), run: (c, d) => lookupPlate(c, d.plate), done: (r) => ({ message: r.plate, data: r, revalidate: [] }) });
}

/* ───── shifts ───── */

export async function createShiftsAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: shiftSchema, run: createShifts, done: (r) => ({ message: `Scheduled ${r.count} shift${r.count === 1 ? "" : "s"} for ${r.name}.` }) });
}
export async function cancelShiftAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => cancelShift(c, id), done: () => ({ message: "Shift cancelled." }) });
}
export async function clockInAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => clockIn(c, id), done: () => ({ message: "Clocked in." }) });
}
export async function clockOutAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => clockOut(c, id), done: () => ({ message: "Clocked out." }) });
}
export async function createHandoffAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: handoffSchema, run: createHandoff, done: () => ({ message: "Handoff saved. The next shift has been notified." }) });
}
export async function ackHandoffAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => acknowledgeHandoff(c, id), done: () => ({ message: "Acknowledged." }) });
}

/* ───── assets ───── */

export async function createAssetAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: assetSchema, run: createAsset, done: (a) => ({ redirectTo: `${base(slug)}/assets/${a.id}` }) });
}
export async function updateAssetAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: assetSchema, run: (c, d) => updateAsset(c, id, d), done: () => ({ message: "Asset saved." }) });
}
export async function assetStatusAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: statusSchema, run: (c, d) => setAssetStatus(c, id, d), done: () => ({ message: "Status updated." }) });
}
export async function createPmAction(slug: string, assetId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: pmSchema, run: (c, d) => createPmSchedule(c, assetId, d), done: (s) => ({ message: `Schedule “${s.title}” added.` }) });
}
export async function pmActiveAction(slug: string, id: string, active: boolean, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => setPmActive(c, id, active), done: () => ({ message: active ? "Schedule resumed." : "Schedule paused." }) });
}
export async function generatePmAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => generatePmNow(c, id), done: (wo) => ({ redirectTo: `${base(slug)}/maintenance/${wo.id}` }) });
}
