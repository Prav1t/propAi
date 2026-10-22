"use server";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import { erasePerson, eraseSchema, exportPerson, placeLegalHold, releaseLegalHold, retentionSchema, saveRetention } from "@/server/privacy/service";
import { ValidationError } from "@/server/modules/context";
import type { ActionState } from "@/server/actions";

const page = (slug: string) => `/o/${slug}/settings/privacy`;
const none = z.object({});

// personal data leaves the system or is destroyed here: a recent sign-in, every time
export async function exportPersonAction(slug: string, residentId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, allowReadOnly: true, recentAuth: true, run: (ctx) => exportPerson(ctx, residentId),
    done: () => ({ message: "Export ready: download it from the requests below (available for 7 days).", revalidate: [page(slug)] }) });
}

export async function erasePersonAction(slug: string, residentId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: eraseSchema, recentAuth: true, run: async (ctx, d) => {
    if (d.confirm.trim() !== "ERASE") throw new ValidationError("Type ERASE to confirm.", "confirm");
    const r = await erasePerson(ctx, residentId, { reason: d.reason });
    if (r.status === "blocked") throw new ValidationError("This person is on legal hold, so nothing was erased. The attempt is recorded below.");
    return r;
  }, done: () => ({ message: "Erased. What was removed is listed under requests.", revalidate: [page(slug)] }) });
}

export async function placeHoldAction(slug: string, residentId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: z.object({ reason: z.string().max(500) }), allowReadOnly: true, recentAuth: true, run: (ctx, d) => placeLegalHold(ctx, residentId, d.reason),
    done: () => ({ message: "Legal hold placed: erasure and retention deletes are paused for this person.", revalidate: [page(slug)] }) });
}

export async function releaseHoldAction(slug: string, holdId: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, allowReadOnly: true, recentAuth: true, run: (ctx) => releaseLegalHold(ctx, holdId), done: () => ({ message: "Hold released.", revalidate: [page(slug)] }) });
}

export async function saveRetentionAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: retentionSchema, allowReadOnly: true, recentAuth: true, run: (ctx, d) => saveRetention(ctx, d),
    done: () => ({ message: "Retention saved. The nightly job applies it.", revalidate: [page(slug)] }) });
}
