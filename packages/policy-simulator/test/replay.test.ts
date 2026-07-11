import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  type Policy,
} from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import { simulatePolicies } from '../src/replay.js';

async function setupLedger() {
  const ledger = createInMemoryLedger({
    clock: new FixedClock(1_000_000),
    ids: new SequentialIdGenerator(),
  });

  // Three historical actions:
  //   1. agent-a / tool.search (was authorized)
  //   2. agent-a / tool.execute (was denied)
  //   3. agent-b / tool.search (was authorized)
  const proposals = [
    { actorId: 'agent-a', type: 'tool.search', actionId: 'act-1' },
    { actorId: 'agent-a', type: 'tool.execute', actionId: 'act-2' },
    { actorId: 'agent-b', type: 'tool.search', actionId: 'act-3' },
  ];

  for (const p of proposals) {
    const proposed = await ledger.append({
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
    if (!proposed.ok) throw new Error('proposal failed: ' + proposed.error.message);
  }

  await ledger.append({
    type: 'action.authorized',
    actorId: 'agent-a',
    payload: { actionId: 'act-1', policyId: 'pol-default-allow' },
  });
  await ledger.append({
    type: 'action.denied',
    actorId: 'agent-a',
    payload: { actionId: 'act-2', policyId: 'pol-block-execute', reason: 'high-risk' },
  });
  await ledger.append({
    type: 'action.authorized',
    actorId: 'agent-b',
    payload: { actionId: 'act-3', policyId: 'pol-default-allow' },
  });

  return ledger;
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

const allowAllPolicy: Policy = {
  id: 'pol-allow-all',
  name: 'Allow everything',
  description: '',
  effect: 'allow',
  match: {},
  enabled: true,
  priority: 100,
};

const allowOnlySearchPolicy: Policy = {
  id: 'pol-search-only',
  name: 'Allow only search tools',
  description: '',
  effect: 'allow',
  match: { actionTypes: ['tool.search'] },
  enabled: true,
  priority: 50,
};

describe('Policy simulator', () => {
  it('reports newly-denied actions when a deny-all policy is proposed', async () => {
    const ledger = await setupLedger();
    const result = await simulatePolicies({
      ledger,
      proposedPolicies: [denyAllPolicy],
    });
    expect(result.decisions).toHaveLength(3);
    // All three previously-resolved actions now get 'deny':
    expect(result.diff.nowAllow_thenDeny).toBe(2); // act-1, act-3 flipped allow→deny
    expect(result.diff.unchanged).toBe(1); // act-2 was already denied
    expect(result.blastRadius.eventsChanged).toBe(2);
    expect([...result.blastRadius.affectedActors].sort()).toEqual(['agent-a', 'agent-b']);
    expect(result.newlyDeniedSamples).toHaveLength(2);
  });

  it('reports no change when proposed policy matches historical outcomes', async () => {
    const ledger = await setupLedger();
    const result = await simulatePolicies({
      ledger,
      proposedPolicies: [allowAllPolicy],
    });
    // act-2 was historically denied; allow-all would flip it to allow
    expect(result.diff.nowDeny_thenAllow).toBe(1);
    // act-1, act-3 historically authorized — still allowed → unchanged
    expect(result.diff.unchanged).toBe(2);
    expect(result.blastRadius.changeRate).toBeCloseTo(1 / 3);
  });

  it('uses default deny effect when no proposed policy matches', async () => {
    const ledger = await setupLedger();
    const result = await simulatePolicies({
      ledger,
      proposedPolicies: [allowOnlySearchPolicy],
      // permissionsConfig defaults to deny when no match
    });
    // act-1 (search), act-3 (search): would still allow (matched search-only)
    // act-2 (execute): no match → default deny → was already deny → unchanged
    expect(result.diff.unchanged).toBe(3);
  });

  it('reports zero changes when the simulator has no events to replay', async () => {
    const ledger = createInMemoryLedger({
      clock: new FixedClock(0),
      ids: new SequentialIdGenerator(),
    });
    const result = await simulatePolicies({
      ledger,
      proposedPolicies: [denyAllPolicy],
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.blastRadius.changeRate).toBe(0);
    expect(result.newlyDeniedSamples).toHaveLength(0);
  });

  it('caches the proposed matchedPolicyId on each changed decision', async () => {
    const ledger = await setupLedger();
    const result = await simulatePolicies({
      ledger,
      proposedPolicies: [denyAllPolicy],
    });
    const flipped = result.decisions.find((d) => d.changed);
    expect(flipped?.proposedMatchedPolicyId).toBe('pol-deny-all');
  });
});
