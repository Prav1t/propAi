import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireSession } from "./auth/session";
import { isRecentAuth, type ValidSession } from "./auth/service";
import { safeNext } from "@/lib/safe-next";

// Sensitive changes (API keys, webhook secrets, integrations, SSO and security policy, privacy requests, member roles,
// billing, platform administration) need a sign-in or confirmation from the last few minutes, so a stolen or
// unattended session can't make them (finding F-09). Otherwise the person is sent to confirm, then back here.
export async function requireRecentAuth(fallbackPath: string): Promise<ValidSession> {
  const s = await requireSession();
  if (isRecentAuth(s)) return s;
  const h = await headers();
  let back = fallbackPath;
  const ref = h.get("referer");
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.host === h.get("host")) back = u.pathname + u.search;
    } catch {
      /* keep the fallback */
    }
  }
  redirect(`/account/confirm?next=${encodeURIComponent(safeNext(back) ?? fallbackPath)}`);
}
