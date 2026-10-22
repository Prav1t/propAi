import "server-only";
import { clientIpConfig, forwardedHost } from "./client-ip";

// CSRF guard for JSON route handlers: browsers always send Origin on cross-site POSTs, so it must match this host
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") === "same-origin";
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const hosts = new Set<string>();
  const host = req.headers.get("host");
  if (host) hosts.add(host);
  const fwd = forwardedHost(req.headers, clientIpConfig());
  if (fwd) hosts.add(fwd);
  if (process.env.APP_URL) {
    try {
      hosts.add(new URL(process.env.APP_URL).host);
    } catch {
      /* ignore malformed APP_URL */
    }
  }
  return hosts.has(o.host);
}

export const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
