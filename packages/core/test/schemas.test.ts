import { describe, expect, it } from 'vitest';

import {
  ActionSchema,
  BudgetSchema,
  EventInputSchema,
  MoneySchema,
  PolicySchema,
  addMoney,
  compareMoney,
  money,
} from '@veritrail/core';

describe('ActionSchema', () => {
  it('applies safe defaults', () => {
    const action = ActionSchema.parse({ id: 'act_1', actorId: 'agent_1', type: 'tool.call' });
    expect(action.status).toBe('proposed');
    expect(action.reversible).toBe(false);
    expect(action.params).toEqual({});
    expect(action.target).toBe('');
  });

  it('rejects an action without an actor', () => {
    const result = ActionSchema.safeParse({ id: 'act_1', type: 'tool.call' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    const result = ActionSchema.safeParse({
      id: 'act_1',
      actorId: 'agent_1',
      type: 'tool.call',
      bogus: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('PolicySchema', () => {
  it('defaults to enabled with priority 0 and match-all', () => {
    const policy = PolicySchema.parse({ id: 'pol_1', name: 'default-deny', effect: 'deny' });
    expect(policy.enabled).toBe(true);
    expect(policy.priority).toBe(0);
    expect(policy.match).toEqual({});
  });
});

describe('BudgetSchema', () => {
  it('hard-stops by default', () => {
    const budget = BudgetSchema.parse({
      id: 'bud_1',
      name: 'cap',
      scope: { kind: 'global' },
      limit: money(10_000),
    });
    expect(budget.hardStop).toBe(true);
    expect(budget.window).toBe('total');
  });

  it('rejects a negative limit', () => {
    const result = BudgetSchema.safeParse({
      id: 'bud_1',
      name: 'cap',
      scope: { kind: 'global' },
      limit: money(-1),
    });
    expect(result.success).toBe(false);
  });
});

describe('MoneySchema and helpers', () => {
  it('rejects non-integer minor units', () => {
    expect(MoneySchema.safeParse({ currency: 'USD', amountMinor: 1.5 }).success).toBe(false);
  });

  it('adds same-currency amounts and rejects cross-currency', () => {
    const sum = addMoney(money(100), money(50));
    expect(sum.ok && sum.value.amountMinor).toBe(150);
    const bad = addMoney(money(100, 'USD'), money(50, 'EUR'));
    expect(bad.ok).toBe(false);
  });

  it('compares same-currency amounts and throws cross-currency', () => {
    expect(compareMoney(money(100), money(50))).toBeGreaterThan(0);
    expect(() => compareMoney(money(1, 'USD'), money(1, 'EUR'))).toThrow();
  });
});

describe('EventInputSchema', () => {
  it('parses a well-formed budget.charged event', () => {
    const result = EventInputSchema.safeParse({
      type: 'budget.charged',
      actorId: 'agent_1',
      payload: { scope: { kind: 'global', value: '' }, amount: money(250) },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown event type', () => {
    const result = EventInputSchema.safeParse({ type: 'made.up', actorId: 'a', payload: {} });
    expect(result.success).toBe(false);
  });

  it('rejects a known type with the wrong payload shape', () => {
    const result = EventInputSchema.safeParse({
      type: 'note',
      actorId: 'agent_1',
      payload: { wrong: true },
    });
    expect(result.success).toBe(false);
  });

  it('parses strict admin.action events', () => {
    const result = EventInputSchema.safeParse({
      type: 'admin.action',
      actorId: 'operator_1',
      payload: {
        action: 'policy.created',
        targetType: 'policy',
        targetId: 'pol_1',
        details: { effect: 'allow' },
      },
    });
    expect(result.success).toBe(true);

    const unknownField = EventInputSchema.safeParse({
      type: 'admin.action',
      actorId: 'operator_1',
      payload: {
        action: 'policy.created',
        targetType: 'policy',
        unexpected: true,
      },
    });
    expect(unknownField.success).toBe(false);
  });
});
