import "server-only";
import { log } from "./log";

// work that follows any change, outside the request: deliver notifications, run automation rules on the events the
// change raised (and on events those rules raise, up to the chain limit), deliver what the rules sent, then webhooks
export async function afterChange(opts: { index?: boolean } = {}) {
  const { drainOutbox } = await import("./modules/notifications/service");
  const { processAutomationEvents, MAX_CHAIN_DEPTH } = await import("./automation/engine");
  await drainOutbox().catch((err) => log.error("after_change.drain_failed", { err }));
  for (let i = 0; i <= MAX_CHAIN_DEPTH; i++) {
    const runs = await processAutomationEvents().catch((err) => { log.error("after_change.automation_failed", { err }); return 0; });
    await drainOutbox().catch(() => {});
    if (!runs) break;
  }
  // webhooks for whatever was raised above, delivered right away (the worker retries failures)
  const { fanOutWebhookEvents, deliverDueWebhooks } = await import("./webhooks/service");
  const fanned = await fanOutWebhookEvents().catch((err) => { log.error("after_change.webhooks_failed", { err }); return 0; });
  if (fanned) await deliverDueWebhooks().catch(() => {});
  if (opts.index) {
    // documents and knowledge entries queued for the assistant's index are processed right away (the worker also polls)
    const { processIndexQueue } = await import("./kb/indexer");
    await processIndexQueue().catch(() => {});
  }
}
