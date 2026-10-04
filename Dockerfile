# syntax=docker/dockerfile:1.7
# Multi-stage build: deps → build → (migrator | runner)

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

# one-shot job: migrations, role sync, optional demo seed (has dev tooling)
FROM base AS migrator
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY src/server ./src/server
COPY src/config ./src/config
COPY src/lib ./src/lib
CMD ["sh", "-c", "npm run db:migrate && if [ \"$SEED_DEMO\" = \"true\" ]; then npm run db:seed; fi"]

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
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
