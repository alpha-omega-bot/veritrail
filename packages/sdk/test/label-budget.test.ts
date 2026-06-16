import { describe, expect, it } from 'vitest';

import { createInMemoryLedger, FixedClock, money, SequentialIdGenerator } from '@veritrail/core';

import { Governor } from '../src/index.js';

describe('Governor label-scoped budgets', () => {
  it('accrues spend to a label-scoped budget and hard-stops it', async () => {
    const ledger = createInMemoryLedger({
      clock: new FixedClock(1_700_000_000_000),
      ids: new SequentialIdGenerator(),
    });
    const governor = new Governor(ledger);
    governor.permissions.addPolicy({ name: 'allow all', effect: 'allow', match: {} });
    governor.spendGuard.setBudget({
      name: 'ml team cap',
      scope: { kind: 'label', value: 'team=ml' },
      limit: money(100),
    });

    const first = await governor.run(
      { actorId: 'agent-1', type: 'tool.call', cost: money(60) },
      async () => 'ok',
      { labels: { team: 'ml' } },
    );
    expect(first.ok).toBe(true);

    // The label budget must have accrued the first charge, so the second is blocked.
    const second = await governor.run(
      { actorId: 'agent-1', type: 'tool.call', cost: money(60) },
      async () => 'ok',
      { labels: { team: 'ml' } },
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('BUDGET_EXCEEDED');
  });
});
