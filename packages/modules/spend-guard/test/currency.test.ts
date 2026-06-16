import { describe, expect, it } from 'vitest';

import {
  createInMemoryLedger,
  FixedClock,
  money,
  noopLogger,
  SequentialIdGenerator,
  type ModuleContext,
} from '@veritrail/core';

import { createSpendGuardModule } from '../src/index.js';

function ctx(): ModuleContext {
  const clock = new FixedClock(1_700_000_000_000);
  return {
    ledger: createInMemoryLedger({ clock, ids: new SequentialIdGenerator() }),
    clock,
    ids: new SequentialIdGenerator(),
    logger: noopLogger,
  };
}

describe('spend-guard cross-currency budgets', () => {
  it('skips a budget in another currency instead of aborting the charge', async () => {
    const sg = createSpendGuardModule(ctx());
    // A foreign-currency budget that matches by scope must not block a charge.
    sg.setBudget({ name: 'eur cap', scope: { kind: 'global' }, limit: money(100, 'EUR') });
    sg.setBudget({ name: 'usd cap', scope: { kind: 'global' }, limit: money(1000, 'USD') });

    const result = await sg.charge({ actorId: 'agent-1', amount: money(50, 'USD') });
    expect(result.ok).toBe(true);
  });

  it('still enforces the matching-currency budget', async () => {
    const sg = createSpendGuardModule(ctx());
    sg.setBudget({ name: 'eur cap', scope: { kind: 'global' }, limit: money(100, 'EUR') });
    sg.setBudget({ name: 'usd cap', scope: { kind: 'global' }, limit: money(40, 'USD') });

    const result = await sg.charge({ actorId: 'agent-1', amount: money(50, 'USD') });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BUDGET_EXCEEDED');
  });
});
