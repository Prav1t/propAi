import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "./schema";
import { env } from "../env";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// one pool per process; reused across hot reloads in dev
const g = globalThis as unknown as { __pgPool?: Pool; __db?: Db };

export function db(): Db {
  if (!g.__db) {
    g.__pgPool = new Pool({ connectionString: env().DATABASE_URL, max: 10 });
    g.__db = drizzle(g.__pgPool, { schema });
  }
  return g.__db;
}

export async function closeDb() {
  await g.__pgPool?.end();
  g.__pgPool = undefined;
  g.__db = undefined;
}

// row-level-security context for a transaction
export type DbContext = {
  orgId?: string | null;
  userId?: string | null;
  platformAdmin?: boolean;
  inviteTokenHash?: string | null;
};

// runs fn in a transaction with transaction-local RLS settings (safe with pooling)
export async function withContext<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.org_id', ${ctx.orgId ?? ""}, true),
      set_config('app.user_id', ${ctx.userId ?? ""}, true),
      set_config('app.platform_admin', ${ctx.platformAdmin ? "on" : "off"}, true),
      set_config('app.invite_token_hash', ${ctx.inviteTokenHash ?? ""}, true)`);
    return fn(tx);
  });
}

// switch org context mid-transaction (used when accepting invitations / creating orgs)
export async function setTxOrg(tx: Tx, orgId: string) {
  await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
}
