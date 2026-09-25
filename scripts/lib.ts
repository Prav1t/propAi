import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/server/db/schema";

// owner connection for migrations and seeding (bypasses RLS as table owner)
export function ownerDb() {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATION_DATABASE_URL (or DATABASE_URL)");
  const pool = new Pool({ connectionString: url, max: 4 });
  return { db: drizzle(pool, { schema }), pool };
}

// the least-privilege runtime role, derived from DATABASE_URL
export function appRoleName(): string | null {
  const app = process.env.DATABASE_URL;
  const owner = process.env.MIGRATION_DATABASE_URL;
  if (!app || !owner) return null;
  const a = decodeURIComponent(new URL(app).username);
  const o = decodeURIComponent(new URL(owner).username);
  return a && a !== o ? a : null;
}
