# Observability

## Logs

Every process writes one JSON object per line to standard output: `ts`, `level`, `msg`, then fields. Ship stdout to whatever you use (CloudWatch, Loki, Datadog, Elastic). `LOG_LEVEL` is `debug`, `info` (default), `warn` or `error`.

- **Request ids.** Every response carries `x-request-id` (an incoming one is kept, so a load balancer's id flows through). Server errors are logged once as `request.error` with that id, the route, and the `digest` that the error page shows the person as its *Reference*. A reference quoted to support leads straight to the log line.
- **Never logged:** passwords, tokens, query strings (they can carry one-time links), request bodies, message contents.

| `msg` | Meaning | Act on it? |
|---|---|---|
| `request.error` | An unhandled server error | Yes: alert on rate |
| `request.aborted` (debug) | The browser left mid-page | No |
| `worker.tick` | A worker turn that did something, with counts | No |
| `worker.tick_failed` | A worker turn failed; it retries next turn | Yes if repeated |
| `worker.started`, `worker.stopping`, `worker.stopped` | Worker lifecycle; `stopped` says whether the turn in flight finished | No |
| `ai.stream_failed` | The assistant failed mid-answer | Yes if repeated |
| `csp.violation` | A browser blocked something the Content-Security-Policy forbids | Look at new sources |
| `config.warning`, `config.unsafe` | Start-up configuration report | Read after each deploy |
| `audit.checkpoint` | Hourly audit-chain checkpoint (sequence and hash) | Keep: it is evidence |
| `email.failed`, `push.delivery_failed`, `webhooks.delivery_failed`, `webhooks.endpoint_disabled` | Delivery problems, with retry state | Yes if persistent |
| `automation.run_failed`, `automation.paused_runaway`, `kb.index_failed`, `billing.renewal_failed` | A background job failed for one item; the rest carried on | Yes if persistent |

## Metrics

`GET /api/metrics` returns Prometheus text. It is off until `METRICS_TOKEN` is set (24 characters or more); the scraper sends `Authorization: Bearer <token>`. Keep it off the public internet (the bundled Caddy config answers 404 for it from outside). Scrape each app instance; queue and worker gauges come from the database, so they read the same from any instance.

| Metric | Type | What it tells you |
|---|---|---|
| `app_queue_depth{queue}` | gauge | Items waiting: `notifications`, `automation`, `webhook_fanout`, `webhook_deliveries`, `email`, `knowledge_indexing` |
| `app_queue_oldest_seconds{queue}` | gauge | Age of the oldest waiting item. The best single signal that background work is stuck |
| `app_worker_last_tick_age_seconds` | gauge | Seconds since any worker finished a turn (`-1`: none ever has) |
| `app_worker_ticks_total{outcome}` | counter | Turns in this process: `ok`, `failed`, `skipped` (another worker had the turn) |
| `app_worker_tick_duration_seconds` | histogram | How long turns take |
| `app_request_errors_total{kind}` | counter | Unhandled server errors |
| `app_api_requests_total{method,status}` | counter | REST API requests by method and status class |
| `app_api_request_duration_seconds{method}` | histogram | REST API latency |
| `app_ai_requests_last_hour` | gauge | Assistant requests in the last hour, all organizations |
| `app_db_up` | gauge | 1 when the database answered the scrape |
| `app_process_uptime_seconds`, `app_process_resident_memory_bytes` | gauge | Per process |

Metrics carry totals only: no organization, user or record identifiers.

**Not exported by the app:** latency of pages (HTML). Take request rate, latency and 5xx rate for pages from your load balancer or reverse proxy, which sees every request (Caddy's JSON access log has `duration` and `status`).

### Example Prometheus scrape and alerts

```yaml
scrape_configs:
  - job_name: app
    metrics_path: /api/metrics
    authorization: { credentials_file: /etc/prometheus/app-metrics-token }
    static_configs: [{ targets: ["app-1:3000", "app-2:3000"] }]

groups:
  - name: app
    rules:
      - alert: BackgroundWorkStuck
        expr: max(app_queue_oldest_seconds{queue=~"notifications|automation|webhook_fanout|email"}) > 600
        for: 5m
        annotations: { summary: "A background queue has had an item waiting over 10 minutes. Is the worker running?" }
      - alert: WorkerNotTicking
        expr: max(app_worker_last_tick_age_seconds) > 300 or max(app_worker_last_tick_age_seconds) < 0
        for: 5m
      - alert: WorkerFailing
        expr: sum(increase(app_worker_ticks_total{outcome="failed"}[15m])) > 3
      - alert: ServerErrors
        expr: sum(rate(app_request_errors_total[5m])) > 0.05
        for: 10m
      - alert: DatabaseUnreachable
        expr: min(app_db_up) == 0
        for: 2m
      - alert: ApiSlow
        expr: histogram_quantile(0.95, sum by (le) (rate(app_api_request_duration_seconds_bucket[5m]))) > 2
        for: 10m
      - alert: WebhookBacklog
        expr: max(app_queue_depth{queue="webhook_deliveries"}) > 500
        for: 15m
```

A first dashboard needs six panels: queue depth by queue, oldest item by queue, worker last-tick age, server error rate, API p95, and assistant requests per hour. Add the load balancer's request rate, p95 and 5xx rate beside them.

## Health probes

| Endpoint | Use it for | Behaviour |
|---|---|---|
| `GET /api/health/live` | Liveness (restart the container when it fails) | Touches nothing. Fails only if the process can't answer |
| `GET /api/health` | Readiness (send traffic only when it passes) | 503 when the database or its schema is missing. `degraded` with a 200 when storage, Redis or the database role check fails: one feature is affected, the app still serves |

The readiness body names each check (`database`, `migrations`, `database_role`, `storage`, `redis`) as `ok`, `failing` or `not_configured`, and nothing else.

## Error tracking

Set `SENTRY_DSN` to send unhandled server errors and worker failures to Sentry or any service that accepts Sentry envelopes (GlitchTip, Bugsink). Events carry the error, its stack, the route pattern, the request id and the reference digest. They carry no user, no request body, no cookies and no concrete URL. `SENTRY_ENVIRONMENT` and `APP_RELEASE` tag them. Without a DSN, errors are in the log only. The adapter is `src/server/ops/error-tracking.ts`; another service is one class implementing `ErrorTracker`.

## What isn't built

- Distributed tracing (OpenTelemetry).
- Page latency metrics from inside the app (use the proxy's).
- Per-organization metrics: deliberately left out of the metrics endpoint; the platform admin console shows per-organization usage.
