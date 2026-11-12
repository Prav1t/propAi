import { timingSafeEqual } from "node:crypto";
import { operationalGauges } from "@/server/ops/health";
import { renderMetrics } from "@/server/ops/metrics";

export const dynamic = "force-dynamic";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Prometheus metrics. Off unless METRICS_TOKEN is set (at least 24 characters); the scraper sends it as a bearer
// token. Totals only: no organization names, user ids or paths with record ids.
export async function GET(req: Request) {
  const token = process.env.METRICS_TOKEN ?? "";
  if (token.length < 24) return new Response("Not found", { status: 404 });
  const given = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!same(given, token)) return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  return new Response(renderMetrics(await operationalGauges()), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
}
