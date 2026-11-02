import type { Instrumentation } from "next";

// starts the in-process background loop (outbox delivery + SLA monitor) on Node servers
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.DISABLE_INPROCESS_WORKER === "true") return;
  const { startWorkerLoop } = await import("./server/worker");
  startWorkerLoop(Number(process.env.WORKER_INTERVAL_MS) || 30_000);
}

// every server error as one structured line. The digest is what the error page shows as its reference, and the request
// id matches the x-request-id response header, so a reference quoted by a user leads straight to this entry.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { log } = await import("./server/log");
  const { firstReport, isClientAbort, requestErrorFields } = await import("./server/request-error");
  const fields = requestErrorFields(err, request, context);
  if (isClientAbort(err)) return log.debug("request.aborted", { requestId: fields.requestId, path: fields.path, route: fields.route });
  if (firstReport(fields)) log.error("request.error", fields);
};
