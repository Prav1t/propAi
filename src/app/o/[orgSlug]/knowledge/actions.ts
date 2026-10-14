"use server";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import { createEntry, entrySchema, reindex, setEntryStatus, updateEntry } from "@/server/kb/knowledge";
import type { ActionState } from "@/server/actions";

const none = z.object({});
const base = (slug: string) => `/o/${slug}/knowledge`;

export async function createEntryAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: entrySchema, run: createEntry, done: (e) => ({ redirectTo: `${base(slug)}/${e.id}?created=1` }) });
}

export async function updateEntryAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: entrySchema, run: (c, d) => updateEntry(c, id, d), done: () => ({ redirectTo: `${base(slug)}/${id}?saved=1` }) });
}

export async function setEntryStatusAction(slug: string, id: string, status: "active" | "disabled", _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => setEntryStatus(c, id, status), done: () => ({ message: status === "disabled" ? "Disabled — the assistant no longer uses it." : "Enabled.", revalidate: [base(slug)] }) });
}

export async function reindexAction(slug: string, target: { entryId?: string; documentId?: string; all?: boolean }, _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: none, run: (c) => reindex(c, target),
    done: (n) => ({ message: `${n} source${n === 1 ? "" : "s"} queued for indexing.`, revalidate: [base(slug), ...(target.documentId ? [`/o/${slug}/documents/${target.documentId}`] : [])] }),
  });
}
