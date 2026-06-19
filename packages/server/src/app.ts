import cors from '@fastify/cors';
import {
  ActionSchema,
  ActorSchema,
  BudgetSchema,
  CAPABILITIES,
  EventInputSchema,
  HmacSigner,
  MoneySchema,
  PolicySchema,
  asJson,
  createFileLedger,
  createInMemoryLedger,
  isEventType,
  validationError,
  type Actor,
  type Clock,
  type JsonObject,
  type IdGenerator,
  type EventInput,
  type EventQuery,
  type LedgerRecord,
  type Ledger,
  type JsonValue,
} from '@veritrail/core';
import type { PermissionsConfig } from '@veritrail/permissions';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z, type ZodError } from 'zod';

import {
  ApiKeyAuthenticator,
  adminActionSignatureDetails,
  parseAuthHeader,
  type AdminActionSignatureReceipt,
  type ApiKeyPrincipal,
  type AuthConfig,
  type RouteAccess,
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
  /** Clock for platform-level request checks and module context. */
  clock?: Clock;
  /** Id generator for module-created policy/budget/evidence/etc ids. */
  ids?: IdGenerator;
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

const QueryNonNegativeIntegerSchema = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .min(1)
      .regex(/^\d+$/)
      .transform((value) => Number(value)),
  ])
  .pipe(z.number().finite().int().safe().nonnegative());

type QueryParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReturnType<typeof validationError> };

function eventQueryFrom(raw: Record<string, unknown>): QueryParseResult<EventQuery> {
  const query: EventQuery = {};
  const fromSeq = asNumber(raw['fromSeq']);
  if (fromSeq !== undefined) query.fromSeq = fromSeq;
  const toSeq = asNumber(raw['toSeq']);
  if (toSeq !== undefined) query.toSeq = toSeq;
  const actorId = asString(raw['actorId']);
  if (actorId !== undefined) query.actorId = actorId;
  const correlationId = asString(raw['correlationId']);
  if (correlationId !== undefined) query.correlationId = correlationId;
  const labels = labelsFrom(raw);
  if (!labels.ok) return labels;
  if (labels.value !== undefined) query.labels = labels.value;
  const type = asString(raw['type']);
  if (type !== undefined && isEventType(type)) query.types = [type];
  const limit = parseOptionalLimit(raw['limit']);
  if (!limit.ok) return limit;
  if (limit.value !== undefined) query.limit = limit.value;
  return { ok: true, value: query };
}

function parseOptionalLimit(raw: unknown): QueryParseResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  const parsed = QueryNonNegativeIntegerSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: validationError('limit must be a non-negative integer') };
  }
  return { ok: true, value: parsed.data };
}

function labelsFrom(
  raw: Record<string, unknown>,
): QueryParseResult<Record<string, string> | undefined> {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('label.')) continue;
    const labelKey = key.slice('label.'.length);
    if (labelKey.length === 0 || typeof value !== 'string') {
      return { ok: false, error: validationError('query labels must be non-empty strings') };
    }
    labels[labelKey] = value;
  }
  return { ok: true, value: Object.keys(labels).length > 0 ? labels : undefined };
}

/** Build (but do not start) the Veritrail HTTP server. */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  let ledger = options.ledger;
  if (!ledger) {
    const signer = options.signerSecret ? new HmacSigner(options.signerSecret) : undefined;
    const ledgerOpts = {
      ...(signer !== undefined ? { signer } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      ...(options.ids !== undefined ? { ids: options.ids } : {}),
    };
    ledger = options.ledgerFile
      ? await createFileLedger(options.ledgerFile, ledgerOpts)
      : createInMemoryLedger(ledgerOpts);
  }

  const platform = createPlatform(ledger, {
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.ids !== undefined ? { ids: options.ids } : {}),
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
  });

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
  const auth = routeAuth(authenticator, platform);
  const rateLimit = createRateLimitPreHandler(rateLimitConfig);
  const publicRoute = rateLimit ? { preHandler: [rateLimit] } : {};
  const preHandlers = (access: RouteAccess | readonly ServerRole[]): ServerPreHandler[] => [
    auth(access),
    ...(rateLimit ? [rateLimit] : []),
  ];
  const readRoute = (access: RouteAccess | readonly ServerRole[]) => ({
    preHandler: preHandlers(access),
  });
  const writeRoute = (access: RouteAccess | readonly ServerRole[]) => ({
    preHandler: preHandlers(access),
    config: writeRouteConfig(),
  });
  const auditRead: RouteAccess = { roles: ['operator'], scope: 'audit:read' };
  const permissionsRead: RouteAccess = { roles: ['operator'], scope: 'permissions:read' };
  const spendRead: RouteAccess = { roles: ['operator'], scope: 'spend:read' };
  const decisionsRead: RouteAccess = { roles: ['operator'], scope: 'decisions:read' };
  const evidenceRead: RouteAccess = { roles: ['operator'], scope: 'evidence:read' };
  const vendorRiskRead: RouteAccess = { roles: ['operator'], scope: 'vendor-risk:read' };
  const forensicsRead: RouteAccess = { roles: ['operator'], scope: 'forensics:read' };
  const rollbackRead: RouteAccess = { roles: ['operator'], scope: 'rollback:read' };
  const rollbackExecute: RouteAccess = { roles: ['operator'], scope: 'rollback:execute' };

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
    const scoped = eventForPrincipalScope(request.body, request.principal);
    if (!scoped.ok) return replyError(reply, scoped.error);
    const result = await ledger.append(scoped.value);
    if (!result.ok) return replyError(reply, result.error);
    return reply.code(201).send({ record: result.value });
  });

  // ---- audit ------------------------------------------------------------
  app.get('/api/audit/events', readRoute(auditRead), async (request, reply) => {
    const query = eventQueryFrom(request.query as Record<string, unknown>);
    if (!query.ok) return replyError(reply, query.error);
    const scoped = scopedEventQuery(query.value, request.principal);
    if (!scoped.ok) return replyError(reply, scoped.error);
    const records = await audit.search(scoped.value);
    return reply.send(records);
  });

  app.get('/api/audit/events/:seq', readRoute(auditRead), async (request, reply) => {
    const seq = asNumber((request.params as Record<string, unknown>)['seq']);
    if (seq === undefined) return replyError(reply, validationError('seq must be a number'));
    const record = await audit.get(seq);
    if (record !== null && !recordInPrincipalScope(record, request.principal)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    }
    return record ? reply.send(record) : reply.code(404).send({ error: { code: 'NOT_FOUND' } });
  });

  app.get('/api/audit/summary', readRoute(auditRead), async (request, reply) => {
    if (isLabelScoped(request.principal)) return replyScopedRouteDenied(reply);
    return reply.send(await audit.summary());
  });

  app.get('/api/audit/verify', readRoute(auditRead), async (request, reply) => {
    if (isLabelScoped(request.principal)) return replyScopedRouteDenied(reply);
    return reply.send(await audit.verify());
  });

  app.get('/api/audit/export', readRoute(auditRead), async (request, reply) => {
    if (isLabelScoped(request.principal)) return replyScopedRouteDenied(reply);
    const ndjson = await audit.exportNdjson();
    return reply.header('content-type', 'application/x-ndjson').send(ndjson);
  });

  // ---- permissions ------------------------------------------------------
  app.get('/api/permissions/policies', readRoute(permissionsRead), async (_request, reply) =>
    reply.send(permissions.listPolicies()),
  );

  app.post('/api/permissions/policies', writeRoute(['admin']), async (request, reply) => {
    const candidate = withGeneratedId(request.body, 'pol', platform);
    const parsed = PolicySchema.safeParse(candidate);
    if (!parsed.success) return replyError(reply, validationError('invalid policy'));
    const signature = verifyAdminActionRequest(authenticator, platform, request);
    if (!signature.ok) return replyError(reply, signature.error);

    const audit = await recordAdminAction(platform, request.principal, {
      action: 'policy.upserted',
      targetType: 'policy',
      targetId: parsed.data.id,
      details: { effect: parsed.data.effect, name: parsed.data.name },
      ...(signature.value !== undefined ? { signature: signature.value } : {}),
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
    const signature = verifyAdminActionRequest(authenticator, platform, request);
    if (!signature.ok) return replyError(reply, signature.error);
    const audit = await recordAdminAction(platform, request.principal, {
      action: 'policy.removed',
      targetType: 'policy',
      targetId: id,
      ...(signature.value !== undefined ? { signature: signature.value } : {}),
    });
    if (!audit.ok) {
      return replyError(reply, audit.error);
    }
    permissions.removePolicy(id);
    return reply.send({ removed: true });
  });

  app.post('/api/permissions/evaluate', readRoute(permissionsRead), async (request, reply) => {
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
  app.get('/api/spend/budgets', readRoute(spendRead), async (request, reply) => {
    if (isLabelScoped(request.principal)) return replyScopedRouteDenied(reply);
    return reply.send(spendGuard.listBudgets());
  });

  app.post('/api/spend/budgets', writeRoute(['admin']), async (request, reply) => {
    const candidate = withGeneratedId(request.body, 'bud', platform);
    const parsed = BudgetSchema.safeParse(candidate);
    if (!parsed.success) return replyError(reply, validationError('invalid budget'));
    const signature = verifyAdminActionRequest(authenticator, platform, request);
    if (!signature.ok) return replyError(reply, signature.error);

    const audit = await recordAdminAction(platform, request.principal, {
      action: 'budget.upserted',
      targetType: 'budget',
      targetId: parsed.data.id,
      details: {
        name: parsed.data.name,
        scope: parsed.data.scope,
        limit: parsed.data.limit,
      },
      ...(signature.value !== undefined ? { signature: signature.value } : {}),
    });
    if (!audit.ok) {
      return replyError(reply, audit.error);
    }
    const result = spendGuard.setBudget(parsed.data);
    return replyResult(reply, result);
  });

  app.get('/api/spend/status', readRoute(spendRead), async (request, reply) => {
    if (isLabelScoped(request.principal)) return replyScopedRouteDenied(reply);
    return reply.send(await spendGuard.status());
  });

  app.post('/api/spend/charge', writeRoute(['ingest']), async (request, reply) => {
    const parsed = AuthorizeInputSchema.safeParse(request.body);
    if (!parsed.success) return replyError(reply, validationError('invalid charge input'));
    const { actorId, amount, labels, actionId } = parsed.data;
    const scoped = labelsForPrincipalScope(labels, request.principal);
    if (!scoped.ok) return replyError(reply, scoped.error);
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

  app.get('/api/decisions', readRoute(decisionsRead), async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const opts: { actorId?: string; limit?: number } = {};
    const actorId = asString(q['actorId']);
    if (actorId !== undefined) opts.actorId = actorId;
    const limit = parseOptionalLimit(q['limit']);
    if (!limit.ok) return replyError(reply, limit.error);
    if (limit.value !== undefined) opts.limit = limit.value;
    return reply.send(await decisionMemory.list(opts));
  });

  app.get('/api/decisions/recall', readRoute(decisionsRead), async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const query: { text?: string; actorId?: string; limit?: number } = {};
    const text = asString(q['text']);
    if (text !== undefined) query.text = text;
    const actorId = asString(q['actorId']);
    if (actorId !== undefined) query.actorId = actorId;
    const limit = parseOptionalLimit(q['limit']);
    if (!limit.ok) return replyError(reply, limit.error);
    if (limit.value !== undefined) query.limit = limit.value;
    return reply.send(await decisionMemory.recall(query));
  });

  // ---- evidence ---------------------------------------------------------
  app.post('/api/evidence', writeRoute(['ingest']), async (request, reply) =>
    replyResult(reply, await evidence.attach(request.body)),
  );

  app.get('/api/evidence', readRoute(evidenceRead), async (_request, reply) =>
    reply.send(await evidence.list()),
  );

  app.get('/api/evidence/:id/trace', readRoute(evidenceRead), async (request, reply) => {
    const id = String((request.params as Record<string, unknown>)['id']);
    return replyResult(reply, await evidence.trace(id));
  });

  app.post('/api/evidence/:id/verify', readRoute(evidenceRead), async (request, reply) => {
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

  app.get('/api/vendors', readRoute(vendorRiskRead), async (_request, reply) =>
    reply.send(await vendorRisk.listVendors()),
  );

  app.post('/api/vendors/signals', writeRoute(['ingest']), async (request, reply) =>
    replyResult(reply, await vendorRisk.recordSignal(request.body)),
  );

  app.get('/api/vendors/:id/signals', readRoute(vendorRiskRead), async (request, reply) => {
    const id = String((request.params as Record<string, unknown>)['id']);
    return reply.send(await vendorRisk.signalsFor(id));
  });

  app.get('/api/vendor-risk/assess', readRoute(vendorRiskRead), async (_request, reply) =>
    reply.send(await vendorRisk.assess()),
  );

  app.get('/api/vendor-risk/:id/score', readRoute(vendorRiskRead), async (request, reply) => {
    const id = String((request.params as Record<string, unknown>)['id']);
    return replyResult(reply, await vendorRisk.score(id));
  });

  // ---- forensics --------------------------------------------------------
  app.get('/api/forensics/incident', readRoute(forensicsRead), async (request, reply) => {
    if (isLabelScoped(request.principal)) return replyScopedRouteDenied(reply);
    const correlationId = asString((request.query as Record<string, unknown>)['correlationId']);
    if (correlationId === undefined) {
      return replyError(reply, validationError('correlationId is required'));
    }
    return reply.send(await forensics.incident(correlationId));
  });

  app.get('/api/forensics/timeline', readRoute(forensicsRead), async (request, reply) => {
    const query = eventQueryFrom(request.query as Record<string, unknown>);
    if (!query.ok) return replyError(reply, query.error);
    const scoped = scopedEventQuery(query.value, request.principal);
    if (!scoped.ok) return replyError(reply, scoped.error);
    const entries = await forensics.timeline(scoped.value);
    return reply.send(entries);
  });

  app.get('/api/forensics/cause/:causationId', readRoute(forensicsRead), async (request, reply) => {
    if (isLabelScoped(request.principal)) return replyScopedRouteDenied(reply);
    const id = String((request.params as Record<string, unknown>)['causationId']);
    return reply.send(await forensics.causeChain(id));
  });

  // ---- rollback ---------------------------------------------------------
  app.post(
    '/api/rollback/plan/action/:actionId',
    readRoute(rollbackRead),
    async (request, reply) => {
      const id = String((request.params as Record<string, unknown>)['actionId']);
      return replyResult(reply, await rollback.planForAction(id));
    },
  );

  app.get(
    '/api/rollback/plan/correlation/:correlationId',
    readRoute(rollbackRead),
    async (request, reply) => {
      const id = String((request.params as Record<string, unknown>)['correlationId']);
      return reply.send(await rollback.planForCorrelation(id));
    },
  );

  app.post('/api/rollback/execute', writeRoute(rollbackExecute), async (request, reply) => {
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
  readonly signature?: AdminActionSignatureReceipt;
}

type AdminActionSignatureParseResult =
  | { ok: true; value: AdminActionSignatureReceipt | undefined }
  | { ok: false; error: ReturnType<typeof validationError> };

function routeAuth(authenticator: ApiKeyAuthenticator | undefined, platform: Platform) {
  return (access: RouteAccess | readonly ServerRole[]) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!authenticator) return;
      const rawSecret =
        parseAuthHeader(request.headers.authorization) ??
        parseAuthHeader(request.headers['x-veritrail-api-key']);
      const result = await authenticator.authenticate(rawSecret, access, platform.ctx.clock.now());
      if (result.ok) {
        request.principal = result.principal;
        return;
      }
      const status = result.failure.reason === 'forbidden' ? 403 : 401;
      return reply.code(status).send({ error: result.failure.error.toJSON() });
    };
}

function isLabelScoped(principal: ApiKeyPrincipal | undefined): boolean {
  return principal?.labelScope !== undefined;
}

function replyScopedRouteDenied(reply: FastifyReply): FastifyReply {
  return replyError(reply, validationError('route requires an unscoped API key'));
}

function recordInPrincipalScope(
  record: LedgerRecord,
  principal: ApiKeyPrincipal | undefined,
): boolean {
  const labelScope = principal?.labelScope;
  if (labelScope === undefined) return true;
  return Object.entries(labelScope).every(([key, value]) => record.event.labels[key] === value);
}

function scopedEventQuery(
  query: EventQuery,
  principal: ApiKeyPrincipal | undefined,
): QueryParseResult<EventQuery> {
  const labelScope = principal?.labelScope;
  if (labelScope === undefined) return { ok: true, value: query };

  const labels = { ...(query.labels ?? {}) };
  for (const [key, value] of Object.entries(labelScope)) {
    const requested = labels[key];
    if (requested !== undefined && requested !== value) {
      return { ok: false, error: validationError('query label is outside API key scope') };
    }
    labels[key] = value;
  }

  return { ok: true, value: { ...query, labels } };
}

function eventForPrincipalScope(
  input: unknown,
  principal: ApiKeyPrincipal | undefined,
): QueryParseResult<EventInput> {
  const parsed = EventInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: validationError('event failed validation', { issues: zodIssues(parsed.error) }),
    };
  }

  const labelScope = principal?.labelScope;
  if (labelScope === undefined) return { ok: true, value: parsed.data };

  for (const [key, value] of Object.entries(labelScope)) {
    if (parsed.data.labels[key] !== value) {
      return { ok: false, error: validationError('event labels are outside API key scope') };
    }
  }

  return { ok: true, value: parsed.data };
}

function labelsForPrincipalScope(
  labels: Record<string, string> | undefined,
  principal: ApiKeyPrincipal | undefined,
): QueryParseResult<void> {
  const labelScope = principal?.labelScope;
  if (labelScope === undefined) return { ok: true, value: undefined };

  for (const [key, value] of Object.entries(labelScope)) {
    if (labels?.[key] !== value) {
      return { ok: false, error: validationError('request labels are outside API key scope') };
    }
  }

  return { ok: true, value: undefined };
}

function zodIssues(error: ZodError): JsonValue {
  return error.issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}

function verifyAdminActionRequest(
  authenticator: ApiKeyAuthenticator | undefined,
  platform: Platform,
  request: FastifyRequest,
): AdminActionSignatureParseResult {
  if (authenticator === undefined || !authenticator.adminActionSigningRequired) {
    return { ok: true, value: undefined };
  }
  const result = authenticator.verifyAdminActionSignature({
    method: request.method,
    path: request.url,
    body: request.body ?? null,
    timestamp: headerValue(request.headers['x-veritrail-admin-timestamp']),
    nonce: headerValue(request.headers['x-veritrail-admin-nonce']),
    keyId: headerValue(request.headers['x-veritrail-admin-key-id']),
    signature: headerValue(request.headers['x-veritrail-admin-signature']),
    now: platform.ctx.clock.now(),
  });
  return result.ok ? { ok: true, value: result.receipt } : { ok: false, error: result.error };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function recordAdminAction(
  platform: Platform,
  principal: ApiKeyPrincipal | undefined,
  input: AdminActionInput,
): ReturnType<Platform['ledger']['append']> {
  const actorId = principal?.actorId ?? 'server';
  const details = adminActionDetails(input);
  return platform.ledger.append({
    type: 'admin.action',
    actorId,
    payload: {
      action: input.action,
      targetType: input.targetType,
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
      ...(details !== undefined ? { details } : {}),
    },
  });
}

function adminActionDetails(input: AdminActionInput): JsonObject | undefined {
  const details = {
    ...(input.details ?? {}),
    ...(input.signature !== undefined
      ? { signature: adminActionSignatureDetails(input.signature) }
      : {}),
  };
  return Object.keys(details).length === 0 ? undefined : (asJson(details) as JsonObject);
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
