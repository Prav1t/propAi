import { migrate } from "drizzle-orm/node-postgres/migrator";
import { notInArray, sql } from "drizzle-orm";
import { ownerDb, appRoleName } from "./lib";
import { permissions, roles } from "../src/server/db/schema";
import { PERMISSIONS } from "../src/server/authz/permissions";
import { SYSTEM_ROLES } from "../src/server/authz/system-roles";

// applies SQL migrations, syncs permission catalog + system roles, grants the app role
async function main() {
  const { db, pool } = ownerDb();
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("✓ migrations applied");

  await db.transaction(async (tx) => {
    const keys = Object.keys(PERMISSIONS);
    for (const [key, v] of Object.entries(PERMISSIONS)) {
      await tx.insert(permissions).values({ key, module: v.module, description: v.description })
        .onConflictDoUpdate({ target: permissions.key, set: { module: v.module, description: v.description } });
    }
    await tx.delete(permissions).where(notInArray(permissions.key, keys));

    for (const r of SYSTEM_ROLES) {
      const existing = await tx.select({ id: roles.id }).from(roles)
        .where(sql`${roles.orgId} is null and ${roles.key} = ${r.key}`);
      const values = { name: r.name, description: r.description, category: r.category, scopeLevel: r.scopeLevel, permissions: r.permissions, isSystem: true };
      if (existing[0]) await tx.update(roles).set(values).where(sql`${roles.id} = ${existing[0].id}`);
      else await tx.insert(roles).values({ ...values, key: r.key, orgId: null });
    }
  });
  console.log(`✓ ${Object.keys(PERMISSIONS).length} permissions, ${SYSTEM_ROLES.length} system roles synced`);

  const appRole = appRoleName();
  if (appRole) {
    const ident = `"${appRole.replace(/"/g, '""')}"`;
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${ident}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident}`);
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident}`);
    await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ident}`);
    // audit log is append-only for the app
    await pool.query(`REVOKE UPDATE, DELETE ON audit_logs FROM ${ident}`);
    // drizzle's migration bookkeeping stays owner-only
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM ${ident}`).catch(() => {});
    const { rows } = await pool.query(`select rolsuper, rolbypassrls from pg_roles where rolname = $1`, [appRole]);
    if (rows[0]?.rolsuper || rows[0]?.rolbypassrls) {
      console.warn(`⚠ app role ${appRole} is SUPERUSER/BYPASSRLS — row-level security will NOT protect tenants`);
    }
    console.log(`✓ privileges granted to app role ${appRole}`);
  } else {
    console.warn("⚠ DATABASE_URL and MIGRATION_DATABASE_URL use the same user; RLS is bypassed by the table owner. Use a separate app role in every environment.");
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
