import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/session";
import { findConnection, startSsoLogin } from "@/server/sso/service";
import { safeNext } from "@/lib/safe-next";

export const dynamic = "force-dynamic";

// "confirm it's you" for people who sign in through SSO: a fresh sign-in at the identity provider (prompt=login)
export async function GET(req: Request) {
  const s = await requireSession();
  const next = safeNext(new URL(req.url).searchParams.get("next")) ?? "/orgs";
  const c = s.ssoConnectionId ? await findConnection({ connectionId: s.ssoConnectionId }) : null;
  if (!c) redirect(`/account/confirm?next=${encodeURIComponent(next)}`);
  redirect(await startSsoLogin(c, { next, loginHint: s.user.email, reauthUserId: s.user.id }));
}
