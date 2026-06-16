import { describe, it, expect } from 'vitest';
import {
  FixedClock,
  SequentialIdGenerator,
  createInMemoryLedger,
  isErr,
  isOk,
  money,
  unwrap,
  type Ledger,
  type ModuleContext,
} from '@veritrail/core';

import { type SpendGuardModule, createSpendGuardModule } from '../src/index.js';
import { withinWindow, windowStart } from '../src/index.js';

const START = 1_700_000_000_000;

function makeCtx(): { ctx: ModuleContext; ledger: Ledger; clock: FixedClock } {
  const clock = new FixedClock(START);
  const ledger = createInMemoryLedger({ clock, ids: new SequentialIdGenerator() });
  const ctx: ModuleContext = {
    ledger,
    clock,
    ids: new SequentialIdGenerator(),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
  };
  return { ctx, ledger, clock };
}

function makeModule(): {
  mod: SpendGuardModule;
  ledger: Ledger;
  clock: FixedClock;
  ctx: ModuleContext;
} {
  const { ctx, ledger, clock } = makeCtx();
  return { mod: createSpendGuardModule(ctx), ledger, clock, ctx };
}

describe('SpendGuardModule.info', () => {
  it('reports the spend-guard capability', () => {
    const { mod } = makeModule();
    expect(mod.info).toEqual({
      name: '@veritrail/spend-guard',
      version: '0.1.0',
      capability: 'spend-guard',
    });
  });
});

describe('setBudget / listBudgets', () => {
  it('assigns an id when absent and stores the budget', () => {
    const { mod } = makeModule();
    const res = mod.setBudget({
      name: 'global cap',
      scope: { kind: 'global' },
      limit: money(1000),
    });
    expect(isOk(res)).toBe(true);
    const b = unwrap(res);
    expect(b.id).toMatch(/^bud/);
    expect(b.window).toBe('total');
    expect(b.hardStop).toBe(true);
    expect(b.enabled).toBe(true);
    expect(mod.listBudgets()).toHaveLength(1);
  });

  it('upserts by id', () => {
    const { mod } = makeModule();
    const first = unwrap(
      mod.setBudget({ id: 'bud-x', name: 'a', scope: { kind: 'global' }, limit: money(100) }),
    );
    mod.setBudget({ id: 'bud-x', name: 'a renamed', scope: { kind: 'global' }, limit: money(200) });
    expect(mod.listBudgets()).toHaveLength(1);
    const only = mod.listBudgets()[0]!;
    expect(only.id).toBe(first.id);
    expect(only.name).toBe('a renamed');
    expect(only.limit.amountMinor).toBe(200);
  });

  it('rejects invalid input with a VALIDATION error', () => {
    const { mod } = makeModule();
    const res = mod.setBudget({ name: '', scope: { kind: 'global' }, limit: money(-5) });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('VALIDATION');
  });
});

describe('charge accumulates spend', () => {
  it('sums charges into status().spent and reduces remaining', async () => {
    const { mod } = makeModule();
    mod.setBudget({ name: 'global', scope: { kind: 'global' }, limit: money(1000) });

    expect(isOk(await mod.charge({ actorId: 'agent-1', amount: money(300) }))).toBe(true);
    expect(isOk(await mod.charge({ actorId: 'agent-1', amount: money(200) }))).toBe(true);

    const status = await mod.status();
    expect(status).toHaveLength(1);
    const s = status[0]!;
    expect(s.spent.amountMinor).toBe(500);
    expect(s.remaining.amountMinor).toBe(500);
    expect(s.exceeded).toBe(false);
  });

  it('appends a budget.charged event with an actor scope', async () => {
    const { mod, ledger } = makeModule();
    mod.setBudget({ name: 'global', scope: { kind: 'global' }, limit: money(1000) });
    const res = await mod.charge({ actorId: 'agent-1', amount: money(100), actionId: 'act-1' });
    expect(isOk(res)).toBe(true);
    const charged = (await ledger.query({ types: ['budget.charged'] }))[0]!;
    expect(charged.event.type).toBe('budget.charged');
    if (charged.event.type === 'budget.charged') {
      expect(charged.event.payload.scope).toEqual({ kind: 'actor', value: 'agent-1' });
      expect(charged.event.payload.amount.amountMinor).toBe(100);
      expect(charged.event.payload.actionId).toBe('act-1');
    }
  });
});

describe('hard-stop enforcement', () => {
  it('allows reaching the limit exactly but blocks exceeding it', async () => {
    const { mod, ledger } = makeModule();
    mod.setBudget({ name: 'cap', scope: { kind: 'global' }, limit: money(1000) });

    expect(isOk(await mod.charge({ actorId: 'a', amount: money(1000) }))).toBe(true);

    const res = await mod.charge({ actorId: 'a', amount: money(1) });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.code).toBe('BUDGET_EXCEEDED');
      expect(res.error.details).toMatchObject({ limit: 1000, projected: 1001 });
    }

    // budget.exceeded appended; no second budget.charged.
    expect(await ledger.query({ types: ['budget.exceeded'] })).toHaveLength(1);
    expect(await ledger.query({ types: ['budget.charged'] })).toHaveLength(1);
  });

  it('authorize does not record a charge', async () => {
    const { mod, ledger } = makeModule();
    mod.setBudget({ name: 'cap', scope: { kind: 'global' }, limit: money(500) });
    expect(isOk(await mod.authorize({ actorId: 'a', amount: money(400) }))).toBe(true);
    expect(await ledger.query({ types: ['budget.charged'] })).toHaveLength(0);
  });

  it('skips a budget whose currency differs from the charge (does not abort)', async () => {
    const { mod } = makeModule();
    mod.setBudget({ name: 'usd', scope: { kind: 'global' }, limit: money(1000, 'USD') });
    // A USD budget does not apply to a EUR charge: it is skipped, not a failure.
    const res = await mod.authorize({ actorId: 'a', amount: money(10, 'EUR') });
    expect(isOk(res)).toBe(true);
  });
});

describe('soft budgets', () => {
  it('allows overrun but warns', async () => {
    const { ctx } = makeCtx();
    const warnings: string[] = [];
    const mod = createSpendGuardModule({
      ...ctx,
      logger: {
        debug() {},
        info() {},
        warn(m) {
          warnings.push(m);
        },
        error() {},
        child() {
          return this;
        },
      },
    });
    mod.setBudget({ name: 'soft', scope: { kind: 'global' }, limit: money(100), hardStop: false });

    const res = await mod.charge({ actorId: 'a', amount: money(250) });
    expect(isOk(res)).toBe(true);
    expect(warnings).toContain('spend-guard.soft-budget-exceeded');

    const s = (await mod.status())[0]!;
    expect(s.spent.amountMinor).toBe(250);
    expect(s.remaining.amountMinor).toBe(-150);
    expect(s.exceeded).toBe(true);
  });
});

describe('scoped budgets', () => {
  it('actor-scoped budget only counts its actor', async () => {
    const { mod } = makeModule();
    mod.setBudget({
      name: 'agent-1 cap',
      scope: { kind: 'actor', value: 'agent-1' },
      limit: money(100),
    });

    // Different actor: budget does not match, so it is unconstrained.
    expect(isOk(await mod.charge({ actorId: 'agent-2', amount: money(500) }))).toBe(true);
    // agent-2's charge carries an actor scope of agent-2, so agent-1's budget stays at 0.
    expect((await mod.status())[0]!.spent.amountMinor).toBe(0);

    expect(isOk(await mod.charge({ actorId: 'agent-1', amount: money(100) }))).toBe(true);
    expect((await mod.status())[0]!.spent.amountMinor).toBe(100);

    const res = await mod.charge({ actorId: 'agent-1', amount: money(1) });
    expect(isErr(res)).toBe(true);
  });

  it('label-scoped budget matches via input labels', async () => {
    const { mod, ledger } = makeModule();
    mod.setBudget({
      name: 'team cap',
      scope: { kind: 'label', value: 'team=blue' },
      limit: money(100),
    });

    // No matching label -> unconstrained, but the emitted charge has an actor
    // scope so it does NOT accrue to the label budget.
    expect(isOk(await mod.charge({ actorId: 'a', amount: money(999) }))).toBe(true);
    expect((await mod.status())[0]!.spent.amountMinor).toBe(0);

    // Matching label is enforced.
    expect(
      isOk(await mod.charge({ actorId: 'a', amount: money(80), labels: { team: 'blue' } })),
    ).toBe(true);
    const res = await mod.charge({ actorId: 'a', amount: money(80), labels: { team: 'blue' } });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('BUDGET_EXCEEDED');
    expect(await ledger.query({ types: ['budget.exceeded'] })).toHaveLength(1);
  });

  it('disabled budgets are not enforced', async () => {
    const { mod } = makeModule();
    mod.setBudget({ name: 'off', scope: { kind: 'global' }, limit: money(10), enabled: false });
    expect(isOk(await mod.charge({ actorId: 'a', amount: money(1000) }))).toBe(true);
  });
});

describe('window filtering', () => {
  it('daily window drops charges older than 24h', async () => {
    const { mod, clock } = makeModule();
    mod.setBudget({
      name: 'daily',
      scope: { kind: 'global' },
      limit: money(1000),
      window: 'daily',
    });

    expect(isOk(await mod.charge({ actorId: 'a', amount: money(400) }))).toBe(true);
    expect((await mod.status())[0]!.spent.amountMinor).toBe(400);

    // Advance just over a day: the old charge falls outside the window.
    clock.advance(86_400_000 + 1);
    expect((await mod.status())[0]!.spent.amountMinor).toBe(0);

    // A fresh charge of the full limit is now allowed.
    expect(isOk(await mod.charge({ actorId: 'a', amount: money(1000) }))).toBe(true);
    expect((await mod.status())[0]!.spent.amountMinor).toBe(1000);
  });

  it('total window counts all history', async () => {
    const { mod, clock } = makeModule();
    mod.setBudget({
      name: 'lifetime',
      scope: { kind: 'global' },
      limit: money(1000),
      window: 'total',
    });
    expect(isOk(await mod.charge({ actorId: 'a', amount: money(400) }))).toBe(true);
    clock.advance(90 * 86_400_000);
    expect((await mod.status())[0]!.spent.amountMinor).toBe(400);
  });
});

describe('window helpers', () => {
  it('windowStart returns 0 for total and a bounded floor', () => {
    expect(windowStart('total', START)).toBe(0);
    expect(windowStart('daily', START)).toBe(START - 86_400_000);
    expect(windowStart('weekly', 10)).toBe(0); // never negative
  });

  it('withinWindow respects the bounds', () => {
    expect(withinWindow('daily', START, START)).toBe(true);
    expect(withinWindow('daily', START - 86_400_000 - 1, START)).toBe(false);
    expect(withinWindow('daily', START + 1, START)).toBe(false); // future
  });
});
