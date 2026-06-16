import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

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
