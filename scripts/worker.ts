import "dotenv/config";
import { startWorkerLoop, stopWorker, workerTick } from "../src/server/worker";
import { closeDb } from "../src/server/db/client";
import { assertProductionConfig } from "../src/server/ops/startup";

// standalone worker for deployments that run the web app with DISABLE_INPROCESS_WORKER=true
// `--once` runs a single tick and exits (for cron-style schedulers)
async function main() {
  assertProductionConfig();
  if (process.argv.includes("--once")) {
    const outcome = await workerTick();
    await closeDb();
    process.exit(outcome === "failed" ? 1 : 0);
  }
  const interval = Number(process.env.WORKER_INTERVAL_MS) || 15_000;
  startWorkerLoop(interval, "standalone");
  void workerTick();
  // finish the tick in flight, then leave; the orchestrator's stop timeout should be above WORKER_SHUTDOWN_GRACE_MS
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "worker.stopping", signal }));
    const result = await stopWorker(Number(process.env.WORKER_SHUTDOWN_GRACE_MS) || 25_000);
    await closeDb().catch(() => {});
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "worker.stopped", result }));
    process.exit(result === "timed_out" ? 1 : 0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((e) => { console.error(e); process.exit(1); });
