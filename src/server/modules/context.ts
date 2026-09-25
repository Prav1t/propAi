import "server-only";
import { withContext, type Tx } from "../db/client";
import type { Principal } from "../authz/authorize";
import type { RequestMeta } from "../request-meta";
import { writeAudit } from "../audit";

// passed as the first argument to every tenant-scoped service function
export type TenantCtx = { principal: Principal; meta: RequestMeta | null };

// all tenant queries run inside this: RLS pins the transaction to the principal's org
export function tenantTx<T>(ctx: TenantCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext({ orgId: ctx.principal.orgId, userId: ctx.principal.userId }, fn);
}

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

export class ConflictError extends Error {
  readonly status = 409;
}

// shorthand for writing an audit entry as the acting principal
export async function auditAs(
  tx: Tx, ctx: TenantCtx, action: string, entityType: string, entityId: string | null,
  before?: unknown, after?: unknown,
): Promise<void> {
  await writeAudit(tx, { orgId: ctx.principal.orgId, actorUserId: ctx.principal.userId, action, entityType, entityId, before, after }, ctx.meta);
}

// unique-constraint violations from Postgres (possibly wrapped by Drizzle)
export function uniqueViolation(e: unknown): string | null {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  if (err?.code === "23505") return err.constraint ?? "unique";
  if (err?.cause?.code === "23505") return err.cause.constraint ?? "unique";
  return null;
}

// optional trimmed string → null when blank
export const blankToNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

// maps named unique constraints to friendly field errors
export async function friendlyUnique<T>(fn: () => Promise<T>, messages: Record<string, [string, string]>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const c = uniqueViolation(e);
    if (c) {
      const [msg, field] = messages[c] ?? ["That value is already in use.", undefined as unknown as string];
      throw new ValidationError(msg, field);
    }
    throw e;
  }
}
