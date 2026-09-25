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
