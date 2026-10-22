import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { requireSession } from "./auth/session";
import { orgPrincipalForSession } from "./org-session";
import { requestMeta } from "./request-meta";
import type { TenantCtx } from "./modules/context";
import { safeNext } from "@/lib/safe-next";

// resolves session + membership for /o/[orgSlug] routes; 404 when not a member (don't leak existence).
// The organization's security policy is enforced here: SSO or two-step verification when it requires them.
export const getOrgContext = cache(async (orgSlug: string) => {
  const session = await requireSession();
  const { principal, decision } = await orgPrincipalForSession(session, orgSlug);
  if (!principal) notFound();
  if (!decision.ok) {
    const here = safeNext((await headers()).get("x-pathname")) ?? `/o/${orgSlug}/dashboard`;
    if (decision.reason === "sso_required") redirect(`/sso/org/${orgSlug}?next=${encodeURIComponent(here)}`);
    if (decision.reason === "mfa_setup_required") redirect(`/account/security?required=${encodeURIComponent(orgSlug)}`);
    redirect(`/session/renew?next=${encodeURIComponent(here)}`);
  }
  const ctx: TenantCtx = { principal, meta: await requestMeta() };
  return { session, principal, ctx };
});

// permission and missing-record errors both render as 404 on pages (no existence leaks)
export async function orNotFound<T>(p: Promise<T>): Promise<T> {
  const { ForbiddenError, NotFoundError } = await import("./authz/authorize");
  try {
    return await p;
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof NotFoundError) notFound();
    throw e;
  }
}

export type SearchParams = Record<string, string | string[] | undefined>;
export const sp = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);
