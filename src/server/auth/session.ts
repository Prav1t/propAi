import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_TTL_MS, validateSessionToken, type ValidSession } from "./service";

const secure = process.env.NODE_ENV === "production";
export const SESSION_COOKIE = secure ? "__Host-session" : "session";
export const MFA_COOKIE = secure ? "__Host-mfa" : "mfa";

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function setMfaCookie(token: string) {
  (await cookies()).set(MFA_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 300 });
}

// memoized per request
export const getSession = cache(async (): Promise<ValidSession | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return validateSessionToken(token);
});

export async function requireSession(): Promise<ValidSession> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}
