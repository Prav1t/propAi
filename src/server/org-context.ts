import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { requireSession } from "./auth/session";
import { loadPrincipal } from "./modules/organizations/principal";
import { requestMeta } from "./request-meta";
import type { TenantCtx } from "./modules/context";

// resolves session + membership for /o/[orgSlug] routes; 404 when not a member (don't leak existence)
export const getOrgContext = cache(async (orgSlug: string) => {
  const session = await requireSession();
  const principal = await loadPrincipal(session.user.id, orgSlug);
  if (!principal) notFound();
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
