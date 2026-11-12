// Iteration 13: production readiness — readiness and liveness probes, metrics, and workers taking turns.
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { GET as live } from "@/app/api/health/live/route";
import { GET as metrics } from "@/app/api/metrics/route";
import { readiness, resetHealthCacheForTests, operationalGauges } from "@/server/ops/health";
import { stopWorker, workerTick } from "@/server/worker";

const TICK_LOCK = 771_301_013;
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
afterAll(() => owner.end());

describe("health probes", () => {
  it("liveness answers without touching anything; readiness names each dependency and nothing else", async () => {
    expect(await (await live()).json()).toMatchObject({ status: "ok" });
    resetHealthCacheForTests();
    const res = await health();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.checks).toMatchObject({ database: "ok", migrations: "ok", database_role: "ok", storage: "ok" });
    expect(["ok", "not_configured"]).toContain(body.checks.redis);
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok"); // the field older monitors read
    // no addresses, versions or error text
    expect(JSON.stringify(body)).not.toMatch(/postgres|localhost|127\.0\.0\.1|password|version/i);
  });

  it("reports storage that can't be written as degraded, still serving", async () => {
    const { blobStore } = await import("@/server/files/storage");
    const store = blobStore();
    const original = store.check.bind(store);
    store.check = async () => { throw new Error("bucket gone"); };
    resetHealthCacheForTests();
    try {
      const r = await readiness();
      expect(r.checks.storage).toBe("failing");
      expect(r.status).toBe("degraded");
      expect((await health()).status).toBe(200);
    } finally {
      store.check = original;
      resetHealthCacheForTests();
    }
  });

  it("the app's database role cannot skip row-level security", async () => {
    resetHealthCacheForTests();
    expect((await readiness()).checks.database_role).toBe("ok");
  });
});

describe("workers take turns", () => {
  it("a tick records a heartbeat; a second worker holding the turn makes this one skip", async () => {
    await owner.query("delete from worker_heartbeats");
    expect(await workerTick()).toBe("ok");
    const { rows } = await owner.query("select worker_id, kind, last_tick_ms, last_error, last_tick_at from worker_heartbeats");
    expect(rows).toHaveLength(1);
    expect(rows[0].last_error).toBeNull();
    expect(Date.now() - new Date(rows[0].last_tick_at).getTime()).toBeLessThan(10_000);

    // another worker (a different connection) has the turn
    const other = await owner.connect();
    try {
      await other.query("select pg_advisory_lock($1)", [TICK_LOCK]);
      await owner.query("update worker_heartbeats set last_tick_at = now() - interval '1 hour'");
      expect(await workerTick()).toBe("skipped");
      // a skipped turn does no work and doesn't claim to have ticked
      const after = await owner.query("select last_tick_at from worker_heartbeats");
      expect(Date.now() - new Date(after.rows[0].last_tick_at).getTime()).toBeGreaterThan(3_000_000);
    } finally {
      // the other worker dies: closing its connection gives the turn back with nothing to clean up
      other.release(true);
    }
    await expect.poll(() => workerTick(), { timeout: 10_000 }).toBe("ok");
  });

  it("two ticks asked for at once in one process run once; shutdown waits for the tick in flight", async () => {
    const [a, b] = [workerTick(), workerTick()];
    expect(a).toBe(b);
    const stopped = stopWorker(20_000);
    expect(await a).toBe("ok");
    expect(await stopped).toBe("finished");
    expect(await stopWorker()).toBe("idle");
  });
});

describe("metrics endpoint", () => {
  const req = (auth?: string) => new Request("http://app.test/api/metrics", { headers: auth ? { authorization: auth } : {} });

  it("doesn't exist without a token, and refuses a wrong one", async () => {
    delete process.env.METRICS_TOKEN;
    expect((await metrics(req("Bearer anything"))).status).toBe(404);
    process.env.METRICS_TOKEN = "short";
    expect((await metrics(req("Bearer short"))).status).toBe(404); // too short to be a secret
    process.env.METRICS_TOKEN = "m".repeat(32);
    expect((await metrics(req())).status).toBe(401);
    expect((await metrics(req(`Bearer ${"x".repeat(32)}`))).status).toBe(401);
    expect((await metrics(req("Bearer m"))).status).toBe(401);
  });

  it("reports queue depths and worker health from the database, with totals only", async () => {
    process.env.METRICS_TOKEN = "m".repeat(32);
    await workerTick();
    const res = await metrics(req(`Bearer ${"m".repeat(32)}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("app_db_up 1");
    for (const q of ["notifications", "automation", "webhook_fanout", "webhook_deliveries", "email", "knowledge_indexing"]) expect(text).toContain(`app_queue_depth{queue="${q}"}`);
    expect(text).toMatch(/app_worker_last_tick_age_seconds \d+/);
    expect(text).toMatch(/app_worker_ticks_total\{outcome="ok"\} \d+/);
    expect(text).toMatch(/app_ai_requests_last_hour \d+/);
    // nothing that identifies a customer
    expect(text).not.toMatch(/pacific|demo\.test|harbour/i);
    const age = (await operationalGauges()).find((g) => g.name === "app_worker_last_tick_age_seconds")!;
    expect(age.value).toBeLessThan(30);
  });

  it("a waiting event shows up as queue depth and age", async () => {
    const before = (await operationalGauges()).find((g) => g.name === "app_queue_depth" && g.labels?.queue === "notifications")!.value;
    const org = (await owner.query("select id from organizations where slug = 'pacific-properties'")).rows[0].id;
    const { rows } = await owner.query("insert into outbox_events (org_id, type, payload, created_at) values ($1, 'test.metric', '{}', now() - interval '10 minutes') returning id", [org]);
    try {
      const gauges = await operationalGauges();
      expect(gauges.find((g) => g.name === "app_queue_depth" && g.labels?.queue === "notifications")!.value).toBe(before + 1);
      expect(gauges.find((g) => g.name === "app_queue_oldest_seconds" && g.labels?.queue === "notifications")!.value).toBeGreaterThanOrEqual(600);
    } finally {
      await owner.query("delete from outbox_events where id = $1", [rows[0].id]);
    }
  });
});
