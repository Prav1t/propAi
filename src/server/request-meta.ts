import "server-only";
import { headers } from "next/headers";
import { clientIpConfig, clientIpFrom } from "./client-ip";

export type RequestMeta = { ip: string | null; userAgent: string | null; requestId: string | null };

// client metadata for audit, login history and rate limits; see client-ip.ts for which addresses are trusted
export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return {
    ip: clientIpFrom(h, clientIpConfig()),
    userAgent: h.get("user-agent")?.slice(0, 512) ?? null,
    requestId: h.get("x-request-id"),
  };
}
