import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPool, asApp, orgIdBySlug, ownerPool, userIdByEmail } from "../support/db";

// Proves Postgres RLS isolates tenants for the runtime role, independent of application code.
const OPS_TABLES = ["org_counters", "sla_policies", "triage_rules", "work_orders", "timeline_events", "tasks", "task_checklist_items", "inspection_templates",
  "inspections", "inspection_items", "incidents", "complaints", "files", "notifications", "notification_preferences", "outbox_events",
  // iteration 4: community
  "amenities", "amenity_blackouts", "bookings", "packages", "announcements", "announcement_reads", "message_threads", "messages", "message_reads",
  "message_templates", "documents", "document_versions",
  // iteration 5: front desk & facility
  "visitors", "parking_spaces", "vehicles", "parking_permits", "parking_violations", "shifts", "shift_handoffs", "assets", "pm_schedules", "asset_downtime",
  // iteration 6: AI assistant
  "ai_conversations", "ai_messages", "ai_tool_calls", "ai_usage", "ai_approvals", "ai_policies",
  "knowledge_entries", "knowledge_entry_versions", "kb_sources", "kb_chunks"];
const TENANT_TABLES = ["portfolios", "properties", "buildings", "floors", "units", "residents", "unit_occupancies", "membership_scopes", "memberships", "invitations", "audit_logs", "vendors", "vendor_contacts", "vendor_properties", "staff_profiles", ...OPS_TABLES];

let A: string; // Pacific Properties
let B: string; // Northshore Strata
let adminId: string; // member of both orgs

let fileFixture: string[] = [];
beforeAll(async () => {
  A = await orgIdBySlug("pacific-properties");
  B = await orgIdBySlug("northshore-strata");
  adminId = await userIdByEmail("admin@demo.test");
  // seed data has no uploaded files; add one metadata row per org so the files checks are meaningful
  const wo = await ownerPool.query("select distinct on (org_id) org_id, id from work_orders where org_id = any($1)", [[A, B]]);
  const ins = await ownerPool.query(
    "insert into files (org_id, entity_type, entity_id, storage_key, filename, content_type, size_bytes, sha256, visibility) select org_id, 'work_order', id, org_id || '/test/' || id, 'fixture.pdf', 'application/pdf', 1, repeat('0', 64), 'internal' from unnest($1::uuid[], $2::uuid[]) as t(org_id, id) returning id",
    [wo.rows.map((r) => r.org_id), wo.rows.map((r) => r.id)]);
  fileFixture = ins.rows.map((r) => r.id);
});
afterAll(async () => {
  if (fileFixture.length) await ownerPool.query("delete from files where id = any($1)", [fileFixture]);
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
  it.each(OPS_TABLES)("%s: both orgs have rows (so the check above is meaningful)", async (table) => {
    const { rows } = await ownerPool.query(`select count(distinct org_id)::int n from ${table} where org_id = any($1)`, [[A, B]]);
    expect(rows[0].n).toBe(2);
  });
  it.each(["work_orders", "tasks", "incidents", "complaints", "inspections", "timeline_events", "notifications", "outbox_events", "bookings", "packages", "announcements", "message_threads", "messages", "documents",
    "visitors", "parking_permits", "parking_violations", "vehicles", "shifts", "shift_handoffs", "assets", "pm_schedules", "asset_downtime",
    "ai_conversations", "ai_messages", "ai_tool_calls", "ai_usage", "ai_approvals", "ai_policies",
    "knowledge_entries", "knowledge_entry_versions", "kb_sources", "kb_chunks"])("%s: no context sees nothing", async (table) => {
    await asApp({}, async (q) => {
      const { rows } = await q(`select count(*)::int as n from ${table}`);
      expect(rows[0].n).toBe(0);
    });
  });
  it("notifications: users only see their own, even inside their org", async () => {
    const pm = await userIdByEmail("pm@demo.test");
    await asApp({ orgId: A, userId: pm }, async (q) => {
      const { rows } = await q("select count(*)::int n from notifications where user_id <> $1", [pm]);
      expect(rows[0].n).toBe(0);
    });
    const { rows } = await ownerPool.query("select count(*)::int n from notifications where org_id = $1 and user_id <> $2", [A, pm]);
    expect(rows[0].n).toBeGreaterThan(0);
  });
  it.each(["ai_conversations", "ai_messages"])("%s: private to their author, even inside the org and for platform admins", async (table) => {
    const pm = await userIdByEmail("pm@demo.test");
    await asApp({ orgId: A, userId: adminId }, async (q) => {
      expect((await q(`select count(*)::int n from ${table} where user_id <> $1`, [adminId])).rows[0].n).toBe(0);
    });
    await asApp({ orgId: A, userId: pm }, async (q) => {
      expect((await q(`select count(*)::int n from ${table}`)).rows[0].n).toBeGreaterThan(0);
      await expect(q(`insert into ai_conversations (org_id, user_id, title) values ($1, $2, 'x')`, [A, adminId])).rejects.toThrow(/row-level security/);
    });
    await asApp({ platformAdmin: true }, async (q) => {
      expect((await q(`select count(*)::int n from ${table}`)).rows[0].n).toBe(0);
    });
    const { rows } = await ownerPool.query(`select count(distinct user_id)::int n from ${table} where org_id = $1`, [A]);
    expect(rows[0].n).toBeGreaterThan(1);
  });
  it("assistant plans and policies can't be written into another organization", async () => {
    // each statement in its own (rolled-back) transaction: a refused insert aborts the transaction it's in
    await asApp({ orgId: A, userId: adminId }, async (q) => {
      await expect(q("insert into ai_policies (org_id, action, mode) values ($1, 'task.create', 'auto')", [B])).rejects.toThrow(/row-level security/);
    });
    await asApp({ orgId: A, userId: adminId }, async (q) => {
      await expect(q("insert into ai_approvals (org_id, turn_id, expires_at) values ($1, gen_random_uuid(), now())", [B])).rejects.toThrow(/row-level security/);
    });
    // and an org can't reach the other's rows to change them
    await asApp({ orgId: A, userId: adminId }, async (q) => {
      expect((await q("update ai_approvals set status = 'rejected' where org_id = $1", [B])).rowCount).toBe(0);
      expect((await q("delete from ai_policies where org_id = $1", [B])).rowCount).toBe(0);
    });
  });
  it("knowledge passages can't be planted in another organization", async () => {
    await asApp({ orgId: A, userId: adminId }, async (q) => {
      const [src] = (await q("select id from kb_sources limit 1")).rows;
      await expect(q("insert into kb_chunks (org_id, source_id, version, ordinal, context, content) values ($1, $2, 1, 99, 'x', 'planted')", [B, src.id])).rejects.toThrow(/row-level security/);
    });
    await asApp({ orgId: A, userId: adminId }, async (q) => {
      expect((await q("update kb_chunks set content = 'x' where org_id = $1", [B])).rowCount).toBe(0);
      expect((await q("delete from knowledge_entries where org_id = $1", [B])).rowCount).toBe(0);
    });
  });
  it("outbox: org context enqueues only for itself; the worker's system context reads across orgs", async () => {
    await asApp({ orgId: A, userId: adminId }, async (q) => {
      expect((await q("select count(*)::int n from outbox_events where org_id <> $1", [A])).rows[0].n).toBe(0);
      await q("insert into outbox_events (org_id, type, payload) values ($1, 'test', '{}')", [A]);
      await expect(q("insert into outbox_events (org_id, type, payload) values ($1, 'test', '{}')", [B])).rejects.toThrow(/row-level security/);
    });
    await asApp({ system: true }, async (q) => {
      const { rows } = await q("select count(distinct org_id)::int n from outbox_events");
      expect(rows[0].n).toBe(2);
    });
  });
  it("system context cannot write tenant rows into an org it doesn't name", async () => {
    await expect(asApp({ system: true }, (q) => q("insert into work_orders (org_id, number, property_id, category, title) select org_id, 99999, property_id, 'general', 'x' from work_orders limit 1"))).rejects.toThrow(/row-level security/);
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

describe("notifications write policy", () => {
  it("a request context cannot create notifications for another user", async () => {
    const pm = await userIdByEmail("pm@demo.test");
    await expect(asApp({ orgId: A, userId: adminId }, (q) => q("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'x', 'spoof')", [A, pm]))).rejects.toThrow(/row-level security/);
  });
  it("the worker's system context can, but only inside the org it names", async () => {
    const pm = await userIdByEmail("pm@demo.test");
    await asApp({ orgId: A, system: true }, async (q) => {
      expect((await q("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'x', 'ok')", [A, pm])).rowCount).toBe(1);
      await expect(q("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'x', 'nope')", [B, pm])).rejects.toThrow(/row-level security/);
    });
  });
});
