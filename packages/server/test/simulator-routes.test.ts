import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  type Ledger,
  type Policy,
} from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';
import { registerSimulatorRoutes } from '../src/simulator-routes.js';

async function makeServer(seed: 'empty' | 'with-actions') {
  const ledger: Ledger = createInMemoryLedger({
    clock: new FixedClock(1_000_000),
    ids: new SequentialIdGenerator(),
  });

  if (seed === 'with-actions') {
    const proposals = [
      { actorId: 'agent-a', type: 'tool.search', actionId: 'act-1' },
      { actorId: 'agent-a', type: 'tool.execute', actionId: 'act-2' },
      { actorId: 'agent-b', type: 'tool.search', actionId: 'act-3' },
    ];
    for (const p of proposals) {
      const r = await ledger.append({
        type: 'action.proposed',
        actorId: p.actorId,
        payload: {
          action: {
            id: p.actionId,
            actorId: p.actorId,
            type: p.type,
            target: '',
            params: {},
            reversible: false,
            status: 'proposed',
            context: {},
          },
        },
      });
      if (!r.ok) throw new Error('seed proposal failed: ' + r.error.message);
    }
    await ledger.append({
      type: 'action.authorized',
      actorId: 'agent-a',
      payload: { actionId: 'act-1', policyId: 'pol-default-allow' },
    });
    await ledger.append({
      type: 'action.authorized',
      actorId: 'agent-a',
      payload: { actionId: 'act-2', policyId: 'pol-default-allow' },
    });
    await ledger.append({
      type: 'action.authorized',
      actorId: 'agent-b',
      payload: { actionId: 'act-3', policyId: 'pol-default-allow' },
    });
  }

  const app = await buildServer({ ledger, logger: false });
  registerSimulatorRoutes(app, { ledger });
  await app.ready();
  return { app, ledger };
}

const denyAllPolicy: Policy = {
  id: 'pol-deny-all',
  name: 'Deny everything',
  description: '',
  effect: 'deny',
  match: {},
  enabled: true,
  priority: 100,
};

describe('simulator HTTP route', () => {
  it('returns 400 when the request body is missing', async () => {
    const { app } = await makeServer('empty');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/simulator/run',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when proposedPolicies is not an array', async () => {
    const { app } = await makeServer('empty');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/simulator/run',
      payload: { proposedPolicies: 'not-an-array' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with eventsChanged 0 when ledger is empty', async () => {
    const { app } = await makeServer('empty');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/simulator/run',
      payload: { proposedPolicies: [] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.blastRadius.eventsReplayed).toBe(0);
    expect(body.blastRadius.eventsChanged).toBe(0);
    expect(body.decisions).toHaveLength(0);
    expect(body.newlyDeniedSamples).toHaveLength(0);
  });

  it('returns nonzero eventsChanged when a deny-all policy is proposed against authorized actions', async () => {
    const { app } = await makeServer('with-actions');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/simulator/run',
      payload: { proposedPolicies: [denyAllPolicy] },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.blastRadius.eventsReplayed).toBe(3);
    expect(body.blastRadius.eventsChanged).toBeGreaterThan(0);
    expect(body.diff.nowAllow_thenDeny).toBe(3);
    expect(body.newlyDeniedSamples.length).toBeGreaterThan(0);
  });

  it('returns 400 when a proposed policy fails schema validation', async () => {
    const { app } = await makeServer('empty');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/simulator/run',
      payload: {
        proposedPolicies: [
          {
            id: 'pol-broken',
            // missing required `name`
            effect: 'deny',
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when window is not an object', async () => {
    const { app } = await makeServer('empty');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/simulator/run',
      payload: { proposedPolicies: [], window: 'not-an-object' },
    });
    expect(res.statusCode).toBe(400);
  });
});
