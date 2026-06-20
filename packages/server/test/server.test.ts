import {
  generateKeyPairSync,
  sign as signJwtBytes,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  asJson,
  createInMemoryLedger,
  hashJson,
  sha256Hex,
  storageError,
  type LedgerRecord,
} from '@veritrail/core';

import { buildServer } from '../src/app.js';
import { signAdminAction, type AdminActionSignatureReceipt } from '../src/auth.js';

const json = { 'content-type': 'application/json' };
const body = (value: unknown): string => JSON.stringify(value);
const adminSignatureSecret = 'admin-action-signing-secret-0001';
const oidcIssuer = 'https://idp.example.test/';
const oidcAudience = 'veritrail-server';
const oidcNow = 1_700_000_000_000;

function adminSignatureHeaders(input: {
  method: string;
  path: string;
  body?: unknown;
  timestamp?: number;
  nonce?: string;
  keyId?: string;
  secret?: string;
}): Record<string, string> {
  const receipt: AdminActionSignatureReceipt = {
    keyId: input.keyId ?? 'admin-action',
    timestamp: input.timestamp ?? 1_700_000_000_000,
    nonce: input.nonce ?? 'nonce-1',
    method: input.method,
    path: input.path,
    bodyHash: hashJson(asJson(input.body ?? null)),
    algorithm: 'hmac-sha256',
  };
  return {
    'x-veritrail-admin-key-id': receipt.keyId,
    'x-veritrail-admin-timestamp': String(receipt.timestamp),
    'x-veritrail-admin-nonce': receipt.nonce,
    'x-veritrail-admin-signature': signAdminAction(input.secret ?? adminSignatureSecret, receipt),
  };
}

function oidcFixture(): { privateKey: KeyObject; jwk: JsonWebKey } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  return {
    privateKey: pair.privateKey,
    jwk: { ...publicJwk, kid: 'oidc-key-1', alg: 'RS256' },
  };
}

function oidcToken(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const encodedHeader = base64UrlJson({ alg: 'RS256', kid: 'oidc-key-1', typ: 'JWT' });
  const encodedClaims = base64UrlJson({
    iss: oidcIssuer,
    sub: 'operator-oidc',
    aud: oidcAudience,
    exp: oidcNow / 1000 + 300,
    iat: oidcNow / 1000,
    ...claims,
  });
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = signJwtBytes('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('Veritrail HTTP server', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', name: 'veritrail-server' });
  });

  it('ingests an event and reflects it in the audit summary + integrity', async () => {
    const append = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: json,
      payload: body({ type: 'note', actorId: 'agent-1', payload: { text: 'hello' } }),
    });
    expect(append.statusCode).toBe(201);

    const summary = await app.inject({ method: 'GET', url: '/api/audit/summary' });
    expect(summary.json()).toMatchObject({ totalRecords: 1, integrityOk: true });

    const verify = await app.inject({ method: 'GET', url: '/api/audit/verify' });
    expect(verify.json()).toMatchObject({ ok: true });
  });

  it('rejects an invalid event with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: json,
      payload: body({ type: 'note', actorId: 'agent-1', payload: {} }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('treats audit event limit=0 as an explicit empty result', async () => {
    const app = await buildServer({ logger: false });
    try {
      await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: json,
        payload: body({ type: 'note', actorId: 'agent-1', payload: { text: 'hello' } }),
      });

      const res = await app.inject({ method: 'GET', url: '/api/audit/events?limit=0' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('rejects invalid audit event limits at the route boundary', async () => {
    const app = await buildServer({ logger: false });
    try {
      for (const limit of ['-1', '1.5', 'not-a-number']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/audit/events?limit=${encodeURIComponent(limit)}`,
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          error: { code: 'VALIDATION', message: 'limit must be a non-negative integer' },
        });
      }
    } finally {
      await app.close();
    }
  });

  it('treats forensics timeline limit=0 as an explicit empty result', async () => {
    const app = await buildServer({ logger: false });
    try {
      await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: json,
        payload: body({
          type: 'note',
          actorId: 'agent-1',
          correlationId: 'run-1',
          payload: { text: 'hello' },
        }),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/forensics/timeline?correlationId=run-1&limit=0',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('treats decision list and recall limit=0 as explicit empty results', async () => {
    const app = await buildServer({ logger: false });
    try {
      await app.inject({
        method: 'POST',
        url: '/api/decisions',
        headers: json,
        payload: body({
          actorId: 'agent-1',
          summary: 'Use the database index',
          rationale: 'The lookup path is selective',
          chosen: 'index',
        }),
      });

      const list = await app.inject({ method: 'GET', url: '/api/decisions?limit=0' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([]);

      const recall = await app.inject({
        method: 'GET',
        url: '/api/decisions/recall?text=database&limit=0',
      });
      expect(recall.statusCode).toBe(200);
      expect(recall.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('evaluates a permission policy', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/permissions/policies',
      headers: json,
      payload: body({ name: 'allow tools', effect: 'allow', match: { actionTypes: ['tool.*'] } }),
    });
    const evaluate = await app.inject({
      method: 'POST',
      url: '/api/permissions/evaluate',
      headers: json,
      payload: body({ action: { id: 'a1', actorId: 'agent-1', type: 'tool.search' } }),
    });
    expect(evaluate.json()).toMatchObject({ effect: 'allow' });

    const denied = await app.inject({
      method: 'POST',
      url: '/api/permissions/evaluate',
      headers: json,
      payload: body({ action: { id: 'a2', actorId: 'agent-1', type: 'db.drop' } }),
    });
    expect(denied.json()).toMatchObject({ effect: 'deny' }); // deny-by-default
  });

  it('enforces a hard-stop budget (402)', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/spend/budgets',
      headers: json,
      payload: body({
        name: 'cap',
        scope: { kind: 'global' },
        limit: { currency: 'USD', amountMinor: 100 },
      }),
    });
    const ok = await app.inject({
      method: 'POST',
      url: '/api/spend/charge',
      headers: json,
      payload: body({ actorId: 'agent-1', amount: { currency: 'USD', amountMinor: 60 } }),
    });
    expect(ok.statusCode).toBe(200);

    const over = await app.inject({
      method: 'POST',
      url: '/api/spend/charge',
      headers: json,
      payload: body({ actorId: 'agent-1', amount: { currency: 'USD', amountMinor: 60 } }),
    });
    expect(over.statusCode).toBe(402);
  });

  it('returns vendor risk assessment as an array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/vendor-risk/assess' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('Veritrail HTTP server auth', () => {
  const adminKey = 'admin-secret-0001';
  const ingestKey = 'ingest-secret-0001';
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer({
      logger: false,
      auth: {
        apiKeys: [
          { id: 'admin', actorId: 'operator-1', secret: adminKey, roles: ['admin'] },
          { id: 'ingest', actorId: 'agent-key-1', secret: ingestKey, roles: ['ingest'] },
        ],
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('leaves health public but rejects protected routes without a key', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);

    const protectedRoute = await app.inject({ method: 'GET', url: '/api/audit/summary' });
    expect(protectedRoute.statusCode).toBe(401);
    expect(protectedRoute.json()).toMatchObject({ error: { code: 'VALIDATION' } });
  });

  it('rejects keys that lack the route role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/permissions/policies',
      headers: { 'x-veritrail-api-key': ingestKey, ...json },
      payload: body({ name: 'allow tools', effect: 'allow', match: { actionTypes: ['tool.*'] } }),
    });

    expect(res.statusCode).toBe(403);
  });

  it('allows admin policy changes and records an admin.action fact', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/permissions/policies',
      headers: { authorization: `Bearer ${adminKey}`, ...json },
      payload: body({ name: 'allow tools', effect: 'allow', match: { actionTypes: ['tool.*'] } }),
    });
    expect(res.statusCode).toBe(200);
    const policy = res.json() as { id: string };

    const audit = await app.inject({
      method: 'GET',
      url: '/api/audit/events?type=admin.action',
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(audit.statusCode).toBe(200);
    const records = audit.json() as Array<{
      event: { actorId: string; type: string; payload: { targetId?: string } };
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]!.event).toMatchObject({
      actorId: 'operator-1',
      type: 'admin.action',
      payload: { action: 'policy.upserted', targetType: 'policy', targetId: policy.id },
    });
  });

  it('allows ingest keys to append events via bearer auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { authorization: `Bearer ${ingestKey}`, ...json },
      payload: body({ type: 'note', actorId: 'agent-1', payload: { text: 'hello' } }),
    });

    expect(res.statusCode).toBe(201);
  });

  it('narrows operator keys with optional route scopes', async () => {
    const scopedApp = await buildServer({
      logger: false,
      auth: {
        apiKeys: [
          {
            id: 'audit-reader',
            actorId: 'operator-audit',
            secret: 'audit-reader-secret-0001',
            roles: ['operator'],
            scopes: ['audit:read'],
          },
          {
            id: 'legacy-operator',
            actorId: 'operator-legacy',
            secret: 'legacy-operator-secret-0001',
            roles: ['operator'],
          },
          {
            id: 'admin',
            actorId: 'operator-admin',
            secret: 'admin-scope-secret-0001',
            roles: ['admin'],
            scopes: ['spend:read'],
          },
        ],
      },
    });
    try {
      const audit = await scopedApp.inject({
        method: 'GET',
        url: '/api/audit/summary',
        headers: { authorization: 'Bearer audit-reader-secret-0001' },
      });
      expect(audit.statusCode).toBe(200);

      const deniedSpend = await scopedApp.inject({
        method: 'GET',
        url: '/api/spend/status',
        headers: { authorization: 'Bearer audit-reader-secret-0001' },
      });
      expect(deniedSpend.statusCode).toBe(403);
      expect(deniedSpend.json()).toMatchObject({ error: { code: 'VALIDATION' } });

      const legacySpend = await scopedApp.inject({
        method: 'GET',
        url: '/api/spend/status',
        headers: { authorization: 'Bearer legacy-operator-secret-0001' },
      });
      expect(legacySpend.statusCode).toBe(200);

      const adminAudit = await scopedApp.inject({
        method: 'GET',
        url: '/api/audit/summary',
        headers: { authorization: 'Bearer admin-scope-secret-0001' },
      });
      expect(adminAudit.statusCode).toBe(200);
    } finally {
      await scopedApp.close();
    }
  });

  it('enforces API key label scopes on raw event writes and ledger queries', async () => {
    const scopedApp = await buildServer({
      logger: false,
      auth: {
        apiKeys: [
          {
            id: 'tenant-ingest',
            actorId: 'tenant-agent',
            secret: 'tenant-ingest-secret-0001',
            roles: ['ingest'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'tenant-operator',
            actorId: 'tenant-operator',
            secret: 'tenant-operator-secret-0001',
            roles: ['operator'],
            scopes: ['audit:read', 'forensics:read'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'admin',
            actorId: 'admin-1',
            secret: 'tenant-admin-secret-0001',
            roles: ['admin'],
          },
        ],
      },
    });
    try {
      const adminHeaders = { authorization: 'Bearer tenant-admin-secret-0001', ...json };
      const otherAppend = await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: adminHeaders,
        payload: body({
          type: 'note',
          actorId: 'agent-1',
          labels: { tenant: 'other', project: 'alpha' },
          payload: { text: 'other tenant' },
        }),
      });
      await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: adminHeaders,
        payload: body({
          type: 'note',
          actorId: 'agent-1',
          labels: { tenant: 'acme', project: 'alpha' },
          payload: { text: 'first scoped event' },
        }),
      });
      await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: adminHeaders,
        payload: body({
          type: 'note',
          actorId: 'agent-1',
          labels: { tenant: 'acme', project: 'alpha' },
          payload: { text: 'second scoped event' },
        }),
      });

      const deniedAppend = await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: { authorization: 'Bearer tenant-ingest-secret-0001', ...json },
        payload: body({
          type: 'note',
          actorId: 'agent-1',
          labels: { tenant: 'other', project: 'alpha' },
          payload: { text: 'wrong tenant' },
        }),
      });
      expect(deniedAppend.statusCode).toBe(400);
      expect(deniedAppend.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'event labels are outside API key scope' },
      });

      const allowedAppend = await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: { authorization: 'Bearer tenant-ingest-secret-0001', ...json },
        payload: body({
          type: 'note',
          actorId: 'agent-1',
          labels: { tenant: 'acme', project: 'alpha' },
          payload: { text: 'scoped write' },
        }),
      });
      expect(allowedAppend.statusCode).toBe(201);

      const scopedRead = await scopedApp.inject({
        method: 'GET',
        url: '/api/audit/events?limit=2',
        headers: { authorization: 'Bearer tenant-operator-secret-0001' },
      });
      expect(scopedRead.statusCode).toBe(200);
      const records = scopedRead.json() as Array<{
        seq: number;
        event: { labels: Record<string, string>; payload: { text?: string } };
      }>;
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.event.labels['tenant'] === 'acme')).toBe(true);
      expect(records.map((record) => record.event.payload.text)).toEqual([
        'first scoped event',
        'second scoped event',
      ]);

      const otherSeq = (otherAppend.json() as { record: { seq: number } }).record.seq;
      const hiddenRecord = await scopedApp.inject({
        method: 'GET',
        url: `/api/audit/events/${otherSeq}`,
        headers: { authorization: 'Bearer tenant-operator-secret-0001' },
      });
      expect(hiddenRecord.statusCode).toBe(404);

      const wholeChainSummary = await scopedApp.inject({
        method: 'GET',
        url: '/api/audit/summary',
        headers: { authorization: 'Bearer tenant-operator-secret-0001' },
      });
      expect(wholeChainSummary.statusCode).toBe(400);
      expect(wholeChainSummary.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'route requires an unscoped API key' },
      });

      const conflictingRead = await scopedApp.inject({
        method: 'GET',
        url: '/api/forensics/timeline?label.tenant=other',
        headers: { authorization: 'Bearer tenant-operator-secret-0001' },
      });
      expect(conflictingRead.statusCode).toBe(400);
      expect(conflictingRead.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'query label is outside API key scope' },
      });
    } finally {
      await scopedApp.close();
    }
  });

  it('enforces label scopes on spend charges and spend read projections', async () => {
    const scopedApp = await buildServer({
      logger: false,
      auth: {
        apiKeys: [
          {
            id: 'tenant-ingest',
            actorId: 'tenant-agent',
            secret: 'tenant-spend-ingest-secret-0001',
            roles: ['ingest'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'tenant-spend-reader',
            actorId: 'tenant-operator',
            secret: 'tenant-spend-reader-secret-0001',
            roles: ['operator'],
            scopes: ['spend:read'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'operator',
            actorId: 'operator-1',
            secret: 'spend-reader-secret-0001',
            roles: ['operator'],
            scopes: ['spend:read'],
          },
          {
            id: 'admin',
            actorId: 'admin-1',
            secret: 'spend-admin-secret-0001',
            roles: ['admin'],
          },
        ],
      },
    });
    try {
      await scopedApp.inject({
        method: 'POST',
        url: '/api/spend/budgets',
        headers: { authorization: 'Bearer spend-admin-secret-0001', ...json },
        payload: body({
          name: 'tenant cap',
          scope: { kind: 'label', value: 'tenant=acme' },
          limit: { currency: 'USD', amountMinor: 1000 },
        }),
      });
      await scopedApp.inject({
        method: 'POST',
        url: '/api/spend/budgets',
        headers: { authorization: 'Bearer spend-admin-secret-0001', ...json },
        payload: body({
          name: 'sibling tenant cap',
          scope: { kind: 'label', value: 'tenant=other' },
          limit: { currency: 'USD', amountMinor: 1000 },
        }),
      });
      await scopedApp.inject({
        method: 'POST',
        url: '/api/spend/budgets',
        headers: { authorization: 'Bearer spend-admin-secret-0001', ...json },
        payload: body({
          name: 'global cap',
          scope: { kind: 'global' },
          limit: { currency: 'USD', amountMinor: 5000 },
        }),
      });

      const missingLabels = await scopedApp.inject({
        method: 'POST',
        url: '/api/spend/charge',
        headers: { authorization: 'Bearer tenant-spend-ingest-secret-0001', ...json },
        payload: body({
          actorId: 'tenant-agent',
          amount: { currency: 'USD', amountMinor: 100 },
        }),
      });
      expect(missingLabels.statusCode).toBe(400);
      expect(missingLabels.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'request labels are outside API key scope' },
      });

      const wrongLabels = await scopedApp.inject({
        method: 'POST',
        url: '/api/spend/charge',
        headers: { authorization: 'Bearer tenant-spend-ingest-secret-0001', ...json },
        payload: body({
          actorId: 'tenant-agent',
          amount: { currency: 'USD', amountMinor: 100 },
          labels: { tenant: 'other', project: 'alpha' },
        }),
      });
      expect(wrongLabels.statusCode).toBe(400);

      const allowed = await scopedApp.inject({
        method: 'POST',
        url: '/api/spend/charge',
        headers: { authorization: 'Bearer tenant-spend-ingest-secret-0001', ...json },
        payload: body({
          actorId: 'tenant-agent',
          amount: { currency: 'USD', amountMinor: 100 },
          labels: { tenant: 'acme', project: 'alpha' },
        }),
      });
      expect(allowed.statusCode).toBe(200);

      const siblingProjectCharge = await scopedApp.inject({
        method: 'POST',
        url: '/api/spend/charge',
        headers: { authorization: 'Bearer spend-admin-secret-0001', ...json },
        payload: body({
          actorId: 'tenant-agent',
          amount: { currency: 'USD', amountMinor: 700 },
          labels: { tenant: 'acme', project: 'beta' },
        }),
      });
      expect(siblingProjectCharge.statusCode).toBe(200);

      const otherTenantCharge = await scopedApp.inject({
        method: 'POST',
        url: '/api/spend/charge',
        headers: { authorization: 'Bearer spend-admin-secret-0001', ...json },
        payload: body({
          actorId: 'tenant-agent',
          amount: { currency: 'USD', amountMinor: 900 },
          labels: { tenant: 'other', project: 'alpha' },
        }),
      });
      expect(otherTenantCharge.statusCode).toBe(200);

      const scopedBudgets = await scopedApp.inject({
        method: 'GET',
        url: '/api/spend/budgets',
        headers: { authorization: 'Bearer tenant-spend-reader-secret-0001' },
      });
      expect(scopedBudgets.statusCode).toBe(200);
      expect(scopedBudgets.json()).toMatchObject([{ name: 'tenant cap' }]);

      const scopedStatus = await scopedApp.inject({
        method: 'GET',
        url: '/api/spend/status',
        headers: { authorization: 'Bearer tenant-spend-reader-secret-0001' },
      });
      expect(scopedStatus.statusCode).toBe(200);
      expect(scopedStatus.json()).toMatchObject([
        {
          budget: { name: 'tenant cap', scope: { kind: 'label', value: 'tenant=acme' } },
          spent: { amountMinor: 100 },
          remaining: { amountMinor: 900 },
        },
      ]);

      const unscopedStatus = await scopedApp.inject({
        method: 'GET',
        url: '/api/spend/status',
        headers: { authorization: 'Bearer spend-reader-secret-0001' },
      });
      expect(unscopedStatus.statusCode).toBe(200);
      expect(unscopedStatus.json()).toMatchObject([
        { budget: { name: 'tenant cap' }, spent: { amountMinor: 800 } },
        { budget: { name: 'sibling tenant cap' }, spent: { amountMinor: 900 } },
        { budget: { name: 'global cap' }, spent: { amountMinor: 1700 } },
      ]);
    } finally {
      await scopedApp.close();
    }
  });

  it('enforces label scopes on decision writes and decision read projections', async () => {
    const scopedApp = await buildServer({
      logger: false,
      auth: {
        apiKeys: [
          {
            id: 'tenant-ingest',
            actorId: 'tenant-agent',
            secret: 'tenant-decision-ingest-secret-0001',
            roles: ['ingest'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'tenant-decision-reader',
            actorId: 'tenant-operator',
            secret: 'tenant-decision-reader-secret-0001',
            roles: ['operator'],
            scopes: ['decisions:read'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'operator',
            actorId: 'operator-1',
            secret: 'decision-reader-secret-0001',
            roles: ['operator'],
            scopes: ['decisions:read'],
          },
          {
            id: 'admin',
            actorId: 'admin-1',
            secret: 'decision-admin-secret-0001',
            roles: ['admin'],
          },
        ],
      },
    });
    try {
      const scopedWrite = await scopedApp.inject({
        method: 'POST',
        url: '/api/decisions',
        headers: { authorization: 'Bearer tenant-decision-ingest-secret-0001', ...json },
        payload: body({
          id: 'dec_alpha',
          actorId: 'tenant-agent',
          summary: 'Deploy alpha service',
          rationale: 'Alpha is ready',
          chosen: 'deploy',
        }),
      });
      expect(scopedWrite.statusCode).toBe(200);

      const siblingProjectWrite = await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: { authorization: 'Bearer decision-admin-secret-0001', ...json },
        payload: body({
          type: 'decision.recorded',
          actorId: 'tenant-agent',
          labels: { tenant: 'acme', project: 'beta' },
          payload: {
            decision: {
              id: 'dec_beta',
              actorId: 'tenant-agent',
              summary: 'Deploy beta service',
              rationale: 'Beta is separate',
              chosen: 'deploy',
            },
          },
        }),
      });
      expect(siblingProjectWrite.statusCode).toBe(201);

      const otherTenantWrite = await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: { authorization: 'Bearer decision-admin-secret-0001', ...json },
        payload: body({
          type: 'decision.recorded',
          actorId: 'tenant-agent',
          labels: { tenant: 'other', project: 'alpha' },
          payload: {
            decision: {
              id: 'dec_other',
              actorId: 'tenant-agent',
              summary: 'Deploy other service',
              rationale: 'Other tenant',
              chosen: 'deploy',
            },
          },
        }),
      });
      expect(otherTenantWrite.statusCode).toBe(201);

      const scopedList = await scopedApp.inject({
        method: 'GET',
        url: '/api/decisions',
        headers: { authorization: 'Bearer tenant-decision-reader-secret-0001' },
      });
      expect(scopedList.statusCode).toBe(200);
      expect((scopedList.json() as Array<{ id: string }>).map((decision) => decision.id)).toEqual([
        'dec_alpha',
      ]);

      const scopedRecall = await scopedApp.inject({
        method: 'GET',
        url: '/api/decisions/recall?text=deploy',
        headers: { authorization: 'Bearer tenant-decision-reader-secret-0001' },
      });
      expect(scopedRecall.statusCode).toBe(200);
      expect(
        (scopedRecall.json() as Array<{ decision: { id: string } }>).map(
          (match) => match.decision.id,
        ),
      ).toEqual(['dec_alpha']);

      const actorFiltered = await scopedApp.inject({
        method: 'GET',
        url: '/api/decisions?actorId=other-agent',
        headers: { authorization: 'Bearer tenant-decision-reader-secret-0001' },
      });
      expect(actorFiltered.statusCode).toBe(200);
      expect(actorFiltered.json()).toEqual([]);

      const scopedAudit = await scopedApp.inject({
        method: 'GET',
        url: '/api/audit/events?type=decision.recorded',
        headers: { authorization: 'Bearer tenant-decision-reader-secret-0001' },
      });
      expect(scopedAudit.statusCode).toBe(403);

      const unscopedList = await scopedApp.inject({
        method: 'GET',
        url: '/api/decisions',
        headers: { authorization: 'Bearer decision-reader-secret-0001' },
      });
      expect(unscopedList.statusCode).toBe(200);
      expect((unscopedList.json() as Array<{ id: string }>).map((decision) => decision.id)).toEqual(
        ['dec_other', 'dec_beta', 'dec_alpha'],
      );
    } finally {
      await scopedApp.close();
    }
  });

  it('enforces label scopes on evidence writes and evidence read projections', async () => {
    const scopedApp = await buildServer({
      logger: false,
      auth: {
        apiKeys: [
          {
            id: 'tenant-ingest',
            actorId: 'tenant-agent',
            secret: 'tenant-evidence-ingest-secret-0001',
            roles: ['ingest'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'tenant-evidence-reader',
            actorId: 'tenant-operator',
            secret: 'tenant-evidence-reader-secret-0001',
            roles: ['operator'],
            scopes: ['evidence:read'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'operator',
            actorId: 'operator-1',
            secret: 'evidence-reader-secret-0001',
            roles: ['operator'],
            scopes: ['evidence:read'],
          },
          {
            id: 'admin',
            actorId: 'admin-1',
            secret: 'evidence-admin-secret-0001',
            roles: ['admin'],
          },
        ],
      },
    });
    try {
      const content = 'alpha evidence content';
      const scopedSource = await scopedApp.inject({
        method: 'POST',
        url: '/api/evidence',
        headers: { authorization: 'Bearer tenant-evidence-ingest-secret-0001', ...json },
        payload: body({
          id: 'evd-alpha-source',
          actorId: 'tenant-agent',
          kind: 'document',
          summary: 'Alpha source',
          contentHash: sha256Hex(content),
        }),
      });
      expect(scopedSource.statusCode).toBe(200);

      const scopedClaim = await scopedApp.inject({
        method: 'POST',
        url: '/api/evidence',
        headers: { authorization: 'Bearer tenant-evidence-ingest-secret-0001', ...json },
        payload: body({
          id: 'evd-alpha-claim',
          actorId: 'tenant-agent',
          kind: 'citation',
          summary: 'Alpha claim',
          links: { evidenceIds: ['evd-alpha-source', 'evd-beta-source'] },
        }),
      });
      expect(scopedClaim.statusCode).toBe(200);

      const siblingProject = await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: { authorization: 'Bearer evidence-admin-secret-0001', ...json },
        payload: body({
          type: 'evidence.attached',
          actorId: 'tenant-agent',
          labels: { tenant: 'acme', project: 'beta' },
          payload: {
            evidence: {
              id: 'evd-beta-source',
              kind: 'document',
              summary: 'Beta source',
              contentHash: sha256Hex('beta content'),
            },
          },
        }),
      });
      expect(siblingProject.statusCode).toBe(201);

      const otherTenant = await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: { authorization: 'Bearer evidence-admin-secret-0001', ...json },
        payload: body({
          type: 'evidence.attached',
          actorId: 'tenant-agent',
          labels: { tenant: 'other', project: 'alpha' },
          payload: {
            evidence: {
              id: 'evd-other-source',
              kind: 'document',
              summary: 'Other source',
            },
          },
        }),
      });
      expect(otherTenant.statusCode).toBe(201);

      const scopedList = await scopedApp.inject({
        method: 'GET',
        url: '/api/evidence',
        headers: { authorization: 'Bearer tenant-evidence-reader-secret-0001' },
      });
      expect(scopedList.statusCode).toBe(200);
      expect((scopedList.json() as Array<{ id: string }>).map((item) => item.id)).toEqual([
        'evd-alpha-source',
        'evd-alpha-claim',
      ]);

      const scopedTrace = await scopedApp.inject({
        method: 'GET',
        url: '/api/evidence/evd-alpha-claim/trace',
        headers: { authorization: 'Bearer tenant-evidence-reader-secret-0001' },
      });
      expect(scopedTrace.statusCode).toBe(200);
      expect(
        (scopedTrace.json() as { nodes: Array<{ id: string }> }).nodes
          .map((node) => node.id)
          .sort(),
      ).toEqual(['evd-alpha-claim', 'evd-alpha-source']);
      expect(
        (scopedTrace.json() as { edges: Array<{ from: string; to: string }> }).edges
          .map((edge) => `${edge.from}->${edge.to}`)
          .sort(),
      ).toEqual(['evd-alpha-claim->evd-alpha-source', 'evd-alpha-claim->evd-beta-source']);

      const hiddenTrace = await scopedApp.inject({
        method: 'GET',
        url: '/api/evidence/evd-beta-source/trace',
        headers: { authorization: 'Bearer tenant-evidence-reader-secret-0001' },
      });
      expect(hiddenTrace.statusCode).toBe(404);

      const verifyVisible = await scopedApp.inject({
        method: 'POST',
        url: '/api/evidence/evd-alpha-source/verify',
        headers: { authorization: 'Bearer tenant-evidence-reader-secret-0001', ...json },
        payload: body({ content }),
      });
      expect(verifyVisible.statusCode).toBe(200);
      expect(verifyVisible.json()).toBe(true);

      const verifyHidden = await scopedApp.inject({
        method: 'POST',
        url: '/api/evidence/evd-beta-source/verify',
        headers: { authorization: 'Bearer tenant-evidence-reader-secret-0001', ...json },
        payload: body({ content: 'beta content' }),
      });
      expect(verifyHidden.statusCode).toBe(404);

      const unscopedList = await scopedApp.inject({
        method: 'GET',
        url: '/api/evidence',
        headers: { authorization: 'Bearer evidence-reader-secret-0001' },
      });
      expect(unscopedList.statusCode).toBe(200);
      expect((unscopedList.json() as Array<{ id: string }>).map((item) => item.id)).toEqual([
        'evd-alpha-source',
        'evd-alpha-claim',
        'evd-beta-source',
        'evd-other-source',
      ]);
    } finally {
      await scopedApp.close();
    }
  });

  it('denies label-scoped principals on unpartitioned module projections', async () => {
    const scopedApp = await buildServer({
      logger: false,
      auth: {
        apiKeys: [
          {
            id: 'tenant-ingest',
            actorId: 'tenant-agent',
            secret: 'tenant-module-ingest-secret-0001',
            roles: ['ingest'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'tenant-operator',
            actorId: 'tenant-operator',
            secret: 'tenant-module-operator-secret-0001',
            roles: ['operator'],
            scopes: [
              'audit:read',
              'permissions:read',
              'vendor-risk:read',
              'forensics:read',
              'rollback:read',
              'rollback:execute',
            ],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'tenant-admin',
            actorId: 'tenant-admin',
            secret: 'tenant-module-admin-secret-0001',
            roles: ['admin'],
            labelScope: { tenant: 'acme', project: 'alpha' },
          },
          {
            id: 'admin',
            actorId: 'admin-1',
            secret: 'module-admin-secret-0001',
            roles: ['admin'],
          },
        ],
      },
    });
    try {
      const scopedIngestHeaders = {
        authorization: 'Bearer tenant-module-ingest-secret-0001',
        ...json,
      };
      const scopedOperatorHeaders = {
        authorization: 'Bearer tenant-module-operator-secret-0001',
        ...json,
      };
      const scopedAdminHeaders = {
        authorization: 'Bearer tenant-module-admin-secret-0001',
        ...json,
      };

      const rawAppend = await scopedApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: scopedIngestHeaders,
        payload: body({
          type: 'note',
          actorId: 'tenant-agent',
          labels: { tenant: 'acme', project: 'alpha' },
          payload: { text: 'scoped raw ledger write remains available' },
        }),
      });
      expect(rawAppend.statusCode).toBe(201);

      const rawRead = await scopedApp.inject({
        method: 'GET',
        url: '/api/audit/events',
        headers: scopedOperatorHeaders,
      });
      expect(rawRead.statusCode).toBe(200);
      expect(rawRead.json()).toHaveLength(1);

      const deniedReadRoutes = [
        ['GET', '/api/permissions/policies'],
        ['GET', '/api/audit/summary'],
        ['GET', '/api/audit/verify'],
        ['GET', '/api/audit/export'],
        ['POST', '/api/permissions/evaluate'],
        ['GET', '/api/vendors'],
        ['GET', '/api/vendors/ven-1/signals'],
        ['GET', '/api/vendor-risk/assess'],
        ['GET', '/api/vendor-risk/ven-1/score'],
        ['GET', '/api/forensics/incident?correlationId=run-1'],
        ['GET', '/api/forensics/cause/action-1'],
        ['POST', '/api/rollback/plan/action/action-1'],
        ['GET', '/api/rollback/plan/correlation/run-1'],
        ['POST', '/api/rollback/execute'],
      ] as const;

      for (const [method, url] of deniedReadRoutes) {
        const res = await scopedApp.inject({
          method,
          url,
          headers: scopedOperatorHeaders,
          ...(method === 'POST'
            ? {
                payload: body({
                  action: { id: 'action-1', actorId: 'tenant-agent', type: 'tool.search' },
                  content: 'payload',
                  plan: { steps: [], unreversible: [] },
                }),
              }
            : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(400);
        expect(res.json(), `${method} ${url}`).toMatchObject({
          error: { code: 'VALIDATION', message: 'route requires an unscoped API key' },
        });
      }

      const deniedIngestRoutes = [
        [
          '/api/permissions/enforce',
          {
            action: { id: 'action-1', actorId: 'tenant-agent', type: 'tool.search' },
          },
        ],
        [
          '/api/vendors/signals',
          {
            vendorId: 'ven-1',
            kind: 'incident',
            severity: 'high',
            summary: 'Incident',
          },
        ],
      ] as const;

      for (const [url, payload] of deniedIngestRoutes) {
        const res = await scopedApp.inject({
          method: 'POST',
          url,
          headers: scopedIngestHeaders,
          payload: body(payload),
        });
        expect(res.statusCode, url).toBe(400);
        expect(res.json(), url).toMatchObject({
          error: { code: 'VALIDATION', message: 'route requires an unscoped API key' },
        });
      }

      for (const [url, payload] of [
        [
          '/api/permissions/policies',
          { name: 'tenant policy', effect: 'allow', match: { actionTypes: ['tool.*'] } },
        ],
        [
          '/api/vendors',
          {
            name: 'Tenant Vendor',
            category: 'api',
          },
        ],
      ] as const) {
        const res = await scopedApp.inject({
          method: 'POST',
          url,
          headers: scopedAdminHeaders,
          payload: body(payload),
        });
        expect(res.statusCode, url).toBe(400);
        expect(res.json(), url).toMatchObject({
          error: { code: 'VALIDATION', message: 'route requires an unscoped API key' },
        });
      }

      const budgetMutation = await scopedApp.inject({
        method: 'POST',
        url: '/api/spend/budgets',
        headers: scopedAdminHeaders,
        payload: body({
          name: 'tenant budget',
          scope: { kind: 'label', value: 'tenant=acme' },
          limit: { currency: 'USD', amountMinor: 1000 },
        }),
      });
      expect(budgetMutation.statusCode).toBe(400);
      expect(budgetMutation.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'route requires an unscoped API key' },
      });

      const deletePolicy = await scopedApp.inject({
        method: 'DELETE',
        url: '/api/permissions/policies/pol-1',
        headers: { authorization: 'Bearer tenant-module-admin-secret-0001' },
      });
      expect(deletePolicy.statusCode).toBe(400);
      expect(deletePolicy.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'route requires an unscoped API key' },
      });
    } finally {
      await scopedApp.close();
    }
  });

  it('accepts OIDC bearer tokens with mapped route scopes and label scopes', async () => {
    const { privateKey, jwk } = oidcFixture();
    const oidcApp = await buildServer({
      logger: false,
      clock: { now: () => oidcNow },
      auth: {
        apiKeys: [
          {
            id: 'admin',
            actorId: 'admin-1',
            secret: 'tenant-admin-secret-0001',
            roles: ['admin'],
          },
        ],
        oidc: {
          issuer: oidcIssuer,
          audience: oidcAudience,
          jwks: { keys: [jwk] },
          rolesClaim: 'groups',
          scopesClaim: 'veritrail_scopes',
          labelScopeClaim: 'labels',
          roleMappings: { 'veritrail-operators': 'operator' },
        },
      },
    });
    try {
      const adminHeaders = { authorization: 'Bearer tenant-admin-secret-0001', ...json };
      await oidcApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: adminHeaders,
        payload: body({
          type: 'note',
          actorId: 'agent-1',
          labels: { tenant: 'other', project: 'alpha' },
          payload: { text: 'other tenant' },
        }),
      });
      await oidcApp.inject({
        method: 'POST',
        url: '/api/events',
        headers: adminHeaders,
        payload: body({
          type: 'note',
          actorId: 'agent-1',
          labels: { tenant: 'acme', project: 'alpha' },
          payload: { text: 'visible tenant event' },
        }),
      });

      const token = oidcToken(privateKey, {
        sub: 'operator-oidc',
        groups: ['veritrail-operators'],
        veritrail_scopes: ['audit:read'],
        labels: { tenant: 'acme', project: 'alpha' },
      });
      const audit = await oidcApp.inject({
        method: 'GET',
        url: '/api/audit/events',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(audit.statusCode).toBe(200);
      const records = audit.json() as Array<{ event: { payload: { text?: string } } }>;
      expect(records.map((record) => record.event.payload.text)).toEqual(['visible tenant event']);

      const deniedSpend = await oidcApp.inject({
        method: 'GET',
        url: '/api/spend/status',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deniedSpend.statusCode).toBe(403);
    } finally {
      await oidcApp.close();
    }
  });

  it('rejects OIDC bearer tokens before protected route handlers run', async () => {
    const { privateKey, jwk } = oidcFixture();
    const oidcApp = await buildServer({
      logger: false,
      clock: { now: () => oidcNow },
      auth: {
        oidc: {
          issuer: oidcIssuer,
          audience: oidcAudience,
          jwks: { keys: [jwk] },
          defaultRoles: ['operator'],
          defaultScopes: ['audit:read'],
          clockSkewSeconds: 0,
        },
      },
    });
    try {
      const wrongAudience = oidcToken(privateKey, { aud: 'wrong-audience' });
      const denied = await oidcApp.inject({
        method: 'GET',
        url: '/api/audit/events',
        headers: { authorization: `Bearer ${wrongAudience}` },
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'OIDC token audience is invalid' },
      });
    } finally {
      await oidcApp.close();
    }
  });

  it('does not mutate admin config when the required audit event fails', async () => {
    const ledger = createInMemoryLedger();
    const originalAppend = ledger.append.bind(ledger);
    ledger.append = async (input: unknown) => {
      if (
        input !== null &&
        typeof input === 'object' &&
        (input as { type?: unknown }).type === 'admin.action'
      ) {
        return { ok: false, error: storageError('audit unavailable') };
      }
      return originalAppend(input);
    };
    const failingApp = await buildServer({
      logger: false,
      ledger,
      clock: { now: () => 1_700_000_000_000 },
      auth: {
        apiKeys: [{ id: 'admin', actorId: 'operator-1', secret: adminKey, roles: ['admin'] }],
      },
    });
    try {
      const create = await failingApp.inject({
        method: 'POST',
        url: '/api/permissions/policies',
        headers: { authorization: `Bearer ${adminKey}`, ...json },
        payload: body({
          name: 'should not persist',
          effect: 'allow',
          match: { actionTypes: ['tool.*'] },
        }),
      });
      expect(create.statusCode).toBe(500);

      const policies = await failingApp.inject({
        method: 'GET',
        url: '/api/permissions/policies',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect(policies.json()).toEqual([]);
      expect(
        (await ledger.query({ types: ['admin.action'] })).map((r: LedgerRecord) => r.seq),
      ).toEqual([]);
    } finally {
      await failingApp.close();
    }
  });

  it('requires signed admin actions when configured and records the signature receipt', async () => {
    const ledger = createInMemoryLedger({ clock: { now: () => 1_700_000_000_000 } });
    const signedApp = await buildServer({
      logger: false,
      ledger,
      clock: { now: () => 1_700_000_000_000 },
      auth: {
        adminActionSigning: {
          secret: adminSignatureSecret,
          keyId: 'admin-action',
          maxSkewMs: 60_000,
        },
        apiKeys: [{ id: 'admin', actorId: 'operator-1', secret: adminKey, roles: ['admin'] }],
      },
    });
    try {
      const payload = {
        id: 'pol-signed',
        name: 'signed policy',
        effect: 'allow',
        match: { actionTypes: ['tool.*'] },
      };
      const missing = await signedApp.inject({
        method: 'POST',
        url: '/api/permissions/policies',
        headers: { authorization: `Bearer ${adminKey}`, ...json },
        payload: body(payload),
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'admin action signature is required' },
      });

      const signed = await signedApp.inject({
        method: 'POST',
        url: '/api/permissions/policies',
        headers: {
          authorization: `Bearer ${adminKey}`,
          ...json,
          ...adminSignatureHeaders({
            method: 'POST',
            path: '/api/permissions/policies',
            body: payload,
          }),
        },
        payload: body(payload),
      });
      expect(signed.statusCode).toBe(200);

      const policies = await signedApp.inject({
        method: 'GET',
        url: '/api/permissions/policies',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect(policies.json()).toHaveLength(1);

      const budgetPayload = {
        id: 'bud-signed',
        name: 'signed budget',
        scope: { kind: 'global' },
        limit: { currency: 'USD', amountMinor: 1_000 },
      };
      const budget = await signedApp.inject({
        method: 'POST',
        url: '/api/spend/budgets',
        headers: {
          authorization: `Bearer ${adminKey}`,
          ...json,
          ...adminSignatureHeaders({
            method: 'POST',
            path: '/api/spend/budgets',
            body: budgetPayload,
            nonce: 'nonce-2',
          }),
        },
        payload: body(budgetPayload),
      });
      expect(budget.statusCode).toBe(200);

      const records = await ledger.query({ types: ['admin.action'] });
      expect(records).toHaveLength(2);
      expect(records[0]?.event.payload).toMatchObject({
        action: 'policy.upserted',
        targetType: 'policy',
        targetId: 'pol-signed',
        details: {
          signature: {
            keyId: 'admin-action',
            timestamp: 1_700_000_000_000,
            nonce: 'nonce-1',
            method: 'POST',
            path: '/api/permissions/policies',
            algorithm: 'hmac-sha256',
          },
        },
      });
      expect(records[1]?.event.payload).toMatchObject({
        action: 'budget.upserted',
        targetType: 'budget',
        targetId: 'bud-signed',
        details: {
          signature: {
            keyId: 'admin-action',
            timestamp: 1_700_000_000_000,
            nonce: 'nonce-2',
            method: 'POST',
            path: '/api/spend/budgets',
            algorithm: 'hmac-sha256',
          },
        },
      });
    } finally {
      await signedApp.close();
    }
  });

  it('rejects stale, replayed, and tampered signed admin actions before mutation', async () => {
    const ledger = createInMemoryLedger({ clock: { now: () => 1_700_000_000_000 } });
    const signedApp = await buildServer({
      logger: false,
      ledger,
      clock: { now: () => 1_700_000_000_000 },
      auth: {
        adminActionSigning: {
          secret: adminSignatureSecret,
          keyId: 'admin-action',
          maxSkewMs: 60_000,
        },
        apiKeys: [{ id: 'admin', actorId: 'operator-1', secret: adminKey, roles: ['admin'] }],
      },
    });
    try {
      const stalePayload = {
        id: 'pol-stale',
        name: 'stale policy',
        effect: 'allow',
        match: { actionTypes: ['tool.*'] },
      };
      const stale = await signedApp.inject({
        method: 'POST',
        url: '/api/permissions/policies',
        headers: {
          authorization: `Bearer ${adminKey}`,
          ...json,
          ...adminSignatureHeaders({
            method: 'POST',
            path: '/api/permissions/policies',
            body: stalePayload,
            timestamp: 1_699_999_000_000,
            nonce: 'stale',
          }),
        },
        payload: body(stalePayload),
      });
      expect(stale.statusCode).toBe(400);
      expect(stale.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'admin action signature is stale' },
      });

      const payload = {
        id: 'pol-once',
        name: 'signed policy',
        effect: 'allow',
        match: { actionTypes: ['tool.*'] },
      };
      const headers = {
        authorization: `Bearer ${adminKey}`,
        ...json,
        ...adminSignatureHeaders({
          method: 'POST',
          path: '/api/permissions/policies',
          body: payload,
          nonce: 'replay',
        }),
      };
      const first = await signedApp.inject({
        method: 'POST',
        url: '/api/permissions/policies',
        headers,
        payload: body(payload),
      });
      expect(first.statusCode).toBe(200);

      const replay = await signedApp.inject({
        method: 'POST',
        url: '/api/permissions/policies',
        headers,
        payload: body({ ...payload, id: 'pol-replayed' }),
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'admin action signature nonce was already used' },
      });

      const tamperedPayload = {
        id: 'pol-tampered',
        name: 'tampered policy',
        effect: 'allow',
        match: { actionTypes: ['tool.*'] },
      };
      const tampered = await signedApp.inject({
        method: 'POST',
        url: '/api/permissions/policies',
        headers: {
          authorization: `Bearer ${adminKey}`,
          ...json,
          ...adminSignatureHeaders({
            method: 'POST',
            path: '/api/permissions/policies',
            body: { ...tamperedPayload, name: 'original body' },
            nonce: 'tampered',
          }),
        },
        payload: body(tamperedPayload),
      });
      expect(tampered.statusCode).toBe(400);
      expect(tampered.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'admin action signature is invalid' },
      });

      const policies = await signedApp.inject({
        method: 'GET',
        url: '/api/permissions/policies',
        headers: { authorization: `Bearer ${adminKey}` },
      });
      expect((policies.json() as unknown[]).map((policy) => (policy as { id: string }).id)).toEqual(
        ['pol-once'],
      );
      expect(
        (await ledger.query({ types: ['admin.action'] })).map((r: LedgerRecord) => r.event.payload),
      ).toHaveLength(1);
    } finally {
      await signedApp.close();
    }
  });
});

describe('Veritrail HTTP server limits', () => {
  it('rejects request bodies above the configured cap', async () => {
    const app = await buildServer({
      logger: false,
      limits: {
        bodyLimitBytes: 80,
        rateLimit: false,
        maxInFlightWrites: false,
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: json,
        payload: body({
          type: 'note',
          actorId: 'agent-1',
          payload: { text: 'this payload deliberately exceeds the small test body limit' },
        }),
      });

      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({
        error: { code: 'VALIDATION', message: 'request body is too large' },
      });
    } finally {
      await app.close();
    }
  });

  it('rate limits API requests by client key', async () => {
    const app = await buildServer({
      logger: false,
      limits: {
        rateLimit: { max: 1, windowMs: 60_000 },
        maxInFlightWrites: false,
      },
      auth: {
        apiKeys: [
          {
            id: 'operator',
            actorId: 'operator-1',
            secret: 'operator-secret-0001',
            roles: ['operator'],
          },
        ],
      },
    });
    try {
      const headers = { authorization: 'Bearer operator-secret-0001' };
      const first = await app.inject({ method: 'GET', url: '/api/audit/summary', headers });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({ method: 'GET', url: '/api/audit/summary', headers });
      expect(second.statusCode).toBe(429);
      expect(second.headers['retry-after']).toBe('60');
      expect(second.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    } finally {
      await app.close();
    }
  });

  it('returns 503 when write-route concurrency is saturated', async () => {
    const ledger = createInMemoryLedger();
    const originalAppend = ledger.append.bind(ledger);
    let releaseFirstAppend: (() => void) | undefined;
    let firstAppendStarted: (() => void) | undefined;
    const firstAppendStartedPromise = new Promise<void>((resolve) => {
      firstAppendStarted = resolve;
    });
    const releaseFirstAppendPromise = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    let appendCount = 0;
    ledger.append = async (input: unknown) => {
      appendCount += 1;
      if (appendCount === 1) {
        firstAppendStarted?.();
        await releaseFirstAppendPromise;
      }
      return originalAppend(input);
    };

    const app = await buildServer({
      logger: false,
      ledger,
      limits: {
        rateLimit: false,
        maxInFlightWrites: 1,
      },
    });
    try {
      const first = app.inject({
        method: 'POST',
        url: '/api/events',
        headers: json,
        payload: body({ type: 'note', actorId: 'agent-1', payload: { text: 'first' } }),
      });
      await firstAppendStartedPromise;

      const second = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: json,
        payload: body({ type: 'note', actorId: 'agent-1', payload: { text: 'second' } }),
      });
      expect(second.statusCode).toBe(503);
      expect(second.headers['retry-after']).toBe('1');
      expect(second.json()).toMatchObject({
        error: { code: 'STORAGE', message: 'server write capacity is saturated' },
      });

      releaseFirstAppend?.();
      const firstResult = await first;
      expect(firstResult.statusCode).toBe(201);
      expect(await ledger.count()).toBe(1);
    } finally {
      releaseFirstAppend?.();
      await app.close();
    }
  });
});
