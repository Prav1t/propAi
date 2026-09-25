import "server-only";
import { headers } from "next/headers";
import { isIP } from "node:net";

export type RequestMeta = { ip: string | null; userAgent: string | null; requestId: string | null };

// client metadata for audit/login history; trusts x-forwarded-for only when TRUST_PROXY=true
export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  let ip: string | null = null;
  if (process.env.TRUST_PROXY === "true") {
    ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip");
  }
  ip ??= h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null;
  if (ip && !isIP(ip)) ip = null;
  return {
    ip,
    userAgent: h.get("user-agent")?.slice(0, 512) ?? null,
    requestId: h.get("x-request-id"),
  };
}
