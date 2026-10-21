import "server-only";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// Outbound requests to addresses customers choose (webhook endpoints, chat incoming-webhook URLs) — SSRF protection:
// • only http(s); https unless explicitly allowed
// • every resolved address must be public (no loopback, private, link-local/cloud-metadata, CGNAT, multicast, reserved)
// • the connection is pinned to the vetted address, so DNS can't change between the check and the connect (rebinding)
// • redirects are never followed; time and response size are capped

export class UnsafeTargetError extends Error {}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function v4Private(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

// expands an IPv6 address to 8 groups of 16 bits
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (!net.isIPv4(maybeV4)) return null;
    const n = v4ToInt(maybeV4);
    tail = [n >>> 16, n & 0xffff];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined ? (rest ? rest.split(":") : []) : [];
  const fill = rest !== undefined ? 8 - h.length - r.length : 0;
  const all = [...h, ...Array(Math.max(0, fill)).fill("0"), ...r].map((g) => parseInt(g || "0", 16));
  if (all.length !== 8 || all.some((g) => Number.isNaN(g))) return null;
  if (tail.length) { all[6] = tail[0]; all[7] = tail[1]; }
  return all;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Private(ip);
  if (!net.isIPv6(ip)) return true; // not an address we understand: refuse
  const g = v6Groups(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judge the embedded IPv4
  const embedded = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return v4Private(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Private(embedded);
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard-only
  return false;
}

export type SafeTargetOptions = { allowPrivate?: boolean; allowHttp?: boolean };

// static checks on a URL a person typed (no DNS): scheme, credentials, literal private addresses
export function checkUrlShape(raw: string, opts: SafeTargetOptions = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeTargetError("Enter a full URL, starting with https://.");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && opts.allowHttp)) throw new UnsafeTargetError("The URL must start with https://.");
  if (u.username || u.password) throw new UnsafeTargetError("Don't put a username or password in the URL.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeTargetError("The URL needs a host name.");
  if (!opts.allowPrivate) {
    if (net.isIP(host) && isPrivateAddress(host)) throw new UnsafeTargetError("That address is on a private network. Use a public URL.");
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new UnsafeTargetError("That host name is on a private network. Use a public URL.");
  }
  return u;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolver: Resolver = (host) => dns.lookup(host, { all: true, verbatim: true });

// resolves and vets every address; returns the one to connect to
export async function resolveSafe(u: URL, opts: SafeTargetOptions = {}, resolver: Resolver = systemResolver): Promise<{ address: string; family: number }> {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await resolver(host).catch(() => {
    throw new UnsafeTargetError(`Couldn't resolve ${host}.`);
  });
  if (!addrs.length) throw new UnsafeTargetError(`Couldn't resolve ${host}.`);
  if (!opts.allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) throw new UnsafeTargetError(`${host} points to a private network address.`);
  return addrs[0];
}

export type SafeResponse = { status: number; body: string; durationMs: number };

export async function safePost(raw: string, body: string, headers: Record<string, string>, opts: SafeTargetOptions & { timeoutMs?: number; maxResponseBytes?: number; resolver?: Resolver } = {}): Promise<SafeResponse> {
  const u = checkUrlShape(raw, opts);
  const target = await resolveSafe(u, opts, opts.resolver);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxResponseBytes ?? 8_192;
  const t0 = Date.now();
  const mod = u.protocol === "https:" ? https : http;
  return new Promise<SafeResponse>((resolve, reject) => {
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || undefined, path: `${u.pathname}${u.search}`, method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
      // pin the connection to the address we checked
      lookup: (_h: string, o: unknown, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
        if (o && typeof o === "object" && (o as { all?: boolean }).all) cb(null, [{ address: target.address, family: target.family }]);
        else cb(null, target.address, target.family);
      },
      servername: net.isIP(u.hostname) ? undefined : u.hostname,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        if (size < maxBytes) chunks.push(c.subarray(0, maxBytes - size));
        size += c.length;
        if (size >= maxBytes) res.destroy(); // enough to show in the delivery log
      });
      const finish = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), durationMs: Date.now() - t0 });
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", () => finish());
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)));
    req.on("error", (err) => reject(err));
    req.end(body);
  });
}
