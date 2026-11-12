import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { configReport } from "./config-check";
import { assertProductionConfig } from "./startup";
import { count, observe, renderMetrics, resetMetricsForTests } from "./metrics";
import { parseDsn, sentryEnvelope, SentryTracker } from "./error-tracking";

const SAFE = {
  NODE_ENV: "production", APP_URL: "https://app.example.org", DATABASE_URL: "postgres://app:x@db.internal.example.org/app?sslmode=require",
  MIGRATION_DATABASE_URL: "postgres://owner:x@db.internal.example.org/app?sslmode=require", MAIL_PROVIDER: "smtp", MAIL_FROM: "Ops <no-reply@acme.org>",
  BILLING_PROVIDER: "stripe", FILE_STORAGE: "s3", REDIS_URL: "redis://r:6379", TRUSTED_PROXY_HOPS: "1", VAPID_PUBLIC_KEY: "x", AI_PROVIDER: "anthropic",
  METRICS_TOKEN: "t".repeat(32), SENTRY_DSN: "https://k@s.example.org/1", DISABLE_INPROCESS_WORKER: "true",
};

describe("production configuration check", () => {
  it("accepts a complete production configuration with nothing to say", () => {
    expect(configReport(SAFE)).toEqual({ errors: [], warnings: [] });
  });

  it.each([
    [{ APP_URL: "http://app.example.org" }, /https/],
    [{ APP_URL: "https://localhost:3000" }, /this machine/],
    [{ E2E_FAULTS: "true" }, /E2E_FAULTS/],
    [{ RATE_LIMITS: "relaxed" }, /RATE_LIMITS/],
    [{ WEBHOOK_ALLOW_PRIVATE_TARGETS: "true" }, /internal addresses/],
    [{ PUSH_ALLOW_PRIVATE_TARGETS: "true" }, /PUSH_ALLOW/],
    [{ OIDC_ALLOW_HTTP_ISSUERS: "true" }, /OIDC_ALLOW/],
    [{ MAIL_PROVIDER: "console" }, /only writes emails to the log/],
    [{ MAIL_PROVIDER: undefined }, /only writes emails to the log/],
    [{ MIGRATION_DATABASE_URL: "postgres://app:y@db.internal.example.org/app" }, /same database user/],
  ])("refuses %o", (change, message) => {
    const { errors } = configReport({ ...SAFE, ...change } as Record<string, string | undefined>);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(message);
  });

  it("warns about what works but weakens a deployment, without refusing it", () => {
    const { errors, warnings } = configReport({ NODE_ENV: "production", APP_URL: "https://a.example.org", DATABASE_URL: "postgres://app:x@db.example.org/app", MAIL_PROVIDER: "smtp", SHOW_DEMO_ACCOUNTS: "true" });
    expect(errors).toEqual([]);
    for (const m of [/sslmode/, /MAIL_FROM/, /mock/, /FILE_STORAGE=local/, /REDIS_URL/, /TRUSTED_PROXY_HOPS/, /VAPID/, /demo mode/, /SHOW_DEMO_ACCOUNTS/, /METRICS_TOKEN/, /SENTRY_DSN/, /worker/]) {
      expect(warnings.some((w) => m.test(w)), String(m)).toBe(true);
    }
  });

  it("stops a production start, lists every problem, and leaves development alone", () => {
    const bad = { ...SAFE, APP_URL: "http://app.example.org", E2E_FAULTS: "true" };
    expect(() => assertProductionConfig(bad)).toThrow(/2 problems[\s\S]*https[\s\S]*E2E_FAULTS/);
    expect(() => assertProductionConfig({ ...bad, NODE_ENV: "development" })).not.toThrow();
    // the escape hatch for smoke-testing a production build locally
    expect(() => assertProductionConfig({ ...bad, ALLOW_INSECURE_PRODUCTION: "true" })).not.toThrow();
    expect(() => assertProductionConfig(SAFE)).not.toThrow();
  });
});

describe("metrics", () => {
  afterEach(resetMetricsForTests);

  it("renders counters, histograms and gauges in the Prometheus text format", () => {
    count("app_api_requests_total", { method: "GET", status: "2xx" });
    count("app_api_requests_total", { method: "GET", status: "2xx" });
    count("app_api_requests_total", { method: "POST", status: "4xx" });
    observe("app_api_request_duration_seconds", 0.03, { method: "GET" });
    observe("app_api_request_duration_seconds", 3, { method: "GET" });
    const text = renderMetrics([{ name: "app_queue_depth", labels: { queue: "email" }, value: 4 }]);
    expect(text).toContain("# TYPE app_api_requests_total counter");
    expect(text).toContain('app_api_requests_total{method="GET",status="2xx"} 2');
    expect(text).toContain('app_api_requests_total{method="POST",status="4xx"} 1');
    expect(text).toContain('app_api_request_duration_seconds_bucket{le="0.05",method="GET"} 1');
    expect(text).toContain('app_api_request_duration_seconds_bucket{le="5",method="GET"} 2');
    expect(text).toContain('app_api_request_duration_seconds_bucket{le="+Inf",method="GET"} 2');
    expect(text).toContain('app_api_request_duration_seconds_count{method="GET"} 2');
    expect(text).toContain('app_queue_depth{queue="email"} 4');
    expect(text).toMatch(/app_process_uptime_seconds \d+/);
    // every sample line is "name{labels} number"
    for (const l of text.trim().split("\n").filter((x) => !x.startsWith("#"))) expect(l).toMatch(/^[a-z_]+(\{[^}]*\})? -?[\d.e+]+$/);
  });

  it("keeps label values from breaking the format", () => {
    count("app_request_errors_total", { kind: 'a"b\nc' });
    expect(renderMetrics()).toContain('app_request_errors_total{kind="a_b_c"} 1');
  });
});

describe("error tracking", () => {
  it("reads a DSN and refuses malformed ones", () => {
    expect(parseDsn("https://abc123@errors.example.org/42")).toEqual({ url: "https://errors.example.org/api/42/envelope/", publicKey: "abc123" });
    for (const bad of ["", "not a url", "https://errors.example.org/42", "https://k@errors.example.org/", "ftp://k@h/1", "https://k@h/a/b"]) expect(parseDsn(bad), bad).toBeNull();
  });

  it("builds an envelope with the reference people quote and nothing personal", () => {
    const err = new TypeError("boom");
    const [header, item, event] = sentryEnvelope(err, { source: "request", requestId: "req-1", route: "/o/[orgSlug]/tasks", digest: "123", path: "/o/acme/tasks" }, "https://k@h.example.org/1").split("\n").map((l) => JSON.parse(l));
    expect(header.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(item).toMatchObject({ type: "event" });
    expect(event).toMatchObject({ level: "error", transaction: "/o/[orgSlug]/tasks", tags: { source: "request", request_id: "req-1", digest: "123" }, exception: { values: [{ type: "TypeError", value: "boom" }] } });
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(event)).not.toContain("/o/acme/tasks"); // the concrete path (organization slug) stays in our own log
    expect(event.user).toBeUndefined();
    expect(event.request).toBeUndefined();
  });

  it("delivers to a Sentry-compatible endpoint and never throws when it is down", async () => {
    const got: { url?: string; auth?: string; body?: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { got.push({ url: req.url, auth: String(req.headers["x-sentry-auth"]), body }); res.writeHead(200).end("{}"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await new SentryTracker(`http://pubkey@127.0.0.1:${port}/7`).capture(new Error("worker broke"), { source: "worker" });
    expect(got).toHaveLength(1);
    expect(got[0].url).toBe("/api/7/envelope/");
    expect(got[0].auth).toContain("sentry_key=pubkey");
    expect(got[0].body).toContain("worker broke");
    await new Promise((r) => server.close(r));
    await expect(new SentryTracker(`http://pubkey@127.0.0.1:${port}/7`).capture(new Error("x"), { source: "worker" })).resolves.toBeUndefined();
  });
});
