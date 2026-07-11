# Dockerfile for Veritrail console (web UI)
FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/console/package.json ./apps/console/
RUN pnpm install --frozen-lockfile --filter @veritrail/console

# Build
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @veritrail/console run build

# Production - serve with nginx
FROM nginx:alpine AS runner
COPY --from=builder /app/apps/console/dist /usr/share/nginx/html
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:80/ || exit 1

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
