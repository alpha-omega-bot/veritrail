import { createHash } from 'node:crypto';

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ApiKeyPrincipal } from './auth.js';

export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
export const DEFAULT_RATE_LIMIT_MAX = 600;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_MAX_IN_FLIGHT_WRITES = 32;

export interface RateLimitConfig {
  readonly max?: number;
  readonly windowMs?: number;
}

export interface ServerLimitsConfig {
  /** Maximum accepted request body size in bytes. */
  readonly bodyLimitBytes?: number;
  /** Fixed-window request rate limit. Set to `false` to disable. */
  readonly rateLimit?: RateLimitConfig | false;
  /** Maximum concurrent write-route handlers. Set to `false` to disable. */
  readonly maxInFlightWrites?: number | false;
}

export type ServerPreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

interface NormalizedLimits {
  readonly bodyLimitBytes: number;
  readonly rateLimit: NormalizedRateLimitConfig | false;
  readonly maxInFlightWrites: number | false;
}

interface NormalizedRateLimitConfig {
  readonly max: number;
  readonly windowMs: number;
}

interface RateBucket {
  windowStartedAt: number;
  count: number;
}

const WRITE_ROUTE_CONFIG_KEY = 'veritrailWrite';
const BODY_TOO_LARGE = 'FST_ERR_CTP_BODY_TOO_LARGE';

const PositiveIntegerSchema = z.number().int().safe().positive();
const RateLimitConfigSchema = z
  .object({
    max: PositiveIntegerSchema.optional(),
    windowMs: PositiveIntegerSchema.optional(),
  })
  .strict();
const ServerLimitsConfigSchema = z
  .object({
    bodyLimitBytes: PositiveIntegerSchema.optional(),
    rateLimit: z.union([z.literal(false), RateLimitConfigSchema]).optional(),
    maxInFlightWrites: z.union([z.literal(false), PositiveIntegerSchema]).optional(),
  })
  .strict();

export function normalizeLimits(config: ServerLimitsConfig = {}): NormalizedLimits {
  const parsed = ServerLimitsConfigSchema.parse(config);
  const rateLimit = parsed.rateLimit;
  return {
    bodyLimitBytes: parsed.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    rateLimit:
      rateLimit === false
        ? false
        : {
            max: rateLimit?.max ?? DEFAULT_RATE_LIMIT_MAX,
            windowMs: rateLimit?.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
          },
    maxInFlightWrites:
      parsed.maxInFlightWrites === false
        ? false
        : (parsed.maxInFlightWrites ?? DEFAULT_MAX_IN_FLIGHT_WRITES),
  };
}

export function registerServerLimits(app: FastifyInstance, config: ServerLimitsConfig = {}): void {
  const limits = normalizeLimits(config);
  registerBodyLimitError(app);
  if (limits.maxInFlightWrites !== false) registerWriteBackpressure(app, limits.maxInFlightWrites);
}

export function createRateLimitPreHandler(
  config: RateLimitConfig | false,
): ServerPreHandler | undefined {
  if (config === false) return undefined;
  const max = config.max ?? DEFAULT_RATE_LIMIT_MAX;
  const windowMs = config.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const buckets = new Map<string, RateBucket>();

  return async (request, reply) => {
    const now = Date.now();
    const key = rateLimitKey(request);
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt >= windowMs) {
      buckets.set(key, { windowStartedAt: now, count: 1 });
      return;
    }
    bucket.count += 1;
    if (bucket.count <= max) return;

    const retryAfterMs = Math.max(1, windowMs - (now - bucket.windowStartedAt));
    return sendRateLimited(reply, retryAfterMs);
  };
}

export function writeRouteConfig(): Record<string, true> {
  return { [WRITE_ROUTE_CONFIG_KEY]: true };
}

export function isWriteRoute(request: FastifyRequest): boolean {
  return (
    (request.routeOptions.config as unknown as Record<string, unknown>)[WRITE_ROUTE_CONFIG_KEY] ===
    true
  );
}

function registerBodyLimitError(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    if (error.code === BODY_TOO_LARGE) {
      return reply.code(413).send({
        error: {
          name: 'VeritrailError',
          code: 'VALIDATION',
          message: 'request body is too large',
        },
      });
    }
    throw error;
  });
}

function registerWriteBackpressure(app: FastifyInstance, maxInFlightWrites: number): void {
  let inFlight = 0;

  app.addHook('preHandler', async (request, reply) => {
    if (!isWriteRoute(request)) return;
    if (inFlight >= maxInFlightWrites) {
      return reply
        .code(503)
        .header('retry-after', '1')
        .send({
          error: {
            name: 'VeritrailError',
            code: 'STORAGE',
            message: 'server write capacity is saturated',
          },
        });
    }
    inFlight += 1;
    request.writeSlotAcquired = true;
  });

  app.addHook('onResponse', async (request) => {
    if (!request.writeSlotAcquired) return;
    inFlight -= 1;
    request.writeSlotAcquired = false;
  });

  app.addHook('onError', async (request) => {
    if (!request.writeSlotAcquired) return;
    inFlight -= 1;
    request.writeSlotAcquired = false;
  });
}

function sendRateLimited(reply: FastifyReply, retryAfterMs: number): FastifyReply {
  return reply
    .code(429)
    .header('retry-after', String(Math.ceil(retryAfterMs / 1000)))
    .send({
      error: {
        name: 'VeritrailError',
        code: 'VALIDATION',
        message: 'rate limit exceeded',
        details: { retryAfterMs },
      },
    });
}

function rateLimitKey(request: FastifyRequest): string {
  if (request.principal) {
    return `principal:${request.principal.id}`;
  }
  return `ip:${createHash('sha256').update(request.ip, 'utf8').digest('hex')}`;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: ApiKeyPrincipal;
    writeSlotAcquired?: boolean;
  }
}
