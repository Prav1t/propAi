import { checkSlaApproaching, checkSlaBreaches, drainOutbox } from "./modules/notifications/service";
import { publishDueAnnouncements } from "./modules/announcements/service";
import { packageReminders } from "./modules/packages/service";
import { generatePreventiveMaintenance } from "./modules/assets/service";
import { processIndexQueue } from "./kb/indexer";
import { MAX_CHAIN_DEPTH, processAutomationEvents, runDueSchedules, sweepStaleRuns } from "./automation/engine";
import { deliverDailyBriefs } from "./analytics/brief";
import { billingTick, snapshotUsage } from "./billing/service";
import { deliverDueWebhooks, fanOutWebhookEvents } from "./webhooks/service";
import { purgeIdempotencyKeys } from "./api/maintenance";
import { checkpointAuditChains } from "./audit-integrity";
import { purgeSsoStates } from "./sso/service";
import { applyRetention, purgeExpiredExports } from "./privacy/service";
import os from "node:os";
import { sql } from "drizzle-orm";
import { log } from "./log";
import { generateRentCharges } from "./modules/leases/service";
import { pool, withContext } from "./db/client";
import { count, observe } from "./ops/metrics";
import { reportError } from "./ops/error-tracking";

const g = globalThis as unknown as { __workerTimer?: ReturnType<typeof setInterval>; __lastHourly?: number; __lastDaily?: number; __tick?: Promise<TickOutcome> | null; __workerStarted?: Date; __workerKind?: string };
const HOUR = 3600_000;

export type TickOutcome = "ok" | "failed" | "skipped";
const WORKER_ID = `${os.hostname()}:${process.pid}`;
// any constant works; every worker of one database must use the same one
const TICK_LOCK = 771_301_013;

async function heartbeat(ms: number, error: string | null) {
  const started = (g.__workerStarted ??= new Date());
  await withContext({ system: true }, (tx) => tx.execute(sql`
    insert into worker_heartbeats (worker_id, kind, started_at, last_tick_at, last_tick_ms, last_error)
    values (${WORKER_ID}, ${g.__workerKind ?? "in-process"}, ${started}, now(), ${Math.round(ms)}, ${error})
    on conflict (worker_id) do update set last_tick_at = now(), last_tick_ms = excluded.last_tick_ms, last_error = excluded.last_error`));
  // rows of workers that are gone (a week without a tick)
  await withContext({ system: true }, (tx) => tx.execute(sql`delete from worker_heartbeats where last_tick_at < now() - interval '7 days'`));
}

// One tick. Workers take turns: a session-level advisory lock on one dedicated connection means two instances never
// run the jobs at the same moment, and a worker that dies gives the turn up when its connection closes (nothing to
// expire, nothing to clean up after a restart). A tick already running in this process is joined, not doubled.
export function workerTick(): Promise<TickOutcome> {
  return (g.__tick ??= lockedTick().finally(() => { g.__tick = null; }));
}

async function lockedTick(): Promise<TickOutcome> {
  const started = performance.now();
  let client;
  try {
    client = await pool().connect();
  } catch (err) {
    log.error("worker.tick_failed", { err });
    count("app_worker_ticks_total", { outcome: "failed" });
    return "failed";
  }
  let outcome: TickOutcome = "ok";
  try {
    const { rows } = await client.query("select pg_try_advisory_lock($1) as held", [TICK_LOCK]);
    if (!rows[0]?.held) outcome = "skipped"; // another worker has this turn
    else {
      try {
        outcome = (await runJobs()) ? "ok" : "failed";
      } finally {
        await client.query("select pg_advisory_unlock($1)", [TICK_LOCK]).catch(() => {});
      }
    }
  } catch (err) {
    outcome = "failed";
    log.error("worker.tick_failed", { err });
  } finally {
    client.release();
  }
  const ms = performance.now() - started;
  count("app_worker_ticks_total", { outcome });
  if (outcome !== "skipped") {
    observe("app_worker_tick_duration_seconds", ms / 1000);
    await heartbeat(ms, outcome === "failed" ? "see worker.tick_failed in the log" : null).catch((err) => log.warn("worker.heartbeat_failed", { err }));
  }
  return outcome;
}

// time-based jobs first (they emit events), then deliver pending events
async function runJobs(): Promise<boolean> {
  try {
    const breached = await checkSlaBreaches();
    const warned = await checkSlaApproaching();
    const published = await publishDueAnnouncements();
    const reminded = await packageReminders();
    const pm = await generatePreventiveMaintenance();
    const scheduled = await runDueSchedules();
    // rules on the events above (and on events those rules raise, up to the chain limit)
    let automated = 0;
    for (let i = 0; i <= MAX_CHAIN_DEPTH; i++) {
      const n = await processAutomationEvents();
      automated += n;
      if (!n) break;
    }
    const briefs = await deliverDailyBriefs();
    const swept = await sweepStaleRuns();
    const delivered = await drainOutbox();
    const indexed = await processIndexQueue();
    // Iteration 10: billing (trial notices, expiry, renewals), webhooks, and hourly housekeeping
    const billing = await billingTick();
    const fanned = await fanOutWebhookEvents();
    const hooks = await deliverDueWebhooks();
    let usage = 0;
    if (!g.__lastHourly || Date.now() - g.__lastHourly > HOUR) {
      g.__lastHourly = Date.now();
      usage = await snapshotUsage();
      await purgeIdempotencyKeys();
      // Iteration 11: audit chain checkpoints, abandoned SSO sign-ins
      await checkpointAuditChains();
      await purgeSsoStates();
      // Iteration 13: this month's rent charges for leases in force
      await generateRentCharges();
    }
    // Iteration 11: retention settings and expired privacy exports, once a day
    if (!g.__lastDaily || Date.now() - g.__lastDaily > 24 * HOUR) {
      g.__lastDaily = Date.now();
      const retained = await applyRetention();
      const exports = await purgeExpiredExports();
      if (Object.keys(retained).length || exports) log.info("worker.retention", { ...retained, exports });
    }
    const billed = billing.notices + billing.expired + billing.renewed;
    if (breached || warned || published || reminded || pm || scheduled || automated || briefs || swept || delivered || indexed || billed || fanned || hooks) {
      log.info("worker.tick", { breached, warned, published, reminded, pm, scheduled, automated, briefs, swept, delivered, indexed, billing, fanned, hooks, usage });
    }
    return true;
  } catch (err) {
    log.error("worker.tick_failed", { err });
    reportError(err, { source: "worker" });
    return false;
  }
}

export function startWorkerLoop(intervalMs: number, kind: "in-process" | "standalone" = "in-process") {
  if (g.__workerTimer) return; // survive dev hot reloads without doubling up
  g.__workerKind = kind;
  g.__workerStarted = new Date();
  g.__workerTimer = setInterval(workerTick, intervalMs);
  if (kind === "in-process") g.__workerTimer.unref?.();
  log.info("worker.started", { intervalMs, kind, workerId: WORKER_ID });
}

// stop taking new turns and wait for the one in flight (up to graceMs); used on SIGTERM so a deploy never cuts a
// delivery in half. Every job is also safe to stop mid-way: items are claimed and marked inside transactions.
export async function stopWorker(graceMs = 25_000): Promise<"idle" | "finished" | "timed_out"> {
  if (g.__workerTimer) clearInterval(g.__workerTimer);
  g.__workerTimer = undefined;
  const running = g.__tick;
  if (!running) return "idle";
  const done = await Promise.race([running.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), graceMs).unref?.())]);
  return done ? "finished" : "timed_out";
}
