import { Pool } from "pg";
import { TEST_ENV } from "./test-env";

// raw pools for tests: app role (subject to RLS) and owner (bypasses RLS, for fixtures/inspection)
export const appPool = new Pool({ connectionString: TEST_ENV.DATABASE_URL, max: 3 });
export const ownerPool = new Pool({ connectionString: TEST_ENV.MIGRATION_DATABASE_URL, max: 3 });

/* eslint-disable @typescript-eslint/no-explicit-any -- raw SQL rows in test helpers */
// run SQL as the app role with a given RLS context inside a rolled-back transaction
export async function asApp<T>(ctx: { orgId?: string; userId?: string; platformAdmin?: boolean }, fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.platform_admin', $3, true)", [ctx.orgId ?? "", ctx.userId ?? "", ctx.platformAdmin ? "on" : "off"]);
    return await fn((sql, params) => c.query(sql, params as any[]));
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

export async function orgIdBySlug(slug: string): Promise<string> {
  const { rows } = await ownerPool.query("select id from organizations where slug = $1", [slug]);
  if (!rows[0]) throw new Error(`org ${slug} not seeded`);
  return rows[0].id;
}

export async function userIdByEmail(email: string): Promise<string> {
  const { rows } = await ownerPool.query("select id from users where email = $1", [email]);
  if (!rows[0]) throw new Error(`user ${email} not seeded`);
  return rows[0].id;
}

export async function latestEmailLink(to: string, pathPrefix: string): Promise<string> {
  const { rows } = await ownerPool.query("select text from email_outbox where \"to\" = $1 order by created_at desc limit 5", [to]);
  for (const r of rows) {
    const m = (r.text as string).match(new RegExp(`https?://[^\\s]*${pathPrefix}[^\\s]*`));
    if (m) return m[0];
  }
  throw new Error(`no ${pathPrefix} link emailed to ${to}`);
}
