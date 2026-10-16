import { checkSlaApproaching, checkSlaBreaches, drainOutbox } from "./modules/notifications/service";
import { publishDueAnnouncements } from "./modules/announcements/service";
import { packageReminders } from "./modules/packages/service";
import { generatePreventiveMaintenance } from "./modules/assets/service";
import { processIndexQueue } from "./kb/indexer";
import { MAX_CHAIN_DEPTH, processAutomationEvents, runDueSchedules, sweepStaleRuns } from "./automation/engine";
import { deliverDailyBriefs } from "./analytics/brief";
import { log } from "./log";

const g = globalThis as unknown as { __workerTimer?: ReturnType<typeof setInterval> };

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
    if (breached || warned || published || reminded || pm || scheduled || automated || briefs || swept || delivered || indexed) {
      log.info("worker.tick", { breached, warned, published, reminded, pm, scheduled, automated, briefs, swept, delivered, indexed });
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
