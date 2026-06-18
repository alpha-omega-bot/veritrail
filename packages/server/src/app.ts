import cors from '@fastify/cors';
import {
  ActionSchema,
  ActorSchema,
  BudgetSchema,
  CAPABILITIES,
  HmacSigner,
  MoneySchema,
  PolicySchema,
  createFileLedger,
  createInMemoryLedger,
  isEventType,
  validationError,
  type Actor,
  type EventQuery,
  type Ledger,
} from '@veritrail/core';
import type { PermissionsConfig } from '@veritrail/permissions';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  ApiKeyAuthenticator,
  parseAuthHeader,
  type ApiKeyPrincipal,
  type AuthConfig,
  type ServerRole,
} from './auth.js';
import { asNumber, asString, replyError, replyResult } from './http.js';
import {
  createRateLimitPreHandler,
  normalizeLimits,
  registerServerLimits,
  type RateLimitConfig,
  type ServerPreHandler,
  writeRouteConfig,
  type ServerLimitsConfig,
} from './limits.js';
import { createPlatform, type Platform } from './platform.js';

export interface BuildServerOptions {
  /** Inject a ledger (e.g. for tests). Takes precedence over `ledgerFile`. */
  ledger?: Ledger;
  /** Path to a durable JSONL ledger file. Falls back to in-memory if absent. */
  ledgerFile?: string;
  /** Enable HMAC signing of ledger records with this secret. */
  signerSecret?: string;
  /** Fastify logger (default off). */
  logger?: boolean;
  /** Enable permissive CORS (default true; restrict in production). */
  cors?: boolean;
  permissions?: PermissionsConfig;
  /**
   * API-key authentication. When omitted, the server preserves the v0.1
   * unauthenticated behavior for local development and tests.
   */
  auth?: AuthConfig;
  /** Request size, rate, and write backpressure controls. */
  limits?: ServerLimitsConfig;
}

const startedAt = Date.now();

const AuthorizeInputSchema = z
  .object({
    actorId: z.string().min(1),
    amount: MoneySchema,
    labels: z.record(z.string(), z.string()).optional(),
    actionId: z.string().optional(),
  })
  .strict();

function eventQueryFrom(raw: Record<string, unknown>): EventQuery {
  const query: EventQuery = {};
  const fromSeq = asNumber(raw['fromSeq']);
  if (fromSeq !== undefined) query.fromSeq = fromSeq;
  const toSeq = asNumber(raw['toSeq']);
  if (toSeq !== undefined) query.toSeq = toSeq;
  const actorId = asString(raw['actorId']);
  if (actorId !== undefined) query.actorId = actorId;
  const correlationId = asString(raw['correlationId']);
  if (correlationId !== undefined) query.correlationId = correlationId;
  const type = asString(raw['type']);
  if (type !== undefined && isEventType(type)) query.types = [type];
  const limit = asNumber(raw['limit']);
  if (limit !== undefined) query.limit = limit;
  return query;
}

/** Build (but do not start) the Veritrail HTTP server. */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  let ledger = options.ledger;
  if (!ledger) {
    const signer = options.signerSecret ? new HmacSigner(options.signerSecret) : undefined;
    const ledgerOpts = signer ? { signer } : {};
    ledger = options.ledgerFile
      ? await createFileLedger(options.ledgerFile, ledgerOpts)
      : createInMemoryLedger(ledgerOpts);
  }

  const platform = createPlatform(
    ledger,
    options.permissions !== undefined ? { permissions: options.permissions } : {},
  );

  const limits = normalizeLimits(options.limits);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: limits.bodyLimitBytes });
  registerServerLimits(app, limits);
  if (options.cors !== false) {
    await app.register(cors, { origin: true });
  }
  const authenticator = options.auth ? new ApiKeyAuthenticator(options.auth) : undefined;
  registerRoutes(app, platform, authenticator, limits.rateLimit);
  return app;
}

function registerRoutes(
  app: FastifyInstance,
  platform: Platform,
  authenticator: ApiKeyAuthenticator | undefined,
  rateLimitConfig: RateLimitConfig | false,
): void {
  const { ledger, audit, permissions, spendGuard, rollback, forensics, evidence } = platform;
  const { decisionMemory, vendorRisk } = platform;
  const auth = routeAuth(authenticator);
  const rateLimit = createRateLimitPreHandler(rateLimitConfig);
  const publicRoute = rateLimit ? { preHandler: [rateLimit] } : {};
  const preHandlers = (roles: readonly ServerRole[]): ServerPreHandler[] => [
    auth(roles),
    ...(rateLimit ? [rateLimit] : []),
  ];
  const readRoute = (roles: readonly ServerRole[]) => ({ preHandler: preHandlers(roles) });
  const writeRoute = (roles: readonly ServerRole[]) => ({
    preHandler: preHandlers(roles),
    config: writeRouteConfig(),
  });

  // ---- meta -------------------------------------------------------------
  app.get('/api', publicRoute, async () => ({
    name: 'veritrail-server',
    version: '0.1.0',
    capabilities: CAPABILITIES,
  }));

  app.get('/api/health', publicRoute, async () => ({
    status: 'ok',
    name: 'veritrail-server',
    version: '0.1.0',
    uptimeMs: Date.now() - startedAt,
  }));

  app.get('/api/ready', publicRoute, async (_request, reply) => {
    const count = await ledger.count();
    return reply.send({ ready: true, records: count });
  });

  // ---- raw ledger ingest ------------------------------------------------
  app.post('/api/events', writeRoute(['ingest']), async (request, reply) => {
    const result = await ledger.append(request.body);
    if (!result.ok) return replyError(reply, result.error);
    return reply.code(201).send({ record: result.value });
  });

  // ---- audit ------------------------------------------------------------
  app.get('/api/audit/events', readRoute(['operator']), async (request, reply) => {
    const records = await audit.search(eventQueryFrom(request.query as Record<string, unknown>));
    return reply.send(records);
  });

  app.get('/api/audit/events/:seq', readRoute(['operator']), async (request, reply) => {
    const seq = asNumber((request.params as Record<string, unknown>)['seq']);
    if (seq === undefined) return replyError(reply, validationError('seq must be a number'));
    const record = await audit.get(seq);
    return record ? reply.send(record) : reply.code(404).send({ error: { code: 'NOT_FOUND' } });
  });

  app.get('/api/audit/summary', readRoute(['operator']), async (_request, reply) =>
    reply.send(await audit.summary()),
  );

  app.get('/api/audit/verify', readRoute(['operator']), async (_request, reply) =>
    reply.send(await audit.verify()),
  );

  app.get('/api/audit/export', readRoute(['operator']), async (_request, reply) => {
    const ndjson = await audit.exportNdjson();
    return reply.header('content-type', 'application/x-ndjson').send(ndjson);
  });

  // ---- permissions ------------------------------------------------------
  app.get('/api/permissions/policies', readRoute(['operator']), async (_request, reply) =>
    reply.send(permissions.listPolicies()),
  );

  app.post('/api/permissions/policies', writeRoute(['admin']), async (request, reply) => {
    const candidate = withGeneratedId(request.body, 'pol', platform);
    const parsed = PolicySchema.safeParse(candidate);
    if (!parsed.success) return replyError(reply, validationError('invalid policy'));

    const audit = await recordAdminAction(platform, request.principal, {
      action: 'policy.upserted',
      targetType: 'policy',
      targetId: parsed.data.id,
      details: { effect: parsed.data.effect, name: parsed.data.name },
    });
    if (!audit.ok) {
      return replyError(reply, audit.error);
    }
    const result = permissions.addPolicy(parsed.data);
    return replyResult(reply, result);
  });

  app.delete('/api/permissions/policies/:id', writeRoute(['admin']), async (request, reply) => {
    const id = String((request.params as Record<string, unknown>)['id']);
    const existing = permissions.listPolicies().find((policy) => policy.id === id);
    if (!existing) return reply.code(404).send({ removed: false });
    const audit = await recordAdminAction(platform, request.principal, {
      action: 'policy.removed',
      targetType: 'policy',
      targetId: id,
    });
    if (!audit.ok) {
      return replyError(reply, audit.error);
    }
    permissions.removePolicy(id);
    return reply.send({ removed: true });
  });

  app.post('/api/permissions/evaluate', readRoute(['operator']), async (request, reply) => {
    const parsed = parseActionWithActor(request.body);
    if (!parsed.ok) return replyError(reply, parsed.error);
    return reply.send(permissions.evaluate(parsed.action, parsed.opts));
  });

  app.post('/api/permissions/enforce', writeRoute(['ingest']), async (request, reply) => {
    const parsed = parseActionWithActor(request.body);
    if (!parsed.ok) return replyError(reply, parsed.error);
    return replyResult(reply, await permissions.enforce(parsed.action, parsed.opts));
  });

  // ---- spend guard ------------------------------------------------------
  app.get('/api/spend/budgets', readRoute(['operator']), async (_request, reply) =>
    reply.send(spendGuard.listBudgets()),
  );

  app.post('/api/spend/budgets', writeRoute(['admin']), async (request, reply) => {
    const candidate = withGeneratedId(request.body, 'bud', platform);
    const parsed = BudgetSchema.safeParse(candidate);
    if (!parsed.success) return replyError(reply, validationError('invalid budget'));

    const audit = await recordAdminAction(platform, request.principal, {
      action: 'budget.upserted',
      targetType: 'budget',
      targetId: parsed.data.id,
      details: {
        name: parsed.data.name,
        scope: parsed.data.scope,
        limit: parsed.data.limit,
      },
    });
    if (!audit.ok) {
      return replyError(reply, audit.error);
    }
    const result = spendGuard.setBudget(parsed.data);
    return replyResult(reply, result);
  });

  app.get('/api/spend/status', readRoute(['operator']), async (_request, reply) =>
    reply.send(await spendGuard.status()),
  );

  app.post('/api/spend/charge', writeRoute(['ingest']), async (request, reply) => {
    const parsed = AuthorizeInputSchema.safeParse(request.body);
    if (!parsed.success) return replyError(reply, validationError('invalid charge input'));
    const { actorId, amount, labels, actionId } = parsed.data;
    return replyResult(
      reply,
      await spendGuard.charge({
        actorId,
        amount,
        ...(labels !== undefined ? { labels } : {}),
        ...(actionId !== undefined ? { actionId } : {}),
      }),
    );
  });

  // ---- decision memory --------------------------------------------------
  app.post('/api/decisions', writeRoute(['ingest']), async (request, reply) =>
    replyResult(reply, await decisionMemory.record(request.body)),
  );

  app.get('/api/decisions', readRoute(['operator']), async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const opts: { actorId?: string; limit?: number } = {};
    const actorId = asString(q['actorId']);
    if (actorId !== undefined) opts.actorId = actorId;
    const limit = asNumber(q['limit']);
    if (limit !== undefined) opts.limit = limit;
    return reply.send(await decisionMemory.list(opts));
  });

  app.get('/api/decisions/recall', readRoute(['operator']), async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const query: { text?: string; actorId?: string; limit?: number } = {};
    const text = asString(q['text']);
    if (text !== undefined) query.text = text;
    const actorId = asString(q['actorId']);
    if (actorId !== undefined) query.actorId = actorId;
    const limit = asNumber(q['limit']);
    if (limit !== undefined) query.limit = limit;
    return reply.send(await decisionMemory.recall(query));
  });

  // ---- evidence ---------------------------------------------------------
  app.post('/api/evidence', writeRoute(['ingest']), async (request, reply) =>
    replyResult(reply, await evidence.attach(request.body)),
  );

  app.get('/api/evidence', readRoute(['operator']), async (_request, reply) =>
    reply.send(await evidence.list()),
  );

  app.get('/api/evidence/:id/trace', readRoute(['operator']), async (request, reply) => {
    const id = String((request.params as Record<string, unknown>)['id']);
    return replyResult(reply, await evidence.trace(id));
  });

  app.post('/api/evidence/:id/verify', readRoute(['operator']), async (request, reply) => {
    const id = String((request.params as Record<string, unknown>)['id']);
    const content = (request.body as { content?: unknown })?.content;
    if (typeof content !== 'string') {
      return replyError(reply, validationError('content (string) is required'));
    }
    return replyResult(reply, await evidence.verifyContent(id, content));
  });

  // ---- vendor risk ------------------------------------------------------
  app.post('/api/vendors', writeRoute(['admin']), async (request, reply) =>
    replyResult(reply, await vendorRisk.register(request.body)),
  );

  app.get('/api/vendors', readRoute(['operator']), async (_request, reply) =>
    reply.send(await vendorRisk.listVendors()),
  );

  app.post('/api/vendors/signals', writeRoute(['ingest']), async (request, reply) =>
    replyResult(reply, await vendorRisk.recordSignal(request.body)),
  );

  app.get('/api/vendors/:id/signals', readRoute(['operator']), async (request, reply) => {
    const id = String((request.params as Record<string, unknown>)['id']);
    return reply.send(await vendorRisk.signalsFor(id));
  });

  app.get('/api/vendor-risk/assess', readRoute(['operator']), async (_request, reply) =>
    reply.send(await vendorRisk.assess()),
  );

  app.get('/api/vendor-risk/:id/score', readRoute(['operator']), async (request, reply) => {
    const id = String((request.params as Record<string, unknown>)['id']);
    return replyResult(reply, await vendorRisk.score(id));
  });

  // ---- forensics --------------------------------------------------------
  app.get('/api/forensics/incident', readRoute(['operator']), async (request, reply) => {
    const correlationId = asString((request.query as Record<string, unknown>)['correlationId']);
    if (correlationId === undefined) {
      return replyError(reply, validationError('correlationId is required'));
    }
    return reply.send(await forensics.incident(correlationId));
  });

  app.get('/api/forensics/timeline', readRoute(['operator']), async (request, reply) => {
    const entries = await forensics.timeline(
      eventQueryFrom(request.query as Record<string, unknown>),
    );
    return reply.send(entries);
  });

  app.get('/api/forensics/cause/:causationId', readRoute(['operator']), async (request, reply) => {
    const id = String((request.params as Record<string, unknown>)['causationId']);
    return reply.send(await forensics.causeChain(id));
  });

  // ---- rollback ---------------------------------------------------------
  app.post(
    '/api/rollback/plan/action/:actionId',
    readRoute(['operator']),
    async (request, reply) => {
      const id = String((request.params as Record<string, unknown>)['actionId']);
      return replyResult(reply, await rollback.planForAction(id));
    },
  );

  app.get(
    '/api/rollback/plan/correlation/:correlationId',
    readRoute(['operator']),
    async (request, reply) => {
      const id = String((request.params as Record<string, unknown>)['correlationId']);
      return reply.send(await rollback.planForCorrelation(id));
    },
  );

  app.post('/api/rollback/execute', writeRoute(['operator']), async (request, reply) => {
    const plan = (request.body as { plan?: unknown })?.plan;
    if (plan === null || typeof plan !== 'object') {
      return replyError(reply, validationError('plan is required'));
    }
    return reply.send(await rollback.execute(plan as Parameters<typeof rollback.execute>[0]));
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: ApiKeyPrincipal;
  }
}

interface AdminActionInput {
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string;
  readonly details?: Record<string, unknown>;
}

function routeAuth(authenticator: ApiKeyAuthenticator | undefined) {
  return (requiredRoles: readonly ServerRole[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!authenticator) return;
      const rawSecret =
        parseAuthHeader(request.headers.authorization) ??
        parseAuthHeader(request.headers['x-veritrail-api-key']);
      const result = authenticator.authenticate(rawSecret, requiredRoles);
      if (result.ok) {
        request.principal = result.principal;
        return;
      }
      const status = result.failure.reason === 'forbidden' ? 403 : 401;
      return reply.code(status).send({ error: result.failure.error.toJSON() });
    };
}

async function recordAdminAction(
  platform: Platform,
  principal: ApiKeyPrincipal | undefined,
  input: AdminActionInput,
): ReturnType<Platform['ledger']['append']> {
  const actorId = principal?.actorId ?? 'server';
  return platform.ledger.append({
    type: 'admin.action',
    actorId,
    payload: {
      action: input.action,
      targetType: input.targetType,
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
    },
  });
}

function withGeneratedId(input: unknown, prefix: string, platform: Platform): unknown {
  if (input === null || typeof input !== 'object') return input;
  const record = input as Record<string, unknown>;
  if ('id' in record) return input;
  return { ...record, id: platform.ctx.ids.next(prefix) };
}

type ParsedActionWithActor =
  | { ok: true; action: ReturnType<typeof ActionSchema.parse>; opts: { actor?: Actor } }
  | { ok: false; error: ReturnType<typeof validationError> };

function parseActionWithActor(body: unknown): ParsedActionWithActor {
  const input = body as { action?: unknown; actor?: unknown };
  const action = ActionSchema.safeParse(input?.action);
  if (!action.success) return { ok: false, error: validationError('invalid action') };
  const opts: { actor?: Actor } = {};
  if (input?.actor !== undefined) {
    const actor = ActorSchema.safeParse(input.actor);
    if (!actor.success) return { ok: false, error: validationError('invalid actor') };
    opts.actor = actor.data;
  }
  return { ok: true, action: action.data, opts };
}
