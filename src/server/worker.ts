import { checkSlaBreaches, drainOutbox } from "./modules/notifications/service";
import { log } from "./log";

const g = globalThis as unknown as { __workerTimer?: ReturnType<typeof setInterval> };

// one tick: flag SLA breaches, then deliver pending events
export async function workerTick() {
  try {
    const breached = await checkSlaBreaches();
    const delivered = await drainOutbox();
    if (breached || delivered) log.info("worker.tick", { breached, delivered });
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
