export const dynamic = "force-dynamic";

// Liveness: the process is up and answering. Touches nothing else, so a database outage never makes an orchestrator
// restart healthy app instances (use /api/health for readiness).
export function GET() {
  return Response.json({ status: "ok", time: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}
