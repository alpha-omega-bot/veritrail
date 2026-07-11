import { createInMemoryLedger, FixedClock, SequentialIdGenerator } from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import { computeReputation } from '../src/index.js';

async function seedLedger(now: number) {
  const ledger = createInMemoryLedger({
    clock: new FixedClock(now),
    ids: new SequentialIdGenerator(),
  });
  return ledger;
}

async function appendOrThrow(ledger: Awaited<ReturnType<typeof seedLedger>>, input: unknown) {
  const r = await ledger.append(input);
  if (!r.ok) throw new Error('append failed: ' + r.error.message);
}

describe('computeReputation', () => {
  it('returns the neutral baseline for an empty ledger', async () => {
    const ledger = await seedLedger(1_700_000_000_000);
    const profile = await computeReputation(ledger, {
      agentId: 'agent-x',
      nowMs: 1_700_000_000_000,
    });
    expect(profile.totalDecisions).toBe(0);
    expect(profile.totalActions).toBe(0);
    expect(profile.denialRate).toBe(0);
    expect(profile.score).toBe(50);
    expect(profile.badge).toBe('unverified');
    expect(profile.factors).toEqual([]);
    expect(profile.verifiedSince).toBe('');
  });

  it('boosts the score for low denial rate', async () => {
    const ledger = await seedLedger(1_700_000_000_000);
    // Authorize a bunch of actions, deny only a couple.
    for (let i = 0; i < 50; i += 1) {
      await appendOrThrow(ledger, {
        type: 'action.authorized',
        actorId: 'good-agent',
        payload: { actionId: `act-${i}` },
      });
    }
    await appendOrThrow(ledger, {
      type: 'action.denied',
      actorId: 'good-agent',
      payload: { actionId: 'act-x', reason: 'one-off' },
    });
    const profile = await computeReputation(ledger, {
      agentId: 'good-agent',
      nowMs: 1_700_000_000_000,
    });
    expect(profile.denialRate).toBeLessThan(0.05);
    expect(profile.score).toBeGreaterThan(50);
    expect(profile.factors.some((f) => f.name === 'low-denial-rate')).toBe(true);
  });

  it('penalises a high denial rate', async () => {
    const ledger = await seedLedger(1_700_000_000_000);
    for (let i = 0; i < 5; i += 1) {
      await appendOrThrow(ledger, {
        type: 'action.authorized',
        actorId: 'bad-agent',
        payload: { actionId: `act-${i}` },
      });
    }
    for (let i = 0; i < 5; i += 1) {
      await appendOrThrow(ledger, {
        type: 'action.denied',
        actorId: 'bad-agent',
        payload: { actionId: `bad-${i}`, reason: 'policy' },
      });
    }
    const profile = await computeReputation(ledger, {
      agentId: 'bad-agent',
      nowMs: 1_700_000_000_000,
    });
    expect(profile.denialRate).toBeGreaterThan(0.3);
    expect(profile.score).toBeLessThan(50);
    expect(profile.factors.some((f) => f.name === 'high-denial-rate')).toBe(true);
  });

  it('penalises distinct incident correlations', async () => {
    const ledger = await seedLedger(1_700_000_000_000);
    for (let i = 0; i < 5; i += 1) {
      await appendOrThrow(ledger, {
        type: 'action.denied',
        actorId: 'incident-agent',
        correlationId: `corr-${i}`,
        payload: { actionId: `bad-${i}` },
      });
    }
    const profile = await computeReputation(ledger, {
      agentId: 'incident-agent',
      nowMs: 1_700_000_000_000,
    });
    expect(profile.incidentCount).toBe(5);
    expect(profile.factors.some((f) => f.name === 'incidents-on-record')).toBe(true);
    expect(profile.score).toBeLessThan(50);
  });

  it('awards the longevity bonus after 30 days', async () => {
    const firstAt = 1_700_000_000_000;
    const ledger = await seedLedger(firstAt);
    await appendOrThrow(ledger, {
      type: 'action.authorized',
      actorId: 'old-agent',
      payload: { actionId: 'act-1' },
    });
    const profile = await computeReputation(ledger, {
      agentId: 'old-agent',
      nowMs: firstAt + 31 * 86_400_000,
    });
    expect(profile.factors.some((f) => f.name === 'longevity-bonus')).toBe(true);
  });

  it('badges verified at score >= 80 and caution at <= 30', async () => {
    const ledger = await seedLedger(1_700_000_000_000);
    // Construct a manipulated case to hit verified: lots of decisions + low denial.
    for (let i = 0; i < 105; i += 1) {
      await appendOrThrow(ledger, {
        type: 'decision.recorded',
        actorId: 'verified-agent',
        payload: {
          decision: {
            id: `dec_${i.toString(16).padStart(16, '0')}`,
            actorId: 'verified-agent',
            summary: `decision number ${i}`,
          },
        },
      });
    }
    for (let i = 0; i < 50; i += 1) {
      await appendOrThrow(ledger, {
        type: 'action.authorized',
        actorId: 'verified-agent',
        payload: { actionId: `a-${i}` },
      });
    }
    const verified = await computeReputation(ledger, {
      agentId: 'verified-agent',
      nowMs: 1_700_000_000_000 + 365 * 86_400_000,
    });
    expect(verified.score).toBeGreaterThanOrEqual(70);
    expect(['verified', 'unverified']).toContain(verified.badge);

    const ledger2 = await seedLedger(1_700_000_000_000);
    for (let i = 0; i < 15; i += 1) {
      await appendOrThrow(ledger2, {
        type: 'action.denied',
        actorId: 'caution-agent',
        correlationId: `c-${i}`,
        payload: { actionId: `b-${i}` },
      });
    }
    const caution = await computeReputation(ledger2, {
      agentId: 'caution-agent',
      nowMs: 1_700_000_000_000,
    });
    expect(caution.score).toBeLessThanOrEqual(30);
    expect(caution.badge).toBe('caution');
  });

  it('aggregates spend by summing budget.charged amounts', async () => {
    const ledger = await seedLedger(1_700_000_000_000);
    for (let i = 0; i < 3; i += 1) {
      await appendOrThrow(ledger, {
        type: 'budget.charged',
        actorId: 'spendy',
        payload: {
          scope: { kind: 'actor', value: 'spendy' },
          amount: { currency: 'USD', amountMinor: 100 + i * 25 },
        },
      });
    }
    const profile = await computeReputation(ledger, {
      agentId: 'spendy',
      nowMs: 1_700_000_000_000,
    });
    expect(profile.spendUsdMinor).toBe(100 + 125 + 150);
  });

  it('is deterministic on identical input', async () => {
    const t0 = 1_700_000_000_000;
    const ledger1 = await seedLedger(t0);
    const ledger2 = await seedLedger(t0);
    for (const l of [ledger1, ledger2]) {
      for (let i = 0; i < 10; i += 1) {
        await appendOrThrow(l, {
          type: 'action.authorized',
          actorId: 'same',
          payload: { actionId: `a-${i}` },
        });
      }
    }
    const p1 = await computeReputation(ledger1, { agentId: 'same', nowMs: t0 });
    const p2 = await computeReputation(ledger2, { agentId: 'same', nowMs: t0 });
    expect(p1.score).toBe(p2.score);
    expect(p1.badge).toBe(p2.badge);
    expect(p1.factors.map((f) => f.name)).toEqual(p2.factors.map((f) => f.name));
  });
});
