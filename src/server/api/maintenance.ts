import "server-only";
import { lt } from "drizzle-orm";
import { withContext } from "../db/client";
import { apiIdempotency } from "../db/schema";

// Idempotency-Key responses are kept for 24 hours
export async function purgeIdempotencyKeys(now = new Date()): Promise<number> {
  const rows = await withContext({ system: true }, (tx) => tx.delete(apiIdempotency).where(lt(apiIdempotency.createdAt, new Date(now.getTime() - 24 * 3600_000))).returning({ id: apiIdempotency.id }));
  return rows.length;
}
