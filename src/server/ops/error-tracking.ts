import { log } from "../log";

// Error tracking behind an interface (Iteration 13). Without SENTRY_DSN errors stay in the structured log; with it,
// they are also sent to any Sentry-compatible service (Sentry, GlitchTip, Bugsink) using the envelope protocol. No
// SDK: one small request per error, never awaited by the request that failed, and never allowed to throw.

export type ErrorContext = { requestId?: string | null; route?: string | null; path?: string | null; digest?: string | null; source: "request" | "worker" | "assistant"; extra?: Record<string, unknown> };
export interface ErrorTracker { capture(err: unknown, ctx: ErrorContext): Promise<void> }

export const noopTracker: ErrorTracker = { capture: async () => {} };

export function parseDsn(dsn: string): { url: string; publicKey: string } | null {
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !/^[\w-]+$/.test(project) || !/^https?:$/.test(u.protocol)) return null;
    return { url: `${u.protocol}//${u.host}/api/${project}/envelope/`, publicKey: u.username };
  } catch { return null; }
}

// stack frames in Sentry's shape, innermost last
function frames(stack: string | undefined) {
  return (stack ?? "").split("\n").slice(1, 40).map((l) => {
    const m = /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(l.trim());
    return m ? { function: m[1] ?? "<anonymous>", filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) } : null;
  }).filter(Boolean).reverse();
}

export function sentryEnvelope(err: unknown, ctx: ErrorContext, dsn: string, now = new Date()): string {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-error thrown");
  const event_id = crypto.randomUUID().replace(/-/g, "");
  const event = {
    event_id, timestamp: now.getTime() / 1000, platform: "node", level: "error",
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
    release: process.env.APP_RELEASE,
    transaction: ctx.route ?? ctx.source,
    // no request bodies, cookies, headers or user details: only where it happened and the reference people quote
    tags: { source: ctx.source, request_id: ctx.requestId ?? undefined, digest: ctx.digest ?? undefined },
    extra: ctx.extra,
    exception: { values: [{ type: e.name, value: e.message.slice(0, 2000), stacktrace: { frames: frames(e.stack) } }] },
  };
  const body = JSON.stringify(event);
  return [JSON.stringify({ event_id, sent_at: now.toISOString(), dsn }), JSON.stringify({ type: "event", length: Buffer.byteLength(body) }), body].join("\n");
}

export class SentryTracker implements ErrorTracker {
  private target;
  constructor(private dsn: string) { this.target = parseDsn(dsn); }
  async capture(err: unknown, ctx: ErrorContext) {
    if (!this.target) return;
    try {
      const res = await fetch(this.target.url, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${this.target.publicKey}, sentry_client=app/1` },
        body: sentryEnvelope(err, ctx, this.dsn),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) log.warn("errors.report_refused", { status: res.status });
    } catch (e) {
      log.warn("errors.report_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

const g = globalThis as unknown as { __tracker?: ErrorTracker; __trackerDsn?: string };
export function errorTracker(): ErrorTracker {
  const dsn = process.env.SENTRY_DSN ?? "";
  if (!g.__tracker || g.__trackerDsn !== dsn) {
    g.__trackerDsn = dsn;
    g.__tracker = dsn && parseDsn(dsn) ? new SentryTracker(dsn) : noopTracker;
    if (dsn && !parseDsn(dsn)) log.warn("errors.bad_dsn");
  }
  return g.__tracker;
}

// fire and forget
export function reportError(err: unknown, ctx: ErrorContext) { void errorTracker().capture(err, ctx); }
