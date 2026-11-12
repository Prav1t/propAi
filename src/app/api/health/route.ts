import { readiness } from "@/server/ops/health";

export const dynamic = "force-dynamic";

// Readiness: can this instance serve requests? 503 only when the database (or its schema) isn't there; a failing
// optional dependency is "degraded" with a 200. Names of checks only, no addresses, versions or error text.
export async function GET() {
  const r = await readiness();
  return Response.json({ ...r, db: r.checks.database === "ok" ? "ok" : "unreachable", time: new Date().toISOString() }, { status: r.status === "down" ? 503 : 200, headers: { "cache-control": "no-store" } });
}
