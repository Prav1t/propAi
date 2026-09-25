import "server-only";
import { withContext, type Tx } from "../db/client";
import type { Principal } from "../authz/authorize";
import type { RequestMeta } from "../request-meta";

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
