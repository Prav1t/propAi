# Deployment

How to run [YOUR PRODUCT NAME] in production. Day-to-day running (backups, upgrades, incidents, key rotation) is in [`operations.md`](operations.md); logs, metrics and alerts are in [`observability.md`](observability.md); the security checklist is in [`security/production-checklist.md`](security/production-checklist.md).

**What has and hasn't been verified.** The production build, the standalone worker, the start-up safety check, health probes, metrics, backup and restore drill were all run and tested in the development environment. The Docker images and compose files were **not built or run**: the environment this was developed in has no Docker daemon. Both compose files pass `docker compose config`. Treat the first `docker compose up` as a test, on a machine that isn't production.

## What runs

| Piece | What it is | Notes |
|---|---|---|
| **App** | Next.js server (`runner` image, port 3000) | Stateless. Run two or more behind a load balancer for availability |
| **Worker** | `worker` image (`npm run worker`) | Notifications, SLA checks, automation, webhooks, indexing, billing, retention. Any number can run: they take turns |
| **Migrator** | `migrator` image, runs once per release | Applies migrations, syncs roles and permissions, grants the app role |
| **PostgreSQL 16** with `pgvector` | The only store of record | Two roles: an owner (migrations, backups) and the app role (limited by row-level security) |
| **Redis** | Shared rate limits | Optional with one app instance; needed with more |
| **Object storage** | S3-compatible bucket | Local disk works for one host; S3 is needed with more than one app instance |
| **Email** | SMTP, Resend or SendGrid | Required: sign-up, password reset and invitations depend on it |
| **Language model** | Anthropic, OpenAI or a compatible endpoint | Optional. Without one the assistant runs in its labelled demo mode |

The worker can also run inside the app process (the default when `DISABLE_INPROCESS_WORKER` isn't set). That is fine for one small instance. With a separate worker service, set `DISABLE_INPROCESS_WORKER=true` on the app.

## Single host with Docker Compose

`docker-compose.prod.yml` runs Caddy (TLS), the app, the worker, Postgres and Redis on one machine.

1. **A machine and a name.** A Linux host with Docker, ports 80 and 443 open, and a DNS record for your domain pointing at it. 2 vCPU and 4 GB of memory is a sensible minimum (see the load test in `operations.md`).
2. **Secrets.** Create `.env.production` next to the compose file. Never commit it.

   ```bash
   APP_DOMAIN=app.example.com
   POSTGRES_PASSWORD=...            # owner role: openssl rand -hex 24
   APP_DB_PASSWORD=...              # app role:   openssl rand -hex 24
   APP_ENCRYPTION_KEY=...           # openssl rand -base64 32   (back this up separately from the database)
   MAIL_PROVIDER=smtp
   SMTP_URL=smtps://user:pass@smtp.example.com:465
   MAIL_FROM="Your Company <no-reply@example.com>"
   METRICS_TOKEN=...                # openssl rand -hex 24   (optional: turns /api/metrics on)
   # optional: AI_PROVIDER / AI_MODEL / ANTHROPIC_API_KEY, BILLING_PROVIDER=stripe + STRIPE_*, VAPID_* (npm run push:keys),
   # FILE_STORAGE=s3 + S3_* + AWS_*, SENTRY_DSN
   ```
3. **Check the configuration** before starting anything: `docker compose -f docker-compose.prod.yml --env-file .env.production config -q`, and from a checkout with the same variables exported, `npm run config:check`.
4. **Start.** `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`. The `migrate` service runs first and must finish; the app and worker start after it; Caddy starts once the app is ready and fetches a certificate.
5. **Check.** `https://app.example.com/api/health` should say `"status":"ok"` with every check `ok`. Then register the first account: it becomes the administrator of the first organization.
6. **First platform administrator.** Platform administration (`/admin`) is for your own staff. Grant it in the database: `update users set is_platform_admin = true where email = '...'`, run as the owner role.
7. **Turn sign-up off** if you onboard customers yourself: `ALLOW_REGISTRATION=false`.
8. **Backups.** Schedule `npm run db:backup` (or your own `pg_dump`) and copy the files off the machine. See `operations.md`.

The demo data is never seeded by the production compose file. For a sales demo environment, run the development compose file (`docker-compose.yml`) on a separate machine or database.

## Managed cloud (reference layout)

The same three images run on any container platform (AWS ECS or App Runner, Google Cloud Run, Azure Container Apps, Fly.io, Render, Kubernetes).

- **Database:** managed PostgreSQL 16 with the `vector` extension, point-in-time recovery on, in a private network. Create the app role yourself (see `docker/postgres/init/01-app-role.sh`): `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`. `DATABASE_URL` uses the app role, `MIGRATION_DATABASE_URL` the owner. Add `?sslmode=require`.
- **Release step:** run the `migrator` image to completion before the new app version receives traffic (a pre-deploy job, an init container, or a release command). Migrations are forward-only and written to be safe while the previous version is still serving (see `operations.md`).
- **App:** two or more instances of the `runner` image. Liveness probe `/api/health/live`, readiness probe `/api/health`. Set `DISABLE_INPROCESS_WORKER=true`, `REDIS_URL`, `FILE_STORAGE=s3` and `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app (usually 1).
- **Worker:** one or two instances of the `worker` image, with a stop timeout of 40 seconds or more. More than one is for availability; they take turns, so two workers don't do twice the work.
- **Object storage:** a private bucket with versioning on and server-side encryption. The app signs short-lived download links; the bucket is never public.
- **Secrets:** from the platform's secret manager, not from files in the image.
- **TLS:** terminate at the load balancer. `APP_URL` must be the public `https://` address.

## Configuration safety check

In production the server and the worker refuse to start with an unsafe configuration, and say why. `npm run config:check` prints the same report without starting anything.

**Stops the start:**

- `APP_URL` isn't `https://`, or points at localhost;
- a development switch is on: `E2E_FAULTS`, `RATE_LIMITS=relaxed`, `WEBHOOK_ALLOW_PRIVATE_TARGETS`, `PUSH_ALLOW_PRIVATE_TARGETS`, `OIDC_ALLOW_HTTP_ISSUERS`;
- `MAIL_PROVIDER` is `console` (or unset): verification and reset emails would go nowhere;
- `DATABASE_URL` and `MIGRATION_DATABASE_URL` use the same database user: row-level security would be bypassed.

**Warns, and starts:** no `sslmode` on a remote database, `MAIL_FROM` not set, mock billing, local file storage, no Redis, no `TRUSTED_PROXY_HOPS`, no VAPID keys, no language model, demo accounts shown, no metrics token, no error tracking, worker inside the web process.

`ALLOW_INSECURE_PRODUCTION=true` turns the stop into a logged error. It exists to smoke-test a production build on a laptop (the development compose file sets it). Never set it on a real deployment.

The readiness probe also checks, at run time, that the app's database role is not a superuser, has no `BYPASSRLS` and doesn't own the tables. If it does, `/api/health` reports `database_role: failing`.

## Environment variables

`.env.example` is the reference: every variable, with what it does and its default. The ones a production deployment must set are `APP_URL`, `DATABASE_URL`, `MIGRATION_DATABASE_URL` (migrator only), `APP_ENCRYPTION_KEY`, `MAIL_PROVIDER` with its credentials, and `MAIL_FROM`.

## Rebranding before you show it to anyone

The product and assistant names are placeholders. Change them in one file, `src/config/brand.ts` (name, assistant name, short name, tagline, support email), replace the mark in `src/components/brand/logo.tsx` and the icons in `public/` (`npm run` → `node scripts/make-icons.mjs`), then rebuild.
