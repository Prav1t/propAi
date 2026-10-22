import { isIP } from "node:net";

// How the client address is found (Iteration 11, finding F-01).
// Each reverse proxy appends the address it received the request from to X-Forwarded-For, so with N trusted
// proxies in front of the app the client is the N-th entry from the right. Everything to the left of it was
// written by the client and is never trusted. Without a proxy (hops = 0) Next.js fills X-Forwarded-For from
// the socket only when the client didn't send one, so the address can be forged: production deployments set
// TRUSTED_PROXY_HOPS (or CLIENT_IP_HEADER for a proxy that sets its own header, e.g. cf-connecting-ip).
export type ClientIpConfig = { hops: number; header: string | null };

export function clientIpConfig(env: Record<string, string | undefined> = process.env): ClientIpConfig {
  const raw = env.TRUSTED_PROXY_HOPS;
  let hops = raw !== undefined && raw !== "" ? Number(raw) : env.TRUST_PROXY === "true" ? 1 : 0; // TRUST_PROXY kept for old .env files
  if (!Number.isInteger(hops) || hops < 0) hops = 0;
  const header = env.CLIENT_IP_HEADER?.trim().toLowerCase() || null;
  return { hops: Math.min(hops, 10), header };
}

export function normalizeIp(v: string | null | undefined): string | null {
  if (!v) return null;
  let s = v.trim();
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]")); // [2001:db8::1]:443
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":")); // 1.2.3.4:5678
  if (s.toLowerCase().startsWith("::ffff:") && isIP(s.slice(7)) === 4) s = s.slice(7); // IPv4-mapped IPv6
  return isIP(s) ? s.toLowerCase() : null;
}

type HeaderBag = { get(name: string): string | null };

export function clientIpFrom(h: HeaderBag, cfg: ClientIpConfig): string | null {
  if (cfg.header) return normalizeIp(h.get(cfg.header)?.split(",")[0]);
  const chain = (h.get("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!chain.length) return null;
  // fewer entries than trusted hops: the request skipped a proxy; the first entry is the closest thing to the peer
  const i = chain.length >= Math.max(cfg.hops, 1) ? chain.length - Math.max(cfg.hops, 1) : 0;
  return normalizeIp(chain[i]);
}

// the public host for same-origin checks: X-Forwarded-Host only counts when a trusted proxy set it
export function forwardedHost(h: HeaderBag, cfg: ClientIpConfig): string | null {
  if (cfg.hops < 1 && !cfg.header) return null;
  return h.get("x-forwarded-host")?.split(",")[0]?.trim() || null;
}
