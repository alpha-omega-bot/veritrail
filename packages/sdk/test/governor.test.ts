import { describe, expect, it } from 'vitest';

import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  money,
  type Ledger,
} from '@veritrail/core';

import { Governor } from '../src/index.js';

function setup(): { ledger: Ledger; governor: Governor } {
  const ledger = createInMemoryLedger({
    clock: new FixedClock(1_700_000_000_000),
    ids: new SequentialIdGenerator(),
  });
  const governor = new Governor(ledger);
  return { ledger, governor };
}

describe('Governor.run', () => {
  it('records propose + executed for an allowed action', async () => {
    const { ledger, governor } = setup();
    governor.permissions.addPolicy({ name: 'allow all', effect: 'allow', match: {} });

    const result = await governor.run(
      { actorId: 'agent-1', type: 'tool.search', target: 'web' },
      async () => 'result-payload',
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe('result-payload');

    const types = (await ledger.readAll()).map((r) => r.event.type);
    expect(types).toContain('action.proposed');
    expect(types).toContain('action.executed');
  });

  it('denies by default and records the denial without executing', async () => {
    const { ledger, governor } = setup();
    let executed = false;

    const result = await governor.run({ actorId: 'agent-1', type: 'db.drop' }, async () => {
      executed = true;
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('POLICY_DENIED');
    expect(executed).toBe(false);
    const types = (await ledger.readAll()).map((r) => r.event.type);
    expect(types).toContain('action.denied');
    expect(types).not.toContain('action.executed');
  });

  it('blocks an action that would exceed a hard-stop budget', async () => {
    const { governor } = setup();
    governor.permissions.addPolicy({ name: 'allow all', effect: 'allow', match: {} });
    governor.spendGuard.setBudget({ name: 'cap', scope: { kind: 'global' }, limit: money(100) });

    const first = await governor.run(
      { actorId: 'agent-1', type: 'tool.call', cost: money(60) },
      async () => 'ok',
    );
    expect(first.ok).toBe(true);

    const second = await governor.run(
      { actorId: 'agent-1', type: 'tool.call', cost: money(60) },
      async () => 'ok',
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('BUDGET_EXCEEDED');
  });

  it('records a failure when the executor throws', async () => {
    const { ledger, governor } = setup();
    governor.permissions.addPolicy({ name: 'allow all', effect: 'allow', match: {} });

    const result = await governor.run({ actorId: 'agent-1', type: 'tool.call' }, async () => {
      throw new Error('boom');
    });

    expect(result.ok).toBe(false);
    const types = (await ledger.readAll()).map((r) => r.event.type);
    expect(types).toContain('action.failed');
  });
});
