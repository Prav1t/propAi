import type { Instrumentation } from "next";

// starts the in-process background loop (outbox delivery + SLA monitor) on Node servers
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNode } = await import("./instrumentation-node");
  await registerNode();
}

// every server error as one structured line. The digest is what the error page shows as its reference, and the request
// id matches the x-request-id response header, so a reference quoted by a user leads straight to this entry.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  const { log } = await import("./server/log");
  const { firstReport, isClientAbort, requestErrorFields } = await import("./server/request-error");
  const fields = requestErrorFields(err, request, context);
  if (isClientAbort(err)) return log.debug("request.aborted", { requestId: fields.requestId, path: fields.path, route: fields.route });
  if (!firstReport(fields)) return;
  log.error("request.error", fields);
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recordRequestError } = await import("./instrumentation-node");
    recordRequestError(err, String(context.routeType ?? "unknown"), { requestId: fields.requestId as string | null, route: fields.route as string | null, path: fields.path as string | null, digest: fields.digest as string | null });
  }
};
