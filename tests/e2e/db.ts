import "dotenv/config";
import { Pool } from "pg";

// direct database access for E2E setup that has no UI (e.g. a verified SSO domain needs real DNS); owner connection
let pool: Pool | null = null;
export async function ownerQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  pool ??= new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL, max: 2 });
  return (await pool.query(sql, params)).rows as T[];
}
export async function closeOwnerPool() {
  await pool?.end();
  pool = null;
}
