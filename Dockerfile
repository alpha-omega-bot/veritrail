# Multi-stage build for Veritrail server
FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Dependencies stage
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/server/package.json ./packages/server/
COPY packages/relational-store/package.json ./packages/relational-store/
COPY packages/provider-signers/package.json ./packages/provider-signers/
COPY packages/provider-monitors/package.json ./packages/provider-monitors/
COPY packages/modules/audit/package.json ./packages/modules/audit/
COPY packages/modules/permissions/package.json ./packages/modules/permissions/
COPY packages/modules/spend-guard/package.json ./packages/modules/spend-guard/
COPY packages/modules/rollback/package.json ./packages/modules/rollback/
COPY packages/modules/forensics/package.json ./packages/modules/forensics/
COPY packages/modules/evidence/package.json ./packages/modules/evidence/
COPY packages/modules/decision-memory/package.json ./packages/modules/decision-memory/
COPY packages/modules/vendor-risk/package.json ./packages/modules/vendor-risk/
RUN pnpm install --frozen-lockfile --prod=false

# Build stage
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build && \
    pnpm --filter @veritrail/server... --prod deploy pruned

# Production stage
FROM node:20-alpine AS runner
RUN apk add --no-cache tini
WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S veritrail && \
    adduser -S veritrail -u 1001

# Copy built application
COPY --from=builder --chown=veritrail:veritrail /app/pruned ./

# Create data directory for ledger
RUN mkdir -p /data && chown veritrail:veritrail /data

USER veritrail

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8787/api/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 8787
VOLUME ["/data"]

ENV NODE_ENV=production
ENV VERITRAIL_LEDGER_PATH=/data/veritrail-ledger.jsonl
ENV VERITRAIL_PORT=8787

# Use tini as init system
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "packages/server/dist/main.js"]
