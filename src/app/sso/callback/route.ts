import { redirect } from "next/navigation";
import { getSession, setSessionCookie } from "@/server/auth/session";
import { completeSsoLogin, SsoError } from "@/server/sso/service";
import { requestMeta } from "@/server/request-meta";
import { env } from "@/server/env";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";

// the identity provider sends the browser back here with a code (registered redirect URI: APP_URL/sso/callback)
export async function GET(req: Request) {
  // rebuilt on APP_URL: it must match the registered redirect URI exactly, whatever host the proxy forwarded
  const url = new URL(`${env().APP_URL}/sso/callback${new URL(req.url).search}`);
  const session = await getSession();
  let target: string;
  try {
    const out = await completeSsoLogin(url, await requestMeta(), session ? { sessionId: session.sessionId, userId: session.user.id } : null);
    if (out.kind === "session") {
      await setSessionCookie(out.token);
      target = out.next ?? `/o/${out.orgSlug}/dashboard`;
    } else {
      target = out.next ?? "/account/security";
    }
  } catch (e) {
    if (!(e instanceof SsoError)) log.error("sso.callback_failed", { err: e });
    redirect(`/login?sso_error=${e instanceof SsoError ? e.code : "unverified_response"}`);
  }
  redirect(target);
}
