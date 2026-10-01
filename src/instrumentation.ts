// starts the in-process background loop (outbox delivery + SLA monitor) on Node servers
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.DISABLE_INPROCESS_WORKER === "true") return;
  const { startWorkerLoop } = await import("./server/worker");
  startWorkerLoop(Number(process.env.WORKER_INTERVAL_MS) || 30_000);
}
