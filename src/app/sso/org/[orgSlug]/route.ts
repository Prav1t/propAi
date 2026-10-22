import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/session";
import { findConnection, startSsoLogin } from "@/server/sso/service";
import { safeNext } from "@/lib/safe-next";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";

// an organization that requires SSO sends its staff here; on to the organization's identity provider
export async function GET(req: Request, ctx: RouteContext<"/sso/org/[orgSlug]">) {
  const { orgSlug } = await ctx.params;
  const next = safeNext(new URL(req.url).searchParams.get("next")) ?? `/o/${orgSlug}/dashboard`;
  const c = await findConnection({ orgSlug });
  if (!c) redirect(`/login?sso_error=disabled`);
  const session = await getSession();
  let url: string;
  try {
    url = await startSsoLogin(c, { next, loginHint: session?.user.email ?? null });
  } catch (e) {
    log.warn("sso.start_failed", { orgSlug, err: (e as Error).message });
    redirect(`/login?sso_error=unverified_response`);
  }
  redirect(url);
}
