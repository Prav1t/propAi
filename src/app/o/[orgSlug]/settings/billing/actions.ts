"use server";
import { z } from "zod";
import { redirect } from "next/navigation";
import { runOrgForm } from "@/server/form-action";
import { billingPortalUrl, changePlan, completeMockCheckout, setCancelAtPeriodEnd } from "@/server/billing/service";
import { getOrgContext } from "@/server/org-context";
import { toActionError, type ActionState } from "@/server/actions";
import { BILLING_INTERVALS, PLAN_KEYS } from "@/config/plans";

// billing forms stay usable when the organization is read-only: that's how it gets out of read-only
const planSchema = z.object({ planKey: z.enum(PLAN_KEYS), interval: z.enum(BILLING_INTERVALS) });
const base = (slug: string) => `/o/${slug}/settings/billing`;

export async function changePlanAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({
    orgSlug: slug, fd, schema: planSchema, allowReadOnly: true, recentAuth: true, run: (ctx, d) => changePlan(ctx, d),
    done: (r) => ({ redirectTo: r.redirectTo, message: r.message, revalidate: [`/o/${slug}`] }),
  });
}

export async function cancelSubscriptionAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: z.object({}), allowReadOnly: true, recentAuth: true, run: (ctx) => setCancelAtPeriodEnd(ctx, true), done: (r) => ({ message: r.message, revalidate: [`/o/${slug}`] }) });
}

export async function resumeSubscriptionAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: z.object({}), allowReadOnly: true, run: (ctx) => setCancelAtPeriodEnd(ctx, false), done: (r) => ({ message: r.message, revalidate: [`/o/${slug}`] }) });
}

export async function completeMockCheckoutAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({
    // (the field isn't called "token": form echo drops anything named like a secret)
    orgSlug: slug, fd, schema: z.object({ session: z.string().min(10).max(2000) }), allowReadOnly: true, run: (ctx, d) => completeMockCheckout(ctx, d.session),
    done: () => ({ redirectTo: `${base(slug)}?checkout=success`, revalidate: [`/o/${slug}`] }),
  });
}

export async function billingPortalAction(slug: string): Promise<ActionState> {
  let url: string;
  try {
    const { ctx } = await getOrgContext(slug);
    url = await billingPortalUrl(ctx);
  } catch (e) {
    return toActionError(e);
  }
  redirect(url);
}
