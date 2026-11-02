// fields logged for a failed request. Query strings are dropped: they can carry one-time tokens (password reset,
// invitations, SSO state) that must not end up in logs.
export function requestErrorFields(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routePath: string; routeType: string },
) {
  const e = err instanceof Error ? err : new Error(String(err));
  const header = (k: string) => {
    const v = request.headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    digest: typeof err === "object" && err !== null && "digest" in err ? String((err as { digest: unknown }).digest) : undefined,
    requestId: header("x-request-id"),
    method: request.method,
    path: request.path.split("?")[0],
    route: context.routePath,
    routeType: context.routeType,
    error: { name: e.name, message: e.message, stack: e.stack },
  };
}

// React reports one failure once per render pass (server components, then HTML), so the same digest arrives several
// times for a single request; log it once
const seen = new Map<string, number>();
export function firstReport(fields: { digest?: string; requestId?: string }, now = Date.now(), windowMs = 30_000): boolean {
  if (!fields.digest) return true;
  const key = `${fields.requestId ?? "-"}:${fields.digest}`;
  for (const [k, t] of seen) if (now - t > windowMs) seen.delete(k); else break; // oldest first
  if (seen.has(key)) return false;
  seen.set(key, now);
  if (seen.size > 5_000) seen.delete(seen.keys().next().value!);
  return true;
}

// the browser went away while a streamed page was still being written (navigated elsewhere, closed the tab). Next.js
// reports these through onRequestError too; they aren't server failures, so they mustn't page anyone.
const ABORTS = [/destination stream errored while writing/i, /ECONNRESET/, /socket hang up/i, /Premature close/i];
export function isClientAbort(err: unknown): boolean {
  const e = err as { message?: unknown; code?: unknown; name?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "AbortError" || e.code === "ECONNRESET" || e.code === "ERR_STREAM_PREMATURE_CLOSE") return true;
  return typeof e.message === "string" && ABORTS.some((r) => r.test(e.message as string));
}
