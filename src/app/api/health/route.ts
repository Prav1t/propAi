import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

export const dynamic = "force-dynamic";

// liveness + database readiness; no sensitive detail in the response
export async function GET() {
  const started = Date.now();
  try {
    await db().execute(sql`select 1`);
    return Response.json({ status: "ok", db: "ok", latencyMs: Date.now() - started, time: new Date().toISOString() });
  } catch {
    return Response.json({ status: "degraded", db: "unreachable", time: new Date().toISOString() }, { status: 503 });
  }
}
