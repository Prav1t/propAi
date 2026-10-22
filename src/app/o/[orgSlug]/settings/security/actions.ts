"use server";
import { z } from "zod";
import { runOrgForm } from "@/server/form-action";
import { requireRecentAuth } from "@/server/reauth";
import { addDomain, connectionSchema, policySchema, removeDomain, saveConnection, setConnectionStatus, setSecurityPolicy, verifyDomain } from "@/server/sso/service";
import type { ActionState } from "@/server/actions";
import { ValidationError } from "@/server/modules/context";

const page = (slug: string) => `/o/${slug}/settings/security`;
const none = z.object({});

// every change here needs a recent sign-in (they decide how everyone else signs in)
export async function savePolicyAction(slug: string, _: ActionState, fd: FormData) {
  const s = await requireRecentAuth(page(slug));
  return runOrgForm({ orgSlug: slug, fd, schema: policySchema, allowReadOnly: true, run: (ctx, d) => setSecurityPolicy(ctx, d, { mfaEnabled: s.user.mfaEnabled }), done: () => ({ message: "Sign-in requirements saved. They apply right away.", revalidate: [page(slug)] }) });
}

export async function saveConnectionAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: connectionSchema, allowReadOnly: true, recentAuth: true, run: (ctx, d) => saveConnection(ctx, d), done: () => ({ message: "Single sign-on saved. The provider answered its discovery document.", revalidate: [page(slug)] }) });
}

export async function setConnectionStatusAction(slug: string, status: "active" | "disabled", _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, allowReadOnly: true, recentAuth: true, run: (ctx) => setConnectionStatus(ctx, status), done: () => ({ message: status === "active" ? "Single sign-on is on." : "Single sign-on is off; staff sign in with passwords.", revalidate: [page(slug)] }) });
}

export async function addDomainAction(slug: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: z.object({ domain: z.string().max(253) }), allowReadOnly: true, recentAuth: true, run: (ctx, d) => addDomain(ctx, d.domain), done: (d) => ({ message: `Added ${d.domain}. Publish the TXT record below, then check it.`, revalidate: [page(slug)] }) });
}

export async function verifyDomainAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, allowReadOnly: true, recentAuth: true, run: async (ctx) => {
    const r = await verifyDomain(ctx, id);
    if (!r.verified) throw new ValidationError(r.message); // the check (and its result) is saved either way
    return r;
  }, done: (r) => ({ message: r.message, revalidate: [page(slug)] }) });
}

export async function removeDomainAction(slug: string, id: string, _: ActionState, fd: FormData) {
  return runOrgForm({ orgSlug: slug, fd, schema: none, allowReadOnly: true, recentAuth: true, run: (ctx) => removeDomain(ctx, id), done: () => ({ message: "Domain removed.", revalidate: [page(slug)] }) });
}
