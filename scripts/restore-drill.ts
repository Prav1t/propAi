import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";

// Restore drill: proves a backup can be restored and that the restored data is intact, without touching the live
// database.
//   npm run db:restore-drill                 take a fresh backup of MIGRATION_DATABASE_URL and drill with it
//   npm run db:restore-drill -- <file.dump>  drill with an existing backup (its .sha256 is checked when present)
//   --keep                                   leave the scratch database in place for inspection
// It restores into a new scratch database on the same server, then checks: row counts against the source (fresh
// backups only), row-level security on every tenant table, the app role's privileges, and every audit hash chain.
// Exit code 0 only if every check passes. The scratch database is dropped afterwards.

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const given = args.find((a) => !a.startsWith("--"));
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl || !appUrl) throw new Error("Set MIGRATION_DATABASE_URL and DATABASE_URL");

const withDb = (url: string, name: string) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };
const scratch = `restore_drill_${Date.now()}`;
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => { results.push({ check, ok, detail }); console.log(`${ok ? "✓" : "✗"} ${check}: ${detail}`); };

const COUNTED = ["organizations", "users", "memberships", "properties", "units", "work_orders", "documents", "audit_logs", "ai_tool_calls"];

async function counts(pool: Pool) {
  const out: Record<string, number> = {};
  for (const t of COUNTED) out[t] = Number((await pool.query(`select count(*) from "${t}"`)).rows[0].count);
  return out;
}

async function main() {
  const started = Date.now();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "restore-drill-"));
  const admin = new Pool({ connectionString: ownerUrl, max: 2 });
  let file = given;
  let sourceCounts: Record<string, number> | null = null;
  try {
    if (!file) {
      file = path.join(tmp, "drill.dump");
      // counts and dump in one snapshot would need a shared transaction; a quiet moment is close enough for a drill,
      // and tables that only grow (audit) are compared with >=
      sourceCounts = await counts(admin);
      execFileSync("pg_dump", ["--format=custom", "--no-owner", `--file=${file}`, ownerUrl!], { stdio: ["ignore", "inherit", "inherit"] });
      console.log(`backup taken: ${file}`);
    } else {
      if (!existsSync(file)) throw new Error(`No such file: ${file}`);
      if (existsSync(`${file}.sha256`)) {
        const want = readFileSync(`${file}.sha256`, "utf8").trim().split(/\s+/)[0];
        const got = createHash("sha256").update(readFileSync(file)).digest("hex");
        record("checksum", want === got, want === got ? "matches the .sha256 written at backup time" : "DOES NOT MATCH: the file changed after the backup");
        if (want !== got) return;
      }
    }

    await admin.query(`create database "${scratch}"`);
    const restoreStarted = Date.now();
    try {
      execFileSync("pg_restore", ["--no-owner", "--exit-on-error", `--dbname=${withDb(ownerUrl!, scratch)}`, file], { stdio: ["ignore", "inherit", "pipe"] });
      record("restore", true, `restored into ${scratch} in ${((Date.now() - restoreStarted) / 1000).toFixed(1)}s`);
    } catch (e) {
      record("restore", false, String((e as { stderr?: Buffer }).stderr ?? e).trim().split("\n").slice(-3).join(" | "));
      return;
    }

    const restored = new Pool({ connectionString: withDb(ownerUrl!, scratch), max: 2 });
    try {
      const got = await counts(restored);
      if (sourceCounts) {
        const short = COUNTED.filter((t) => got[t] < sourceCounts![t]);
        record("row counts", short.length === 0, short.length ? `fewer rows than the source in: ${short.map((t) => `${t} (${got[t]} < ${sourceCounts![t]})`).join(", ")}` : COUNTED.map((t) => `${t} ${got[t]}`).join(", "));
      } else {
        record("row counts", got.organizations > 0 && got.users > 0, COUNTED.map((t) => `${t} ${got[t]}`).join(", "));
      }

      // every table that carries an organization must have row-level security on, with at least one policy
      const rls = await restored.query(`
        select c.relname as t, c.relrowsecurity as on, (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)::int as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and exists (select 1 from information_schema.columns col where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'org_id')`);
      const open = rls.rows.filter((r) => !r.on || r.policies === 0).map((r) => r.t);
      record("row-level security", open.length === 0, open.length ? `NOT protected: ${open.join(", ")}` : `${rls.rows.length} tenant tables, all with RLS and policies`);

      const appRole = decodeURIComponent(new URL(appUrl!).username);
      const role = await restored.query(`select rolsuper, rolbypassrls from pg_roles where rolname = $1`, [appRole]);
      const owns = await restored.query(`select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner = $1`, [appRole]);
      const canWriteAudit = await restored.query(`select has_table_privilege($1, 'audit_logs', 'UPDATE') or has_table_privilege($1, 'audit_logs', 'DELETE') as w, has_table_privilege($1, 'organizations', 'SELECT') as r`, [appRole]);
      const roleOk = role.rows[0] && !role.rows[0].rolsuper && !role.rows[0].rolbypassrls && owns.rows[0].n === 0 && !canWriteAudit.rows[0].w && canWriteAudit.rows[0].r;
      record("app role", !!roleOk, roleOk ? `${appRole}: can read and write through RLS, cannot bypass it, cannot change the audit log` : `${appRole}: privileges are wrong after the restore (run npm run db:migrate against the restored database to re-grant)`);

      const migrations = await restored.query(`select count(*)::int as n from drizzle.__drizzle_migrations`).catch(() => ({ rows: [{ n: 0 }] }));
      record("migration history", migrations.rows[0].n > 0, `${migrations.rows[0].n} migrations recorded`);
    } finally {
      await restored.end();
    }

    // the audit log's hash chains, verified by the application's own code running against the restored copy
    process.env.DATABASE_URL = withDb(appUrl!, scratch);
    const { verifyAllAuditChains } = await import("../src/server/audit-integrity");
    const { closeDb } = await import("../src/server/db/client");
    try {
      const chains = await verifyAllAuditChains();
      const broken = chains.filter((c) => c.problem);
      const entries = chains.reduce((n, c) => n + c.checked, 0);
      record("audit chains", broken.length === 0, broken.length ? `${broken.length} broken: ${broken.map((b) => `${b.chainKey} at #${b.problemSeq} (${b.problem})`).join("; ")}` : `${chains.length} chains, ${entries} entries, every hash links to the one before`);
    } finally {
      await closeDb();
    }
  } finally {
    if (!keep) await admin.query(`drop database if exists "${scratch}" with (force)`).catch((e) => console.warn(`could not drop ${scratch}: ${e.message}`));
    else console.log(`kept scratch database ${scratch}`);
    await admin.end();
    rmSync(tmp, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? `RESTORE DRILL FAILED (${failed.length} of ${results.length} checks)` : `Restore drill passed: ${results.length} checks in ${((Date.now() - started) / 1000).toFixed(1)}s`}`);
  process.exitCode = failed.length || !results.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
