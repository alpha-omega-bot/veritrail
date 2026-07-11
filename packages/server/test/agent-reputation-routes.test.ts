import { createInMemoryLedger, FixedClock } from '@veritrail/core';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerAgentReputationRoutes } from '../src/agent-reputation-routes.js';

async function makeApp(nowMs = 1_700_000_000_000) {
  const clock = new FixedClock(nowMs);
  const ledger = createInMemoryLedger({ clock });
  const app = Fastify({ logger: false });
  registerAgentReputationRoutes(app, { ledger });
  await app.ready();
  return { app, ledger };
}

describe('agent-reputation HTTP routes', () => {
  it('GET /reputation on an empty ledger returns a neutral profile', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/agent-x/reputation',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      agentId: string;
      totalDecisions: number;
      totalActions: number;
      denialRate: number;
      score: number;
      badge: string;
      factors: unknown[];
      verifiedSince: string;
    };
    expect(body.agentId).toBe('agent-x');
    expect(body.totalDecisions).toBe(0);
    expect(body.totalActions).toBe(0);
    expect(body.denialRate).toBe(0);
    expect(body.score).toBe(50);
    expect(body.badge).toBe('unverified');
    expect(body.factors).toEqual([]);
    expect(body.verifiedSince).toBe('');
    await app.close();
  });

  it('GET /reputation lowers the score when denials are recorded for the agent', async () => {
    const { app, ledger } = await makeApp();
    for (let i = 0; i < 5; i += 1) {
      await ledger.append({
        type: 'action.authorized',
        actorId: 'bad-agent',
        payload: { actionId: `act-${i}` },
      });
    }
    for (let i = 0; i < 5; i += 1) {
      await ledger.append({
        type: 'action.denied',
        actorId: 'bad-agent',
        correlationId: `corr-${i}`,
        payload: { actionId: `bad-${i}`, reason: 'policy' },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/bad-agent/reputation',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      score: number;
      denialRate: number;
      badge: string;
      factors: Array<{ name: string }>;
    };
    expect(body.denialRate).toBeGreaterThan(0.3);
    expect(body.score).toBeLessThan(50);
    expect(body.factors.some((f) => f.name === 'high-denial-rate')).toBe(true);
    await app.close();
  });

  it('GET /reputation responds with application/json content-type', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/agent-1/reputation',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    await app.close();
  });

  it('GET /reputation/badge returns image/svg+xml with the badge label embedded', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/agent-1/reputation/badge',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.body).toContain('<svg');
    expect(res.body).toContain('unverified');
    expect(res.body).toContain('width="180"');
    expect(res.body).toContain('height="28"');
    await app.close();
  });

  it('GET /reputation/badge for a high-denial agent surfaces the "caution" label', async () => {
    const { app, ledger } = await makeApp();
    for (let i = 0; i < 15; i += 1) {
      await ledger.append({
        type: 'action.denied',
        actorId: 'caution-agent',
        correlationId: `c-${i}`,
        payload: { actionId: `b-${i}` },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/caution-agent/reputation/badge',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.body).toContain('caution');
    await app.close();
  });

  it('GET on the parent /api/v1/agent path with no agentId or sub-route returns 404', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /reputation echoes the agentId from the URL into the profile', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/some-unique-id-42/reputation',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { agentId: string };
    expect(body.agentId).toBe('some-unique-id-42');
    await app.close();
  });
});
