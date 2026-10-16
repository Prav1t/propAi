"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { getOrgContext } from "@/server/org-context";
import { archiveConversation } from "@/server/ai/store";
import { aiSettingsSchema, updateAiSettings } from "@/server/ai/usage";
import { approvePlan, getPlanView, rejectPlan, reviseStep, type PlanView } from "@/server/ai/approvals";
import { policySchema, setPolicy } from "@/server/ai/policies";
import { ConflictError, ValidationError } from "@/server/modules/context";
import { ForbiddenError, NotFoundError } from "@/server/authz/authorize";
import { log } from "@/server/log";
import { runOrgForm } from "@/server/form-action";
import { str, toActionError, type ActionState } from "@/server/actions";

export async function archiveConversationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const slug = str(fd, "orgSlug");
  try {
    const { ctx } = await getOrgContext(slug);
    await archiveConversation(ctx, str(fd, "conversationId"));
  } catch (e) {
    return toActionError(e, {});
  }
  revalidatePath(`/o/${slug}/assistant`);
  redirect(`/o/${slug}/assistant`);
}

export async function updateAiSettingsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const orgSlug = str(fd, "orgSlug");
  return runOrgForm({
    orgSlug, fd, schema: aiSettingsSchema,
    run: (ctx, data) => updateAiSettings(ctx, data),
    done: () => ({ message: "AI settings saved.", revalidate: [`/o/${orgSlug}/settings/ai`] }),
  });
}

/* ───────────── plans the assistant prepared ───────────── */

export type PlanActionResult = { ok: true; plan: PlanView } | { ok: false; error: string; field?: string; plan?: PlanView };

const planIds = z.object({ orgSlug: z.string().min(1).max(80), planId: z.string().uuid() });

async function planAction(raw: { orgSlug: string; planId: string }, run: (ctx: Awaited<ReturnType<typeof getOrgContext>>["ctx"], planId: string) => Promise<PlanView>): Promise<PlanActionResult> {
  const ids = planIds.safeParse(raw);
  if (!ids.success) return { ok: false, error: "That plan wasn't found." };
  const { ctx } = await getOrgContext(ids.data.orgSlug);
  try {
    const plan = await run(ctx, ids.data.planId);
    // deliver the notifications the approved changes emitted, after the response
    after(async () => {
      const { afterChange } = await import("@/server/after-change");
      await afterChange();
    });
    revalidatePath(`/o/${ids.data.orgSlug}/assistant`);
    return { ok: true, plan };
  } catch (e) {
    const current = await getPlanView(ctx, ids.data.planId).catch(() => undefined);
    if (e instanceof ValidationError) return { ok: false, error: e.message, field: e.field, plan: current };
    if (e instanceof ConflictError || e instanceof ForbiddenError) return { ok: false, error: e.message || "You can't do that.", plan: current };
    if (e instanceof NotFoundError) return { ok: false, error: "That plan wasn't found." };
    log.error("ai.plan_action_failed", { err: e });
    return { ok: false, error: "Something went wrong. Please try again.", plan: current };
  }
}

export async function approvePlanAction(input: { orgSlug: string; planId: string; acknowledge?: boolean; typed?: string }): Promise<PlanActionResult> {
  const extra = z.object({ acknowledge: z.boolean().optional(), typed: z.string().max(40).optional() }).safeParse({ acknowledge: input.acknowledge, typed: input.typed });
  if (!extra.success) return { ok: false, error: "Invalid confirmation." };
  return planAction(input, (ctx, id) => approvePlan(ctx, id, extra.data));
}

export async function rejectPlanAction(input: { orgSlug: string; planId: string }): Promise<PlanActionResult> {
  return planAction(input, (ctx, id) => rejectPlan(ctx, id));
}

export async function revisePlanStepAction(input: { orgSlug: string; planId: string; stepId: string; edits: Record<string, string> }): Promise<PlanActionResult> {
  const extra = z.object({ stepId: z.string().regex(/^s\d{1,2}$/), edits: z.record(z.string().max(40), z.string().max(10_000)) }).safeParse({ stepId: input.stepId, edits: input.edits });
  if (!extra.success) return { ok: false, error: "Invalid edit." };
  return planAction(input, (ctx, id) => reviseStep(ctx, id, extra.data.stepId, extra.data.edits));
}

/* ───────────── what the assistant may do on its own (admins) ───────────── */

export async function setAiPolicyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const orgSlug = str(fd, "orgSlug");
  return runOrgForm({
    orgSlug, fd, schema: policySchema,
    run: (ctx, data) => setPolicy(ctx, data),
    done: () => ({ message: "Saved.", revalidate: [`/o/${orgSlug}/settings/ai`] }),
  });
}
