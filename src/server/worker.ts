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
import { log } from "./log";

const g = globalThis as unknown as { __workerTimer?: ReturnType<typeof setInterval>; __lastHourly?: number; __lastDaily?: number };
const HOUR = 3600_000;

// one tick: time-based jobs first (they emit events), then deliver pending events
export async function workerTick() {
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
  } catch (err) {
    log.error("worker.tick_failed", { err });
  }
}

export function startWorkerLoop(intervalMs: number) {
  if (g.__workerTimer) return; // survive dev hot reloads without doubling up
  g.__workerTimer = setInterval(workerTick, intervalMs);
  g.__workerTimer.unref?.();
  log.info("worker.started", { intervalMs });
}
