// The parts of instrumentation that need Node.js (process signals, the worker, metrics). Kept in their own module and
// imported only when NEXT_RUNTIME is "nodejs", so the Edge bundle of instrumentation.ts never sees Node-only APIs.
import { assertProductionConfig } from "./server/ops/startup";
import { count } from "./server/ops/metrics";
import { reportError, type ErrorContext } from "./server/ops/error-tracking";

export async function registerNode() {
  // refuse to serve with an unsafe production configuration (see server/ops/config-check.ts)
  try {
    assertProductionConfig();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  if (process.env.DISABLE_INPROCESS_WORKER === "true") return;
  const { startWorkerLoop, stopWorker } = await import("./server/worker");
  startWorkerLoop(Number(process.env.WORKER_INTERVAL_MS) || 30_000);
  // on a deploy, let the tick in flight finish before the process goes away
  process.once("SIGTERM", () => void stopWorker(10_000));
}

export function recordRequestError(err: unknown, kind: string, ctx: Omit<ErrorContext, "source">) {
  count("app_request_errors_total", { kind });
  reportError(err, { source: "request", ...ctx });
}
