import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createInMemoryLedger, storageError, type LedgerRecord } from '@veritrail/core';

import { buildServer } from '../src/app.js';

const json = { 'content-type': 'application/json' };
const body = (value: unknown): string => JSON.stringify(value);

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
