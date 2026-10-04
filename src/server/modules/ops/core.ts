import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { orgCounters, outboxEvents, timelineEvents, users } from "../../db/schema";
import type { TenantCtx } from "../context";

// next value of a per-org sequence (atomic upsert; safe under concurrency)
export async function nextNumber(tx: Tx, orgId: string, key: string): Promise<number> {
  const [r] = await tx
    .insert(orgCounters)
    .values({ orgId, key, value: 1 })
    .onConflictDoUpdate({ target: [orgCounters.orgId, orgCounters.key], set: { value: sql`${orgCounters.value} + 1` } })
    .returning({ value: orgCounters.value });
  return r.value;
}

export type Visibility = "public" | "vendor" | "internal";
export type TimelineInput = {
  entityType: string; entityId: string; kind: string; body?: string | null;
  fromStatus?: string | null; toStatus?: string | null; visibility?: Visibility;
};

export async function addTimeline(tx: Tx, ctx: TenantCtx | { orgId: string; userId: string | null }, e: TimelineInput) {
  const orgId = "principal" in ctx ? ctx.principal.orgId : ctx.orgId;
  const actor = "principal" in ctx ? ctx.principal.userId : ctx.userId;
  const [row] = await tx.insert(timelineEvents).values({
    orgId, entityType: e.entityType, entityId: e.entityId, actorUserId: actor, kind: e.kind, body: e.body ?? null,
    fromStatus: e.fromStatus ?? null, toStatus: e.toStatus ?? null, visibility: e.visibility ?? "internal",
  }).returning();
  return row;
}

// events visible at the given levels, oldest first, with actor names
export async function listTimeline(tx: Tx, orgId: string, entityType: string, entityId: string, levels: Visibility[]) {
  return tx
    .select({ e: timelineEvents, actorName: users.name })
    .from(timelineEvents)
    .leftJoin(users, eq(users.id, timelineEvents.actorUserId))
    .where(and(eq(timelineEvents.orgId, orgId), eq(timelineEvents.entityType, entityType), eq(timelineEvents.entityId, entityId), inArray(timelineEvents.visibility, levels)))
    .orderBy(asc(timelineEvents.createdAt));
}

// domain event written in the same transaction as the change (transactional outbox)
export async function emit(tx: Tx, ctx: TenantCtx, type: string, payload: Record<string, unknown>) {
  await tx.insert(outboxEvents).values({ orgId: ctx.principal.orgId, type, payload, actorUserId: ctx.principal.userId });
}

// events raised by the background worker (no acting user)
export async function emitSystem(tx: Tx, orgId: string, type: string, payload: Record<string, unknown>) {
  await tx.insert(outboxEvents).values({ orgId, type, payload, actorUserId: null });
}

// add/subtract minutes
export const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
