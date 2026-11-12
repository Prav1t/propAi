// Production configuration safety (Iteration 13). Pure: takes the environment, returns what is unsafe (errors, which
// stop the server in production) and what an operator should know (warnings). `npm run config:check` prints the same.

export type ConfigReport = { errors: string[]; warnings: string[] };

const on = (v: string | undefined) => v === "true";
const local = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

export function configReport(e: Record<string, string | undefined>): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  // address
  let app: URL | null = null;
  try { app = new URL(e.APP_URL ?? ""); } catch { errors.push("APP_URL must be the public https:// address of the app."); }
  if (app && app.protocol !== "https:") errors.push(`APP_URL is ${app.protocol}// — production must be served over https (cookies are Secure, HSTS is sent).`);
  if (app && local(app.hostname)) errors.push("APP_URL points at this machine; links in emails and SSO redirects would not work for anyone else.");

  // switches that only exist for development and tests
  if (on(e.E2E_FAULTS)) errors.push("E2E_FAULTS=true lets requests trigger failures; remove it.");
  if (e.RATE_LIMITS === "relaxed") errors.push("RATE_LIMITS=relaxed turns off sign-in throttling; remove it.");
  if (on(e.WEBHOOK_ALLOW_PRIVATE_TARGETS)) errors.push("WEBHOOK_ALLOW_PRIVATE_TARGETS=true lets webhooks reach internal addresses; remove it.");
  if (on(e.PUSH_ALLOW_PRIVATE_TARGETS)) errors.push("PUSH_ALLOW_PRIVATE_TARGETS=true is for tests; remove it.");
  if (on(e.OIDC_ALLOW_HTTP_ISSUERS)) errors.push("OIDC_ALLOW_HTTP_ISSUERS=true is for local identity providers; remove it.");

  // database: the app must not connect as the role that owns the tables, or row-level security does nothing
  if (e.DATABASE_URL && e.MIGRATION_DATABASE_URL) {
    try {
      if (new URL(e.DATABASE_URL).username === new URL(e.MIGRATION_DATABASE_URL).username) {
        errors.push("DATABASE_URL and MIGRATION_DATABASE_URL use the same database user. The app must use its own role, or tenant isolation (RLS) is bypassed.");
      }
    } catch { /* DATABASE_URL shape is validated elsewhere */ }
  }
  if (e.DATABASE_URL && !/[?&]sslmode=(require|verify-ca|verify-full)/.test(e.DATABASE_URL)) {
    try {
      const h = new URL(e.DATABASE_URL).hostname;
      if (!local(h) && h.includes(".")) warnings.push("DATABASE_URL has no sslmode=require (or verify-full); the connection to a remote database may be unencrypted.");
    } catch { /* validated elsewhere */ }
  }

  // email: sign-up, password reset and invitations depend on it
  if ((e.MAIL_PROVIDER ?? "console") === "console") errors.push("MAIL_PROVIDER=console only writes emails to the log. Set smtp, resend or sendgrid so verification and reset emails are delivered.");
  if ((e.MAIL_FROM ?? "").includes("example.") || !e.MAIL_FROM) warnings.push("MAIL_FROM is not set to your own sending address.");

  // things that work, but not the way production usually wants
  if ((e.BILLING_PROVIDER ?? "mock") === "mock") {
    warnings.push(on(e.BILLING_ALLOW_MOCK)
      ? "BILLING_ALLOW_MOCK=true: plan changes are simulated and no one is charged."
      : "BILLING_PROVIDER is mock: self-serve plan changes are unavailable until Stripe is configured.");
  }
  if ((e.FILE_STORAGE ?? "local") === "local") warnings.push("FILE_STORAGE=local keeps uploads on this machine's disk: back that volume up, and use s3 before running more than one instance.");
  if (!e.REDIS_URL) warnings.push("REDIS_URL is not set: rate limits are per process, so they are weaker with more than one instance.");
  if (e.TRUSTED_PROXY_HOPS === undefined && !e.CLIENT_IP_HEADER && !on(e.TRUST_PROXY)) warnings.push("TRUSTED_PROXY_HOPS is not set: client addresses (rate limits, audit log) can't be trusted behind a proxy.");
  if (!e.VAPID_PUBLIC_KEY) warnings.push("VAPID keys are not set: push notifications are unavailable (npm run push:keys).");
  if (!e.AI_PROVIDER || e.AI_PROVIDER === "demo") warnings.push("AI_PROVIDER is not set: the assistant runs in its labelled demo mode (pattern matching, no language model).");
  if (on(e.SHOW_DEMO_ACCOUNTS)) warnings.push("SHOW_DEMO_ACCOUNTS=true lists the demo sign-ins on the sign-in page. Fine for a demo, never with customer data.");
  if (!e.METRICS_TOKEN) warnings.push("METRICS_TOKEN is not set: /api/metrics is turned off.");
  if (!e.SENTRY_DSN) warnings.push("SENTRY_DSN is not set: errors are only in the logs.");
  if (e.DISABLE_INPROCESS_WORKER !== "true") warnings.push("The background worker runs inside the web process. With more than one instance, set DISABLE_INPROCESS_WORKER=true and run `npm run worker` as its own service (workers take turns, so this is about efficiency, not correctness).");
  return { errors, warnings };
}
