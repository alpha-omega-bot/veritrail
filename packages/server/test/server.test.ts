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
