import { createInMemoryLedger, FixedClock, SequentialIdGenerator } from '@veritrail/core';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { registerCostOptimizerRoutes } from '../src/cost-optimizer-routes.js';

async function newApp(now = 1_700_000_000_000) {
  const ledger = createInMemoryLedger({
    clock: new FixedClock(now),
    ids: new SequentialIdGenerator(),
  });
  const app = Fastify({ logger: false });
  registerCostOptimizerRoutes(app, { ledger });
  await app.ready();
  return { app, ledger };
}

describe('cost-optimizer route', () => {
  it('rejects missing body fields with 400', async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cost-optimizer/forecast',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an inverted period with 400', async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cost-optimizer/forecast',
      payload: { periodStartMs: 2000, periodEndMs: 1000 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns a null forecast and empty arrays when the ledger has no budget.charged events', async () => {
    const { app } = await newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cost-optimizer/forecast',
      payload: { periodStartMs: 1_000_000, periodEndMs: 100_000_000 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.forecast).toBeNull();
    expect(body.anomalies).toEqual([]);
    expect(body.recommendations).toEqual([]);
    await app.close();
  });

  it('returns a non-null forecast when multiple budget.charged events fall in the window', async () => {
    // Build the ledger with the clock pinned mid-window so the forecast has
    // non-zero progress to extrapolate from.
    const periodStartMs = 1_700_000_000_000;
    const periodEndMs = periodStartMs + 30 * 86_400_000;
    const nowMs = periodStartMs + 5 * 86_400_000;
    const ledger = createInMemoryLedger({
      clock: new FixedClock(nowMs),
      ids: new SequentialIdGenerator(),
    });
    const app = Fastify({ logger: false });
    registerCostOptimizerRoutes(app, { ledger });
    await app.ready();

    for (let i = 0; i < 5; i += 1) {
      const r = await ledger.append({
        type: 'budget.charged',
        actorId: 'agent-1',
        payload: {
          scope: { kind: 'global', value: '' },
          amount: { currency: 'USD', amountMinor: 100 + i * 10 },
        },
      });
      if (!r.ok) throw new Error('append failed: ' + r.error.message);
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cost-optimizer/forecast',
      payload: { periodStartMs, periodEndMs },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.forecast).not.toBeNull();
    expect(typeof body.forecast.projectedTotalMinor).toBe('number');
    expect(body.forecast.actualTotalMinor).toBe(100 + 110 + 120 + 130 + 140);
    expect(Array.isArray(body.anomalies)).toBe(true);
    expect(Array.isArray(body.recommendations)).toBe(true);
    await app.close();
  });
});
