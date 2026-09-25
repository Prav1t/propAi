import { NextResponse, type NextRequest } from "next/server";

const secure = process.env.NODE_ENV === "production";
const SESSION_COOKIE = secure ? "__Host-session" : "session";
const PROTECTED = ["/o/", "/orgs", "/onboarding", "/account", "/admin"];
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

// request ids, optimistic auth redirect, sliding session cookie. Real auth happens server-side.
export function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);

  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (!token && PROTECTED.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    const res = NextResponse.redirect(url);
    res.headers.set("x-request-id", requestId);
    return res;
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  // keep the browser cookie alive while the server-side session slides
  if (token && request.method === "GET") {
    res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg|robots.txt).*)"],
};
