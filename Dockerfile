# syntax=docker/dockerfile:1.7
# Multi-stage build: deps → build → runner (web), and deps → tools → (migrator | worker)

FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# tools image: the full source and dependencies, for jobs that run TypeScript directly
FROM base AS tools
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app --create-home app
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json tsconfig.json drizzle.config.ts ./
COPY --chown=app:app drizzle ./drizzle
COPY --chown=app:app scripts ./scripts
COPY --chown=app:app src ./src
RUN mkdir -p /app/.data/uploads && chown -R app:app /app/.data
USER app

# one-shot release job: migrations, role sync, optional demo seed. Run it to completion before the new app version
# takes traffic (docker compose does this with depends_on; elsewhere make it a release/pre-deploy step).
FROM tools AS migrator
CMD ["sh", "-c", "npm run db:migrate && if [ \"$SEED_DEMO\" = \"true\" ]; then npm run db:seed; fi"]

# background worker as its own service (set DISABLE_INPROCESS_WORKER=true on the app). Stops cleanly on SIGTERM:
# give it a stop grace period above WORKER_SHUTDOWN_GRACE_MS (25 s by default).
FROM tools AS worker
ENV NODE_ENV=production
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "--conditions=react-server", "scripts/worker.ts"]

# minimal runtime: Next.js standalone server as a non-root user
FROM base AS runner
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 app && useradd --system --uid 1001 --gid app app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
# local attachment storage (FILE_STORAGE=local); mount a volume here, or use FILE_STORAGE=s3
RUN mkdir -p /app/.data/uploads && chown -R app:app /app/.data
USER app
EXPOSE 3000
# liveness only: a database outage must not make the orchestrator restart healthy instances (readiness: /api/health)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
