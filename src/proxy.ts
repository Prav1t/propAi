import { NextResponse, type NextRequest } from "next/server";

const secure = process.env.NODE_ENV === "production";
const isDev = process.env.NODE_ENV === "development";
const SESSION_COOKIE = secure ? "__Host-session" : "session";
const PROTECTED = ["/o/", "/orgs", "/onboarding", "/account", "/admin"];
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
// bearer-token and provider-signed endpoints: no cookies involved, so no cross-site request forgery to guard against
const NO_CSRF_CHECK = ["/api/v1/", "/api/billing/webhook/"];

// where presigned file downloads are served from (S3/R2/MinIO), so images and video can load from there
function fileOrigin(): string {
  if (process.env.FILE_STORAGE !== "s3") return "";
  const raw = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || (process.env.S3_BUCKET ? `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION ?? "us-east-1"}.amazonaws.com` : "");
  try {
    return raw ? ` ${new URL(raw).origin}` : "";
  } catch {
    return "";
  }
}

// strict CSP: scripts run only with this response's nonce (Next.js adds it to its own scripts); no inline scripts,
// no eval in production. Styles keep 'unsafe-inline' for React style attributes (finding F-05; see threat model).
export function contentSecurityPolicy(nonce: string): string {
  const files = fileOrigin();
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${files}`,
    `media-src 'self' blob:${files}`,
    "font-src 'self' data:",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "manifest-src 'self'",
    // only when the public origin is https: a production build served over http (Docker on localhost) would break
    ...(secure && (process.env.APP_URL ?? "").startsWith("https://") ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

// cookie-authenticated writes must come from our own pages. Next.js already checks Origin on server actions; this
// also covers route handlers and browsers that omit Origin, using Fetch Metadata (finding F-04).
function crossSiteWrite(request: NextRequest): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
  if (NO_CSRF_CHECK.some((p) => request.nextUrl.pathname.startsWith(p))) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true; // same-site subdomains don't count as ours
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    try {
      const o = new URL(origin).host;
      const hosts = [request.headers.get("host"), request.nextUrl.host];
      if (process.env.APP_URL) hosts.push(new URL(process.env.APP_URL).host);
      if (!hosts.includes(o)) return true;
    } catch {
      return true;
    }
  } else if (origin === "null") return true;
  return false;
}

// request ids, security headers, cross-site write guard, optimistic auth redirect, sliding session cookie.
// Real authentication and authorization happen server-side.
export function proxy(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce);

  if (crossSiteWrite(request)) {
    return new NextResponse("Cross-site request refused.", { status: 403, headers: { "x-request-id": requestId, "content-type": "text/plain" } });
  }

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

  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-nonce", nonce);
  headers.set("x-pathname", (pathname + search).slice(0, 1024)); // where to come back to after an SSO/MFA redirect
  headers.set("Content-Security-Policy", csp); // Next.js reads the nonce from here and adds it to its scripts
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  res.headers.set("Content-Security-Policy", csp);
  // keep the browser cookie alive while the server-side session slides
  if (token && request.method === "GET") {
    res.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg|robots.txt).*)"],
};
