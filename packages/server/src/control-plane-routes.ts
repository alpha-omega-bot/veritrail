/**
 * HTTP routes for the SaaS control plane (orgs, users, projects, API keys,
 * magic-link sessions, billing). Mounted under /api/v1/control/* by the
 * server. The handlers are intentionally thin — all business logic lives in
 * @veritrail/control-plane.
 *
 * Wiring is deliberately additive: existing server callers that pass no
 * `controlPlane` option get exactly the original surface and behaviour.
 */

import {
  TIER_LIMITS,
  type ControlPlane,
  type EmailAdapter,
  type StripeWebhookHandler,
  type Tier,
  type UsageTracker,
} from '@veritrail/control-plane';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { replyError } from './http.js';
import { validationError } from '@veritrail/core';

export interface ControlPlaneRoutesConfig {
  readonly controlPlane: ControlPlane;
  /** Optional Stripe webhook handler. When omitted, the billing endpoints respond 503. */
  readonly stripe?: StripeWebhookHandler;
  /** Optional usage tracker. When omitted, /usage responds with zeros. */
  readonly usage?: UsageTracker;
  /** Optional email adapter. When omitted, magic links are returned in the response (dev only). */
  readonly email?: EmailAdapter;
  /** Base URL to embed in magic-link emails. */
  readonly consoleUrl?: string;
  /** Map of internal tier id → Stripe checkout price id. */
  readonly stripePriceIds?: Readonly<Record<Tier, string>>;
  /** Explicitly expose magic-link tokens in responses. Unsafe outside local development. */
  readonly allowInsecureDevMagicLinks?: boolean;
}

export function registerControlPlaneRoutes(
  app: FastifyInstance,
  config: ControlPlaneRoutesConfig,
): void {
  const { controlPlane, stripe, usage, email, consoleUrl, allowInsecureDevMagicLinks } = config;

  app.post('/api/v1/control/magic-link/request', async (request, reply) => {
    const body = request.body as { email?: unknown } | undefined;
    const emailValue = typeof body?.email === 'string' ? body.email : '';
    if (!emailValue || !emailValue.includes('@')) {
      return replyError(reply, validationError('email is required'));
    }
    if (!email && !allowInsecureDevMagicLinks) {
      return reply.code(503).send({
        error: { code: 'UNSUPPORTED', message: 'email delivery is not configured' },
      });
    }
    const { token } = await controlPlane.issueMagicLink({ email: emailValue });
    const link = `${consoleUrl ?? 'http://localhost:5173'}/#/magic-link?token=${encodeURIComponent(token)}`;

    if (email) {
      try {
        await email.send({
          to: emailValue,
          subject: 'Your Veritrail sign-in link',
          html: `<p>Click below to sign in (expires in 15 minutes):</p><p><a href="${link}">Sign in</a></p>`,
          text: `Sign in to Veritrail (expires in 15 minutes):\n${link}`,
        });
      } catch (err) {
        request.log.error({ err }, 'magic-link email failed');
        // Don't leak whether the email exists.
      }
      return reply.send({ ok: true });
    }
    // Dev fallback: surface the link directly so devs can sign in without an email provider.
    return reply.send({ ok: true, devLink: link });
  });

  app.post('/api/v1/control/magic-link/consume', async (request, reply) => {
    const body = request.body as { token?: unknown } | undefined;
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!token) return replyError(reply, validationError('token is required'));
    const result = await controlPlane.consumeMagicLink(token);
    if (!result) {
      return reply.code(401).send({
        error: {
          name: 'VeritrailError',
          code: 'VALIDATION',
          message: 'invalid or expired sign-in link',
        },
      });
    }

    // First-time users: auto-provision an org + project for instant onboarding.
    const orgs = await ensureOrgAndProject(controlPlane, result.user.id, result.user.email);
    const sessionResponse = {
      token: result.sessionToken,
      user: {
        id: result.user.id,
        email: result.user.email,
        displayName: result.user.displayName,
      },
      orgs: orgs.list.map((o) => ({
        id: o.org.id,
        name: o.org.name,
        slug: o.org.slug,
        tier: o.org.tier,
      })),
      currentOrgId: orgs.list[0]?.org.id ?? null,
      currentProjectId: orgs.list[0]?.projectId ?? null,
    };
    return reply.send(sessionResponse);
  });

  app.post('/api/v1/control/api-keys/list', async (request, reply) => {
    const principal = await resolveSessionPrincipal(request, controlPlane);
    if (!principal) return replyUnauthenticated(reply);
    const body = request.body as { projectId?: unknown } | undefined;
    const projectId = typeof body?.projectId === 'string' ? body.projectId : null;
    if (!projectId) return replyError(reply, validationError('projectId is required'));
    // Authorisation: the principal must belong to the project's org. We don't
    // surface key plaintext here — only metadata.
    const project = await principal.store.getProjectById(projectId);
    if (!project)
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such project' } });
    const memberships = await principal.store.listMembershipsForUser(principal.userId);
    if (!memberships.some((m) => m.orgId === project.orgId)) {
      return reply
        .code(403)
        .send({ error: { code: 'POLICY_DENIED', message: 'not a member of that project' } });
    }
    const records = await principal.store.listApiKeysForProject(projectId);
    return reply.send(
      records.map((r) => ({
        id: r.id,
        prefix: r.prefix,
        label: r.label,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
      })),
    );
  });

  app.post('/api/v1/control/api-keys/create', async (request, reply) => {
    const principal = await resolveSessionPrincipal(request, controlPlane);
    if (!principal) return replyUnauthenticated(reply);
    const body = request.body as { projectId?: unknown; label?: unknown } | undefined;
    const projectId = typeof body?.projectId === 'string' ? body.projectId : null;
    const label = typeof body?.label === 'string' ? body.label : '';
    if (!projectId) return replyError(reply, validationError('projectId is required'));
    const project = await principal.store.getProjectById(projectId);
    if (!project) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such project' } });
    }
    const memberships = await principal.store.listMembershipsForUser(principal.userId);
    const membership = memberships.find((m) => m.orgId === project.orgId);
    if (!membership) {
      return reply.code(403).send({ error: { code: 'POLICY_DENIED', message: 'not a member' } });
    }
    if (membership.role !== 'org:owner' && membership.role !== 'org:admin') {
      return reply.code(403).send({
        error: { code: 'POLICY_DENIED', message: 'owner or admin role required' },
      });
    }
    const { key, record } = await controlPlane.createApiKey({ projectId, label });
    return reply.code(201).send({
      key,
      record: {
        id: record.id,
        prefix: record.prefix,
        label: record.label,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        revokedAt: record.revokedAt,
      },
    });
  });

  app.post('/api/v1/control/api-keys/revoke', async (request, reply) => {
    const principal = await resolveSessionPrincipal(request, controlPlane);
    if (!principal) return replyUnauthenticated(reply);
    const body = request.body as { id?: unknown } | undefined;
    const id = typeof body?.id === 'string' ? body.id : null;
    if (!id) return replyError(reply, validationError('id is required'));
    if (!(await canManageApiKey(principal, id))) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'no such API key' } });
    }
    await controlPlane.revokeApiKey(id);
    return reply.send({ ok: true });
  });

  app.post('/api/v1/control/usage', async (request, reply) => {
    const principal = await resolveSessionPrincipal(request, controlPlane);
    if (!principal) return replyUnauthenticated(reply);
    const memberships = await principal.store.listMembershipsForUser(principal.userId);
    const firstOrg = memberships[0];
    if (!firstOrg) {
      return reply.send({ tier: 'free', usage: 0, limit: 0, periodStart: 0, periodEnd: 0 });
    }
    const org = await principal.store.getOrgById(firstOrg.orgId);
    if (!org) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
    const limits = TIER_LIMITS[org.tier];
    const check = usage?.check(org) ?? { usage: 0, limit: limits.eventsPerMonth, tier: org.tier };
    const monthStart = startOfUtcMonth(Date.now());
    return reply.send({
      tier: check.tier,
      usage: check.usage,
      limit: check.limit,
      periodStart: monthStart,
      periodEnd: monthStart + 30 * 86_400_000,
    });
  });

  app.post('/api/v1/control/billing/webhook', async (request, reply) => {
    if (!stripe) {
      return reply.code(503).send({ error: { code: 'UNSUPPORTED', message: 'billing disabled' } });
    }
    const sig = request.headers['stripe-signature'];
    if (typeof sig !== 'string') {
      return reply.code(400).send({ error: { code: 'VALIDATION', message: 'missing signature' } });
    }
    const rawBody = (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body);
    const outcome = await stripe.handle(rawBody, sig);
    if (!outcome.ok) {
      return reply.code(400).send({ error: { code: 'VALIDATION', message: outcome.error } });
    }
    return reply.send({ ok: true, ...outcome.result });
  });

  // The real /api/v1/control/billing/checkout route lives in billing-routes.ts
  // and is registered conditionally by extensions when Stripe is configured.
  // Tests that hit the stub directly (without billing-routes) get 404, which
  // is correct behaviour: there is no billing endpoint without Stripe.
}

import type { ControlPlaneStore as _ControlPlaneStore } from '@veritrail/control-plane';

interface SessionPrincipal {
  readonly userId: string;
  readonly store: _ControlPlaneStore;
}

/**
 * Resolve the bearer token on the request to a user via the control plane.
 * Bridges the cookie/Authorization header world to the existing per-route
 * principal model.
 */
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

async function canManageApiKey(principal: SessionPrincipal, keyId: string): Promise<boolean> {
  const memberships = await principal.store.listMembershipsForUser(principal.userId);
  for (const membership of memberships) {
    if (membership.role !== 'org:owner' && membership.role !== 'org:admin') continue;
    const projects = await principal.store.listProjectsForOrg(membership.orgId);
    for (const project of projects) {
      const keys = await principal.store.listApiKeysForProject(project.id);
      if (keys.some((key) => key.id === keyId)) return true;
    }
  }
  return false;
}

async function ensureOrgAndProject(
  cp: ControlPlane,
  userId: string,
  email: string,
): Promise<{
  list: ReadonlyArray<{
    org: { id: string; name: string; slug: string; tier: Tier };
    projectId: string | null;
  }>;
}> {
  const store = cp.store;
  const existing = await store.listOrgsForUser(userId);
  if (existing.length > 0) {
    const first = existing[0]!;
    const projects = await store.listProjectsForOrg(first.id);
    return {
      list: existing.map((org, i) => ({
        org: { id: org.id, name: org.name, slug: org.slug, tier: org.tier },
        projectId: i === 0 ? (projects[0]?.id ?? null) : null,
      })),
    };
  }
  const slug =
    email
      .split('@')[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .slice(0, 24) ?? 'workspace';
  const org = await cp.createOrg({ name: `${email.split('@')[0]}'s workspace`, slug });
  await cp.addMember({ orgId: org.id, userId, role: 'org:owner' });
  const project = await cp.createProject(org.id, { name: 'Default', slug: 'default' });
  return {
    list: [
      {
        org: { id: org.id, name: org.name, slug: org.slug, tier: org.tier },
        projectId: project.id,
      },
    ],
  };
}

function startOfUtcMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
