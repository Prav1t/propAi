"use server";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import { getOrgContext } from "@/server/org-context";
import { candidateEvents, deleteRule, dryRun, saveRule, setRuleEnabled } from "@/server/automation/service";
import { decideRun } from "@/server/automation/engine";
import { toActionError, type ActionState } from "@/server/actions";
import { ValidationError } from "@/server/modules/context";
import { TRIGGER_TYPES, type TriggerType } from "@/lib/automation";

const base = (slug: string) => `/o/${slug}/automations`;
const none = z.object({});

const ruleForm = z.object({ rule: z.string().min(2).max(100_000), enable: z.string().optional() });
const parseRule = (json: string) => {
  try { return JSON.parse(json) as unknown; } catch { throw new ValidationError("The rule couldn't be read. Reload the page and try again."); }
};

export async function saveRuleAction(slug: string, id: string | null, _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: ruleForm, run: (c, d) => saveRule(c, id, parseRule(d.rule), d.enable === "on"),
    done: (wf) => ({ redirectTo: `${base(slug)}/${wf.id}?saved=1` }),
  });
}

export async function setRuleEnabledAction(slug: string, id: string, enabled: boolean, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => setRuleEnabled(c, id, enabled), done: () => ({ message: enabled ? "Turned on." : "Turned off.", revalidate: [base(slug)] }) });
}

export async function deleteRuleAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, run: (c) => deleteRule(c, id), done: () => ({ redirectTo: `${base(slug)}?deleted=1` }) });
}

const decision = z.object({ note: z.string().trim().max(500).optional() });
export async function decideRunAction(slug: string, runId: string, choice: "approve" | "decline", _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: decision, run: (c, d) => decideRun(c, runId, choice, d.note || null),
    // the approval panel disappears once decided, so the confirmation is rendered by the run page
    done: (r) => ({ revalidate: [base(slug)], redirectTo: `${base(slug)}/runs/${runId}?decided=${choice === "decline" ? "declined" : r.status === "completed" ? "completed" : "approved"}` }),
  });
}

/* called from the builder (not forms) */

export async function candidateEventsAction(slug: string, trigger: string, propertyId: string | null) {
  try {
    if (!(TRIGGER_TYPES as string[]).includes(trigger)) return { ok: false as const, error: "Unknown trigger." };
    const { ctx } = await getOrgContext(slug);
    return { ok: true as const, events: (await candidateEvents(ctx, trigger as TriggerType, propertyId)).map((e) => ({ id: e.id, label: e.label, at: e.at.toISOString() })) };
  } catch (e) {
    return { ok: false as const, error: toActionError(e).error ?? "Couldn't load events." };
  }
}

export async function dryRunAction(slug: string, ruleJson: string, eventId: string | null) {
  try {
    const { ctx } = await getOrgContext(slug);
    return { ok: true as const, result: await dryRun(ctx, parseRule(ruleJson), eventId) };
  } catch (e) {
    return { ok: false as const, error: toActionError(e).error ?? "The test couldn't run." };
  }
}
