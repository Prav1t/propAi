import "server-only";
import { sql } from "drizzle-orm";
import { db, withContext } from "../db/client";
import { blobStore } from "../files/storage";
import { rateLimiter } from "../auth/rate-limit";
import type { Gauge } from "./metrics";

export type Check = "ok" | "failing" | "not_configured";
export type Readiness = { status: "ok" | "degraded" | "down"; checks: Record<string, Check>; latencyMs: number };

const timed = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), ms).unref?.())]);

// storage and the database role don't change between probes; remember them briefly so a probe every few seconds
// costs one `select 1`
const g = globalThis as unknown as { __slowChecks?: { at: number; storage: Check; dbRole: Check; migrations: Check } };

async function slowChecks() {
  if (g.__slowChecks && Date.now() - g.__slowChecks.at < 30_000) return g.__slowChecks;
  const storage: Check = await timed(blobStore().check(), 4000).then(() => "ok" as const, () => "failing" as const);
  // the app must not be able to skip row-level security: not a superuser, no BYPASSRLS, not the owner of the tables
  const dbRole: Check = await db().execute(sql`
    select (r.rolsuper or r.rolbypassrls or exists (select 1 from pg_tables t where t.schemaname = 'public' and t.tablename = 'organizations' and t.tableowner = current_user)) as unsafe
    from pg_roles r where r.rolname = current_user`).then((r) => ((r.rows[0] as { unsafe: boolean } | undefined)?.unsafe ? "failing" : "ok"), () => "failing" as const);
  // the schema this build expects is there (the newest table of the newest migration)
  const migrations: Check = await db().execute(sql`select to_regclass('public.worker_heartbeats') is not null as present`)
    .then((r) => ((r.rows[0] as { present: boolean }).present ? "ok" : "failing"), () => "failing" as const);
  return (g.__slowChecks = { at: Date.now(), storage, dbRole, migrations });
}

// Ready to take traffic? The database is the only hard dependency ("down" → 503, the load balancer stops sending
// requests). Everything else degrades one feature and is reported as "degraded" with a 200, so one failing
// dependency doesn't take the whole app out of rotation.
export async function readiness(): Promise<Readiness> {
  const started = Date.now();
  const checks: Record<string, Check> = {};
  checks.database = await timed(db().execute(sql`select 1`), 3000).then(() => "ok" as const, () => "failing" as const);
  if (checks.database !== "ok") return { status: "down", checks, latencyMs: Date.now() - started };
  const slow = await slowChecks();
  checks.migrations = slow.migrations;
  checks.database_role = slow.dbRole;
  checks.storage = slow.storage;
  const limiter = rateLimiter();
  checks.redis = limiter.ping ? ((await limiter.ping()) ? "ok" : "failing") : "not_configured";
  const failing = Object.values(checks).includes("failing");
  return { status: checks.migrations === "failing" ? "down" : failing ? "degraded" : "ok", checks, latencyMs: Date.now() - started };
}

export function resetHealthCacheForTests() { g.__slowChecks = undefined; }

// queue depths and worker health, read from the database at scrape time (the same from any instance)
export async function operationalGauges(): Promise<Gauge[]> {
  try {
    const r = await withContext({ system: true }, (tx) => tx.execute(sql`
      select
        (select count(*) from outbox_events where processed_at is null)::int as notif_n,
        (select coalesce(extract(epoch from now() - min(created_at)), 0) from outbox_events where processed_at is null)::float as notif_age,
        (select count(*) from outbox_events where automation_at is null)::int as auto_n,
        (select coalesce(extract(epoch from now() - min(created_at)), 0) from outbox_events where automation_at is null)::float as auto_age,
        (select count(*) from outbox_events where webhooks_at is null)::int as fan_n,
        (select coalesce(extract(epoch from now() - min(created_at)), 0) from outbox_events where webhooks_at is null)::float as fan_age,
        (select count(*) from webhook_deliveries where status = 'pending' and next_attempt_at <= now())::int as hook_n,
        (select coalesce(extract(epoch from now() - min(next_attempt_at)), 0) from webhook_deliveries where status = 'pending' and next_attempt_at <= now())::float as hook_age,
        (select count(*) from email_outbox where status = 'queued')::int as mail_n,
        (select coalesce(extract(epoch from now() - min(created_at)), 0) from email_outbox where status = 'queued')::float as mail_age,
        (select count(*) from kb_sources where status in ('queued','indexing'))::int as kb_n,
        (select coalesce(extract(epoch from now() - max(last_tick_at)), -1) from worker_heartbeats)::float as tick_age,
        (select count(*) from ai_usage where created_at > now() - interval '1 hour')::int as ai_hour`));
    const v = r.rows[0] as Record<string, number>;
    const q = (queue: string, n: number, age?: number): Gauge[] => [
      { name: "app_queue_depth", labels: { queue }, value: Number(n) },
      ...(age === undefined ? [] : [{ name: "app_queue_oldest_seconds" as const, labels: { queue }, value: Math.round(Number(age)) }]),
    ];
    return [
      { name: "app_db_up", value: 1 },
      ...q("notifications", v.notif_n, v.notif_age), ...q("automation", v.auto_n, v.auto_age), ...q("webhook_fanout", v.fan_n, v.fan_age),
      ...q("webhook_deliveries", v.hook_n, v.hook_age), ...q("email", v.mail_n, v.mail_age), ...q("knowledge_indexing", v.kb_n),
      { name: "app_worker_last_tick_age_seconds", value: Math.round(Number(v.tick_age)) },
      { name: "app_ai_requests_last_hour", value: Number(v.ai_hour) },
    ];
  } catch {
    return [{ name: "app_db_up", value: 0 }];
  }
}
