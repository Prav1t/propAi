import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, asApp, orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";

// Proves Postgres RLS isolates tenants for the runtime role, independent of application code.
const TENANT_TABLES = ["portfolios", "properties", "buildings", "floors", "units", "residents", "unit_occupancies", "membership_scopes", "memberships", "invitations", "audit_logs", "vendors", "vendor_contacts", "vendor_properties", "staff_profiles"];

let A: string; // Pacific Properties
let B: string; // Northshore Strata
let adminId: string; // member of both orgs

beforeAll(async () => {
  A = await orgIdBySlug("pacific-properties");
  B = await orgIdBySlug("northshore-strata");
  adminId = await userIdByEmail("admin@demo.test");
});
afterAll(async () => {
  await appPool.end();
  await ownerPool.end();
});

describe("database role", () => {
  it("runtime role is neither superuser nor BYPASSRLS", async () => {
    const { rows } = await appPool.query("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it("RLS is enabled on every tenant table", async () => {
    const { rows } = await ownerPool.query("select relname from pg_class where relrowsecurity and relname = any($1)", [TENANT_TABLES.concat(["organizations", "roles"])]);
    expect(rows.map((r) => r.relname).sort()).toEqual(TENANT_TABLES.concat(["organizations", "roles"]).sort());
  });
});

describe("reads", () => {
  it.each(TENANT_TABLES)("%s: org A context sees zero org B rows", async (table) => {
    await asApp({ orgId: A, userId: adminId }, async (q) => {
      const { rows } = await q(`select count(*)::int as n from ${table} where org_id is distinct from $1`, [A]);
      expect(rows[0].n).toBe(0);
    });
  });
  it("seed data exists in both orgs (so the checks above are meaningful)", async () => {
    const { rows } = await ownerPool.query("select org_id, count(*)::int n from units group by org_id");
    expect(rows.find((r) => r.org_id === A)?.n).toBeGreaterThan(300);
    expect(rows.find((r) => r.org_id === B)?.n).toBe(30);
  });
  it.each(["portfolios", "properties", "buildings", "units", "residents", "memberships"])("%s: no context sees nothing", async (table) => {
    await asApp({}, async (q) => {
      const { rows } = await q(`select count(*)::int as n from ${table}`);
      expect(rows[0].n).toBe(0);
    });
  });
  it("inside org A, a user who also belongs to org B cannot see their org B membership (regression)", async () => {
    await asApp({ orgId: A, userId: adminId }, async (q) => {
      const { rows } = await q("select org_id from memberships where user_id = $1", [adminId]);
      expect(rows.map((r) => r.org_id)).toEqual([A]);
      const orgs = await q("select id from organizations");
      expect(orgs.rows.map((r) => r.id)).toEqual([A]);
    });
  });
  it("with only a user context, the user sees exactly their own memberships", async () => {
    await asApp({ userId: adminId }, async (q) => {
      const { rows } = await q("select distinct org_id from memberships");
      expect(rows.map((r) => r.org_id).sort()).toEqual([A, B].sort());
      const others = await q("select count(*)::int n from memberships where user_id <> $1", [adminId]);
      expect(others.rows[0].n).toBe(0);
    });
  });
  it("platform admin context can list all organizations", async () => {
    await asApp({ platformAdmin: true }, async (q) => {
      const { rows } = await q("select count(*)::int n from organizations");
      expect(rows[0].n).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("writes", () => {
  it("cannot insert a row for another org", async () => {
    await expect(asApp({ orgId: A }, (q) => q("insert into portfolios (org_id, name) values ($1, 'x')", [B]))).rejects.toThrow(/row-level security/);
  });
  it("cannot update or delete another org's rows (0 rows affected)", async () => {
    const { rows } = await ownerPool.query("select id from units where org_id = $1 limit 1", [B]);
    await asApp({ orgId: A }, async (q) => {
      expect((await q("update units set status = 'vacant' where id = $1", [rows[0].id])).rowCount).toBe(0);
      expect((await q("delete from units where id = $1", [rows[0].id])).rowCount).toBe(0);
    });
    const after = await ownerPool.query("select count(*)::int n from units where id = $1", [rows[0].id]);
    expect(after.rows[0].n).toBe(1);
  });
  it("cannot move a row into another org", async () => {
    const { rows } = await ownerPool.query("select id from portfolios where org_id = $1 limit 1", [A]);
    await expect(asApp({ orgId: A }, (q) => q("update portfolios set org_id = $1 where id = $2", [B, rows[0].id]))).rejects.toThrow(/row-level security/);
  });
  it("audit log is append-only for the app role", async () => {
    await asApp({ orgId: A }, async (q) => {
      await expect(q("update audit_logs set action = 'tampered'")).rejects.toThrow(/permission denied/);
    });
    await asApp({ orgId: A }, async (q) => {
      await expect(q("delete from audit_logs")).rejects.toThrow(/permission denied/);
    });
  });
  it("cannot write audit entries into another org", async () => {
    await expect(asApp({ orgId: A, userId: adminId }, (q) => q("insert into audit_logs (org_id, action, entity_type) values ($1, 'x', 'y')", [B]))).rejects.toThrow(/row-level security/);
  });
});
