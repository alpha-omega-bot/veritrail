/**
 * HTTP routes for outbound webhook subscription management. Mounted under
 * /api/v1/control/webhooks/* by the main loop alongside the rest of the
 * control-plane surface. The handlers are intentionally thin — the heavy
 * lifting (secret minting, persistence) lives in @veritrail/control-plane.
 */

import type { ControlPlane, ControlPlaneStore } from '@veritrail/control-plane';
import { validationError } from '@veritrail/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { replyError } from './http.js';

export interface WebhookRoutesConfig {
  readonly controlPlane: ControlPlane;
}

/**
 * Mount /api/v1/control/webhooks/{create,list,pause,resume,delete}. All five
 * routes require a bearer session token resolved against the control plane.
 * The full secret is returned exactly once, on create.
 */
export function registerWebhookRoutes(app: FastifyInstance, opts: WebhookRoutesConfig): void {
  const { controlPlane } = opts;

  app.post('/api/v1/control/webhooks/create', async (request, reply) => {
    const principal = await resolveSessionPrincipal(request, controlPlane);
    if (!principal) return replyUnauthenticated(reply);
    const body = request.body as
      | { projectId?: unknown; url?: unknown; eventsFilter?: unknown }
      | undefined;
    const projectId = typeof body?.projectId === 'string' ? body.projectId : null;
    const url = typeof body?.url === 'string' ? body.url : null;
    if (!projectId) return replyError(reply, validationError('projectId is required'));
    if (!url || !isSafeWebhookUrl(url)) {
      return replyError(
        reply,
        validationError('url must be a public http(s) endpoint without credentials'),
      );
    }
    const authorized = await authorizeProject(principal, projectId, reply);
    if (!authorized) return reply;
    const eventsFilter = Array.isArray(body?.eventsFilter)
      ? (body!.eventsFilter as ReadonlyArray<unknown>).filter(
          (e): e is string => typeof e === 'string',
        )
      : [];
    const { webhook, secret } = await controlPlane.createWebhook({
      projectId,
      url,
      eventsFilter,
    });
    return reply.code(201).send({
      secret,
      webhook: {
        id: webhook.id,
        projectId: webhook.projectId,
        url: webhook.url,
        eventsFilter: webhook.eventsFilter,
        createdAt: webhook.createdAt,
        pausedAt: webhook.pausedAt,
      },
    });
  });

  app.post('/api/v1/control/webhooks/list', async (request, reply) => {
    const principal = await resolveSessionPrincipal(request, controlPlane);
    if (!principal) return replyUnauthenticated(reply);
    const body = request.body as { projectId?: unknown } | undefined;
    const projectId = typeof body?.projectId === 'string' ? body.projectId : null;
    if (!projectId) return replyError(reply, validationError('projectId is required'));
    const authorized = await authorizeProject(principal, projectId, reply);
    if (!authorized) return reply;
    const records = await controlPlane.listWebhooks(projectId);
    return reply.send(
      records.map((w) => ({
        id: w.id,
        projectId: w.projectId,
        url: w.url,
        eventsFilter: w.eventsFilter,
        createdAt: w.createdAt,
        pausedAt: w.pausedAt,
      })),
    );
  });

  app.post('/api/v1/control/webhooks/pause', async (request, reply) => {
    const principal = await resolveSessionPrincipal(request, controlPlane);
    if (!principal) return replyUnauthenticated(reply);
    const body = request.body as { id?: unknown } | undefined;
    const id = typeof body?.id === 'string' ? body.id : null;
    if (!id) return replyError(reply, validationError('id is required'));
    const authorized = await authorizeWebhook(principal, id, reply);
    if (!authorized) return reply;
    const updated = await controlPlane.pauseWebhook(id);
    if (!updated) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such webhook' } });
    }
    return reply.send({ ok: true, pausedAt: updated.pausedAt });
  });

  app.post('/api/v1/control/webhooks/resume', async (request, reply) => {
    const principal = await resolveSessionPrincipal(request, controlPlane);
    if (!principal) return replyUnauthenticated(reply);
    const body = request.body as { id?: unknown } | undefined;
    const id = typeof body?.id === 'string' ? body.id : null;
    if (!id) return replyError(reply, validationError('id is required'));
    const authorized = await authorizeWebhook(principal, id, reply);
    if (!authorized) return reply;
    const updated = await controlPlane.resumeWebhook(id);
    if (!updated) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such webhook' } });
    }
    return reply.send({ ok: true, pausedAt: updated.pausedAt });
  });

  app.post('/api/v1/control/webhooks/delete', async (request, reply) => {
    const principal = await resolveSessionPrincipal(request, controlPlane);
    if (!principal) return replyUnauthenticated(reply);
    const body = request.body as { id?: unknown } | undefined;
    const id = typeof body?.id === 'string' ? body.id : null;
    if (!id) return replyError(reply, validationError('id is required'));
    const authorized = await authorizeWebhook(principal, id, reply);
    if (!authorized) return reply;
    const removed = await controlPlane.deleteWebhook(id);
    if (!removed) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such webhook' } });
    }
    return reply.send({ ok: true });
  });
}

interface SessionPrincipal {
  readonly userId: string;
  readonly store: ControlPlaneStore;
}

async function resolveSessionPrincipal(
  request: FastifyRequest,
  controlPlane: ControlPlane,
): Promise<SessionPrincipal | null> {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return null;
  const result = await controlPlane.resolveSession(token);
  if (!result) return null;
  return { userId: result.user.id, store: controlPlane.store };
}

function replyUnauthenticated(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({
    error: { name: 'VeritrailError', code: 'VALIDATION', message: 'authentication required' },
  });
}

/**
 * Confirm the session principal belongs to the org that owns `projectId`.
 * Sends a 404 (unknown project) or 403 (not a member) and returns false when
 * the caller is not authorized, mirroring the api-key routes' convention.
 */
async function authorizeProject(
  principal: SessionPrincipal,
  projectId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const project = await principal.store.getProjectById(projectId);
  if (!project) {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such project' } });
    return false;
  }
  const memberships = await principal.store.listMembershipsForUser(principal.userId);
  if (!memberships.some((m) => m.orgId === project.orgId)) {
    reply
      .code(403)
      .send({ error: { code: 'POLICY_DENIED', message: 'not a member of that project' } });
    return false;
  }
  return true;
}

/**
 * Resolve a webhook by id and confirm the principal belongs to the owning
 * project's org. A missing webhook yields 404; a webhook in another org
 * yields 403 so one tenant cannot pause/resume/delete another tenant's hooks.
 */
async function authorizeWebhook(
  principal: SessionPrincipal,
  webhookId: string,
  reply: FastifyReply,
): Promise<boolean> {
  const webhook = await principal.store.getWebhookById(webhookId);
  if (!webhook) {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such webhook' } });
    return false;
  }
  return authorizeProject(principal, webhook.projectId, reply);
}

function isSafeWebhookUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    )
      return false;
    return !isPrivateIpLiteral(host);
  } catch {
    return false;
  }
}

function isPrivateIpLiteral(host: string): boolean {
  const normalized = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (normalized.includes(':')) {
    const lower = normalized.toLowerCase();
    if (lower.startsWith('::ffff:')) return isPrivateIpLiteral(lower.slice(7));
    const third = lower.charAt(2);
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      (lower.startsWith('fe') && '89ab'.includes(third)) ||
      lower.startsWith('ff') ||
      lower.startsWith('2001:db8:')
    );
  }
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}
