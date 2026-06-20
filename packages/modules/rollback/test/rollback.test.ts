import {
  FixedClock,
  SequentialIdGenerator,
  createInMemoryLedger,
  noopLogger,
  type Action,
  type ModuleContext,
} from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import {
  createRollbackModule,
  type CompensationExecutor,
  type RollbackStep,
} from '../src/index.js';

/** Build a deterministic context with a fresh in-memory ledger. */
function makeContext(): ModuleContext {
  const clock = new FixedClock(1_700_000_000_000);
  const ids = new SequentialIdGenerator();
  const ledger = createInMemoryLedger({ clock, ids });
  return { ledger, clock, ids, logger: noopLogger };
}

/** A reversible action with a `compensate` reversal descriptor. */
function reversibleAction(id: string): Action {
  return {
    id,
    actorId: 'agent-1',
    type: 'http.request',
    target: 'https://api.example.com/orders',
    params: { method: 'POST' },
    reversible: true,
    reversal: {
      strategy: 'compensate',
      inverse: {
        type: 'http.request',
        target: 'https://api.example.com/orders/cancel',
        params: {},
      },
    },
    status: 'proposed',
    context: {},
  };
}

/** A non-reversible action (strategy none / reversible false). */
function nonReversibleAction(id: string): Action {
  return {
    id,
    actorId: 'agent-1',
    type: 'email.send',
    target: 'user@example.com',
    params: {},
    reversible: false,
    status: 'proposed',
    context: {},
  };
}

async function propose(ctx: ModuleContext, action: Action, correlationId?: string): Promise<void> {
  const r = await ctx.ledger.append({
    type: 'action.proposed',
    actorId: action.actorId,
    ...(correlationId !== undefined ? { correlationId } : {}),
    payload: { action },
  });
  expect(r.ok).toBe(true);
}

async function executeAction(
  ctx: ModuleContext,
  actionId: string,
  correlationId?: string,
): Promise<void> {
  const r = await ctx.ledger.append({
    type: 'action.executed',
    actorId: 'agent-1',
    ...(correlationId !== undefined ? { correlationId } : {}),
    payload: { actionId, outcome: 'success' },
  });
  expect(r.ok).toBe(true);
}

describe('RollbackModule.info', () => {
  it('reports the rollback capability', () => {
    const mod = createRollbackModule(makeContext());
    expect(mod.info).toEqual({
      name: '@veritrail/rollback',
      version: '0.1.0',
      capability: 'rollback',
    });
  });
});

describe('planForAction', () => {
  it('plans a compensate step for a proposed+executed reversible action', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    const action = reversibleAction('act-1');
    await propose(ctx, action);
    await executeAction(ctx, 'act-1');

    const result = await mod.planForAction('act-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unreversible).toEqual([]);
    expect(result.value.steps).toHaveLength(1);
    const step = result.value.steps[0];
    expect(step?.actionId).toBe('act-1');
    expect(step?.strategy).toBe('compensate');
    expect(step?.inverse?.target).toBe('https://api.example.com/orders/cancel');
  });

  it('returns NOT_FOUND when the action was never proposed', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    const result = await mod.planForAction('missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_FOUND');
  });

  it('marks a non-reversible action as unreversible', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    await propose(ctx, nonReversibleAction('act-2'));
    await executeAction(ctx, 'act-2');

    const result = await mod.planForAction('act-2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps).toEqual([]);
    expect(result.value.unreversible).toEqual(['act-2']);
  });

  it('marks a reversible-but-not-executed action as unreversible', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    await propose(ctx, reversibleAction('act-3'));

    const result = await mod.planForAction('act-3');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps).toEqual([]);
    expect(result.value.unreversible).toEqual(['act-3']);
  });
});

describe('planForCorrelation', () => {
  it('emits reversible executed steps in reverse chronological order', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    const corr = 'run-1';
    await propose(ctx, reversibleAction('a'), corr);
    await executeAction(ctx, 'a', corr);
    await propose(ctx, reversibleAction('b'), corr);
    await executeAction(ctx, 'b', corr);
    await propose(ctx, nonReversibleAction('c'), corr);
    await executeAction(ctx, 'c', corr);

    const plan = await mod.planForCorrelation(corr);
    expect(plan.steps.map((s) => s.actionId)).toEqual(['b', 'a']);
    expect(plan.unreversible).toEqual(['c']);
  });

  it('ignores actions from other correlations', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    await propose(ctx, reversibleAction('x'), 'run-1');
    await executeAction(ctx, 'x', 'run-1');
    await propose(ctx, reversibleAction('y'), 'run-2');
    await executeAction(ctx, 'y', 'run-2');

    const plan = await mod.planForCorrelation('run-2');
    expect(plan.steps.map((s) => s.actionId)).toEqual(['y']);
  });

  it('skips reversible actions that were never executed', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    await propose(ctx, reversibleAction('z'), 'run-3');
    const plan = await mod.planForCorrelation('run-3');
    expect(plan.steps).toEqual([]);
    expect(plan.unreversible).toEqual([]);
  });
});

describe('execute', () => {
  it('appends action.rolled_back and reports rolled_back with the default executor', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    await propose(ctx, reversibleAction('act-1'));
    await executeAction(ctx, 'act-1');

    const plan = await mod.planForAction('act-1');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const result = await mod.execute(plan.value);
    expect(result.outcomes).toEqual([
      { actionId: 'act-1', status: 'rolled_back', detail: 'rolled back via compensate' },
    ]);

    const rolledBack = await ctx.ledger.query({ types: ['action.rolled_back'] });
    expect(rolledBack).toHaveLength(1);
    const ev = rolledBack[0]?.event;
    expect(ev?.type).toBe('action.rolled_back');
    if (ev?.type === 'action.rolled_back') {
      expect(ev.payload.actionId).toBe('act-1');
    }
  });

  it('invokes a custom executor and records its compensationActionId', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    await propose(ctx, reversibleAction('act-1'));
    await executeAction(ctx, 'act-1');
    const plan = await mod.planForAction('act-1');
    if (!plan.ok) throw new Error('expected plan');

    const seen: RollbackStep[] = [];
    const executor: CompensationExecutor = async (step) => {
      seen.push(step);
      return { ok: true, detail: 'cancelled', compensationActionId: 'comp-99' };
    };

    const result = await mod.execute(plan.value, executor);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.actionId).toBe('act-1');
    expect(result.outcomes[0]).toEqual({
      actionId: 'act-1',
      status: 'rolled_back',
      detail: 'cancelled',
    });

    const rolledBack = await ctx.ledger.query({ types: ['action.rolled_back'] });
    const ev = rolledBack[0]?.event;
    if (ev?.type === 'action.rolled_back') {
      expect(ev.payload.compensationActionId).toBe('comp-99');
    }
  });

  it('skips (does not append) when the executor fails', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    await propose(ctx, reversibleAction('act-1'));
    await executeAction(ctx, 'act-1');
    const plan = await mod.planForAction('act-1');
    if (!plan.ok) throw new Error('expected plan');

    const executor: CompensationExecutor = async () => ({ ok: false, detail: 'remote 500' });
    const result = await mod.execute(plan.value, executor);
    expect(result.outcomes).toEqual([
      { actionId: 'act-1', status: 'skipped', detail: 'remote 500' },
    ]);

    const rolledBack = await ctx.ledger.query({ types: ['action.rolled_back'] });
    expect(rolledBack).toHaveLength(0);
  });

  it('skips strategy=none steps without invoking the executor', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    let invoked = false;
    const executor: CompensationExecutor = async () => {
      invoked = true;
      return { ok: true };
    };

    const result = await mod.execute(
      { steps: [{ actionId: 'act-x', strategy: 'none' }], unreversible: [] },
      executor,
    );
    expect(invoked).toBe(false);
    expect(result.outcomes).toEqual([
      { actionId: 'act-x', status: 'skipped', detail: 'strategy is none' },
    ]);
  });
});

describe('tenant label scoping', () => {
  const acme = { tenant: 'acme', project: 'alpha' };
  const other = { tenant: 'other', project: 'alpha' };

  async function proposeScoped(
    ctx: ModuleContext,
    action: Action,
    labels: Record<string, string>,
    correlationId?: string,
  ): Promise<void> {
    const r = await ctx.ledger.append({
      type: 'action.proposed',
      actorId: action.actorId,
      labels,
      ...(correlationId !== undefined ? { correlationId } : {}),
      payload: { action },
    });
    expect(r.ok).toBe(true);
  }

  async function executeScoped(
    ctx: ModuleContext,
    actionId: string,
    labels: Record<string, string>,
    correlationId?: string,
  ): Promise<void> {
    const r = await ctx.ledger.append({
      type: 'action.executed',
      actorId: 'agent-1',
      labels,
      ...(correlationId !== undefined ? { correlationId } : {}),
      payload: { actionId, outcome: 'success' },
    });
    expect(r.ok).toBe(true);
  }

  it('returns NOT_FOUND when planning another tenant action under a scope', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    await proposeScoped(ctx, reversibleAction('act-other'), other);
    await executeScoped(ctx, 'act-other', other);

    const crossScope = await mod.planForAction('act-other', { labels: acme });
    expect(crossScope.ok).toBe(false);
    if (crossScope.ok) return;
    expect(crossScope.error.code).toBe('NOT_FOUND');

    // The same action is planned normally without a scope.
    const unscoped = await mod.planForAction('act-other');
    expect(unscoped.ok).toBe(true);
    if (unscoped.ok) expect(unscoped.value.steps).toHaveLength(1);
  });

  it('plans only in-scope actions of a correlation', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    const corr = 'run-mixed';
    await proposeScoped(ctx, reversibleAction('a'), acme, corr);
    await executeScoped(ctx, 'a', acme, corr);
    await proposeScoped(ctx, reversibleAction('b'), other, corr);
    await executeScoped(ctx, 'b', other, corr);

    const scoped = await mod.planForCorrelation(corr, { labels: acme });
    expect(scoped.steps.map((s) => s.actionId)).toEqual(['a']);

    const all = await mod.planForCorrelation(corr);
    expect(all.steps.map((s) => s.actionId).sort()).toEqual(['a', 'b']);
  });

  it('stamps the configured labels onto appended action.rolled_back facts', async () => {
    const ctx = makeContext();
    const mod = createRollbackModule(ctx);
    await proposeScoped(ctx, reversibleAction('act-1'), acme);
    await executeScoped(ctx, 'act-1', acme);
    const plan = await mod.planForAction('act-1', { labels: acme });
    if (!plan.ok) throw new Error('expected plan');

    const result = await mod.execute(plan.value, undefined, { labels: acme });
    expect(result.outcomes[0]?.status).toBe('rolled_back');

    const rolledBack = await ctx.ledger.query({ types: ['action.rolled_back'] });
    expect(rolledBack).toHaveLength(1);
    expect(rolledBack[0]?.event.labels).toEqual(acme);
    // The compensating fact is visible to the same tenant scope.
    const scopedView = await ctx.ledger.query({ types: ['action.rolled_back'], labels: acme });
    expect(scopedView).toHaveLength(1);
  });
});
