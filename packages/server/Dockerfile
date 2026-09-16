# ──────────────────────────────────────────────
# PeerGrid API Server — production Dockerfile
# Multi-stage: install → build → runtime
# ──────────────────────────────────────────────

# ── Stage 1: base ───────────────────────────────
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# ── Stage 2: install ALL deps (dev + prod) ──────
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile

# ── Stage 3: build ──────────────────────────────
FROM deps AS build
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
RUN pnpm --filter @collab/shared build \
 && pnpm --filter server build

# ── Stage 4: production deps only ───────────────
FROM base AS prod-deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod

# ── Stage 5: runtime ────────────────────────────
FROM node:20-alpine AS runtime
RUN addgroup -g 1001 -S peergrid && adduser -S peergrid -u 1001 -G peergrid
WORKDIR /app

# Copy production node_modules (no devDeps)
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/server/node_modules ./packages/server/node_modules

# Copy built artefacts
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json

# Copy workspace root files needed by pnpm / node resolution
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Copy migrations (needed at runtime for db:migrate)
COPY --from=build /app/packages/server/src/db/migrations ./packages/server/src/db/migrations
COPY --from=build /app/packages/server/src/db/migrate.mjs ./packages/server/src/db/migrate.mjs

ENV NODE_ENV=production
USER peergrid
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
