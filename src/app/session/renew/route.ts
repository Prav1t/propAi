import { redirect } from "next/navigation";
import { clearSessionCookie, getSession } from "@/server/auth/session";
import { revokeSession } from "@/server/auth/service";
import { safeNext } from "@/lib/safe-next";

export const dynamic = "force-dynamic";

// the organization now requires two-step verification and this session was opened without it: sign in again
export async function GET(req: Request) {
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  const s = await getSession();
  if (s) {
    await revokeSession(s.sessionId);
    await clearSessionCookie();
  }
  redirect(`/login?reason=mfa${next ? `&next=${encodeURIComponent(next)}` : ""}`);
}
