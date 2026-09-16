# ──────────────────────────────────────────────
# PeerGrid Client — production Dockerfile
# Multi-stage: install → vite build → nginx serve
# ──────────────────────────────────────────────

# ── Stage 1: install & build ────────────────────
FROM node:20-alpine AS build
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

# Install dependencies (layer cached)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/shared/ packages/shared/
COPY packages/client/ packages/client/
RUN pnpm --filter @collab/shared build \
 && pnpm --filter client build

# ── Stage 2: nginx runtime ─────────────────────
FROM nginx:1.27-alpine AS runtime

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy built static assets
COPY --from=build /app/packages/client/dist /usr/share/nginx/html

# Copy production nginx config
COPY packages/client/nginx.conf /etc/nginx/conf.d/default.conf

# Non-root user for nginx
RUN chown -R nginx:nginx /usr/share/nginx/html \
 && chown -R nginx:nginx /var/cache/nginx \
 && chown -R nginx:nginx /var/log/nginx \
 && touch /var/run/nginx.pid \
 && chown nginx:nginx /var/run/nginx.pid

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
