import type { Pool } from "pg";
import { ciphertextKeyId } from "./auth/crypto";
import { needsReseal, seal, unseal, type Keyring } from "./keyring";

// every column that holds a sealed secret; the rotation job and `keys:status` walk this list
export const SEALED_COLUMNS = [
  { table: "users", column: "mfa_secret_enc" },
  { table: "users", column: "mfa_pending_secret_enc" },
  { table: "webhook_endpoints", column: "secret_enc" },
  { table: "integrations", column: "credentials_enc" },
  { table: "sso_connections", column: "client_secret_enc" },
] as const;

export type KeyUsage = Record<string, Record<string, number>>; // "table.column" → key id → rows

// how many sealed values each key protects (run with the owner connection: it reads across organizations)
export async function keyUsage(pool: Pool): Promise<KeyUsage> {
  const out: KeyUsage = {};
  for (const { table, column } of SEALED_COLUMNS) {
    const { rows } = await pool.query<{ v: string }>(`select ${column} as v from ${table} where ${column} is not null`);
    const counts: Record<string, number> = {};
    for (const r of rows) {
      const id = (r.v.startsWith("v1.") ? "k1 (v1)" : ciphertextKeyId(r.v)) ?? "unreadable";
      counts[id] = (counts[id] ?? 0) + 1;
    }
    out[`${table}.${column}`] = counts;
  }
  return out;
}

// re-seals every value that isn't on the current key; each row is updated only if it still holds the value read,
// so a concurrent change (say, a rotated webhook secret) is never overwritten with an old one
export async function resealAll(pool: Pool, ring: Keyring): Promise<{ resealed: number; failed: string[] }> {
  let resealed = 0;
  const failed: string[] = [];
  for (const { table, column } of SEALED_COLUMNS) {
    const { rows } = await pool.query<{ id: string; v: string }>(`select id, ${column} as v from ${table} where ${column} is not null`);
    for (const r of rows) {
      if (!needsReseal(r.v, ring)) continue;
      try {
        const next = seal(unseal(r.v, ring), ring);
        const u = await pool.query(`update ${table} set ${column} = $1 where id = $2 and ${column} = $3`, [next, r.id, r.v]);
        resealed += u.rowCount ?? 0;
      } catch (e) {
        failed.push(`${table}.${column} ${r.id}: ${(e as Error).message}`);
      }
    }
  }
  return { resealed, failed };
}
