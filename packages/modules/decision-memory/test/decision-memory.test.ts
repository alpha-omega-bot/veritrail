import { describe, it, expect } from 'vitest';

import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  isErr,
  isOk,
  noopLogger,
  type Ledger,
  type ModuleContext,
} from '@veritrail/core';

import { createDecisionMemoryModule, type DecisionMemoryModule } from '../src/index.js';

/** Build a deterministic module + ledger for a test. */
function build(): { module: DecisionMemoryModule; ledger: Ledger; ctx: ModuleContext } {
  const ledger = createInMemoryLedger({
    clock: new FixedClock(1_700_000_000_000),
    ids: new SequentialIdGenerator(),
  });
  const ctx: ModuleContext = {
    ledger,
    clock: new FixedClock(1_700_000_000_000),
    ids: new SequentialIdGenerator(),
    logger: noopLogger,
  };
  return { module: createDecisionMemoryModule(ctx), ledger, ctx };
}

describe('DecisionMemoryModule.info', () => {
  it('advertises the decision-memory capability', () => {
    const { module } = build();
    expect(module.info).toEqual({
      name: '@veritrail/decision-memory',
      version: '0.1.0',
      capability: 'decision-memory',
    });
  });
});

describe('record', () => {
  it('validates, assigns an id, and appends a decision.recorded event', async () => {
    const { module, ledger } = build();
    const result = await module.record({
      actorId: 'agent-1',
      summary: 'Use Postgres for the primary store',
      rationale: 'Strong consistency and mature tooling',
      chosen: 'postgres',
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.event.type).toBe('decision.recorded');
    expect(result.value.event.actorId).toBe('agent-1');

    const records = await ledger.query({ types: ['decision.recorded'] });
    expect(records).toHaveLength(1);
    const decision = (records[0]?.event as { payload: { decision: { id: string } } }).payload
      .decision;
    expect(decision.id).toMatch(/^dec_/);
  });

  it('records optional ledger labels on the decision fact', async () => {
    const { module, ledger } = build();
    const result = await module.record(
      {
        id: 'dec_scoped',
        actorId: 'agent-1',
        summary: 'Scoped deployment choice',
      },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    expect(isOk(result)).toBe(true);

    const records = await ledger.query({ types: ['decision.recorded'] });
    expect(records[0]?.event.labels).toEqual({ tenant: 'acme', project: 'alpha' });
  });

  it('preserves a caller-supplied id', async () => {
    const { module } = build();
    const result = await module.record({
      id: 'dec_custom',
      actorId: 'agent-1',
      summary: 'A decision',
    });
    expect(isOk(result)).toBe(true);
    const got = await module.get('dec_custom');
    expect(got?.id).toBe('dec_custom');
  });

  it('rejects non-object input with a VALIDATION error', async () => {
    const { module } = build();
    const result = await module.record('not an object');
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('VALIDATION');
  });

  it('rejects a decision missing required fields', async () => {
    const { module } = build();
    const result = await module.record({ actorId: 'agent-1' }); // no summary
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe('VALIDATION');
  });
});

describe('list', () => {
  it('returns decisions most-recent first', async () => {
    const { module } = build();
    await module.record({ id: 'dec_a', actorId: 'a', summary: 'first' });
    await module.record({ id: 'dec_b', actorId: 'a', summary: 'second' });

    const all = await module.list();
    expect(all.map((d) => d.id)).toEqual(['dec_b', 'dec_a']);
  });

  it('filters by actorId', async () => {
    const { module } = build();
    await module.record({ id: 'dec_a', actorId: 'alice', summary: 'x' });
    await module.record({ id: 'dec_b', actorId: 'bob', summary: 'y' });

    const alices = await module.list({ actorId: 'alice' });
    expect(alices.map((d) => d.id)).toEqual(['dec_a']);
  });

  it('applies a limit', async () => {
    const { module } = build();
    await module.record({ id: 'dec_a', actorId: 'a', summary: 'x' });
    await module.record({ id: 'dec_b', actorId: 'a', summary: 'y' });
    await module.record({ id: 'dec_c', actorId: 'a', summary: 'z' });

    const limited = await module.list({ limit: 2 });
    expect(limited.map((d) => d.id)).toEqual(['dec_c', 'dec_b']);
  });

  it('filters list projections by ledger labels', async () => {
    const { module } = build();
    await module.record(
      { id: 'dec_alpha', actorId: 'a', summary: 'alpha decision' },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    await module.record(
      { id: 'dec_beta', actorId: 'a', summary: 'beta decision' },
      { labels: { tenant: 'acme', project: 'beta' } },
    );
    await module.record(
      { id: 'dec_other', actorId: 'a', summary: 'other tenant decision' },
      { labels: { tenant: 'other', project: 'alpha' } },
    );

    const scoped = await module.list({ labels: { tenant: 'acme', project: 'alpha' } });
    expect(scoped.map((d) => d.id)).toEqual(['dec_alpha']);
  });
});

describe('get', () => {
  it('returns null for an unknown id', async () => {
    const { module } = build();
    expect(await module.get('dec_missing')).toBeNull();
  });

  it('returns the most recent recording for an id', async () => {
    const { module } = build();
    await module.record({ id: 'dec_a', actorId: 'a', summary: 'original' });
    await module.record({ id: 'dec_a', actorId: 'a', summary: 'revised' });

    const got = await module.get('dec_a');
    expect(got?.summary).toBe('revised');
  });

  it('filters get projections by ledger labels', async () => {
    const { module } = build();
    await module.record(
      { id: 'dec_a', actorId: 'a', summary: 'visible' },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    await module.record(
      { id: 'dec_b', actorId: 'a', summary: 'hidden' },
      { labels: { tenant: 'acme', project: 'beta' } },
    );

    expect(
      await module.get('dec_a', { labels: { tenant: 'acme', project: 'alpha' } }),
    ).toMatchObject({ id: 'dec_a' });
    expect(await module.get('dec_b', { labels: { tenant: 'acme', project: 'alpha' } })).toBeNull();
  });
});

describe('recall', () => {
  it('ranks a keyword-relevant decision above an unrelated one', async () => {
    const { module } = build();
    await module.record({
      id: 'dec_db',
      actorId: 'a',
      summary: 'Choose a database engine',
      rationale: 'We need a relational database with transactions',
      chosen: 'postgres',
    });
    await module.record({
      id: 'dec_cache',
      actorId: 'a',
      summary: 'Pick a CSS framework',
      rationale: 'Styling the marketing site',
      chosen: 'tailwind',
    });

    const matches = await module.recall({ text: 'database engine' });
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]?.decision.id).toBe('dec_db');
    expect(matches[0]?.score).toBeGreaterThan(0);
    // The unrelated decision shares no query tokens and is filtered out.
    expect(matches.some((m) => m.decision.id === 'dec_cache')).toBe(false);
  });

  it('computes score as sharedTokens / queryTokens', async () => {
    const { module } = build();
    await module.record({
      id: 'dec_x',
      actorId: 'a',
      summary: 'database engine selection',
    });
    // Query has 3 tokens; doc shares "database" and "engine" => 2/3.
    const matches = await module.recall({ text: 'database engine missing' });
    expect(matches[0]?.score).toBeCloseTo(2 / 3, 10);
  });

  it('filters recall by actorId', async () => {
    const { module } = build();
    await module.record({ id: 'dec_a', actorId: 'alice', summary: 'deploy the service' });
    await module.record({ id: 'dec_b', actorId: 'bob', summary: 'deploy the service' });

    const matches = await module.recall({ text: 'deploy', actorId: 'alice' });
    expect(matches.map((m) => m.decision.id)).toEqual(['dec_a']);
  });

  it('breaks score ties by recency', async () => {
    const { module } = build();
    await module.record({ id: 'dec_old', actorId: 'a', summary: 'deploy service' });
    await module.record({ id: 'dec_new', actorId: 'a', summary: 'deploy service' });

    const matches = await module.recall({ text: 'deploy' });
    expect(matches.map((m) => m.decision.id)).toEqual(['dec_new', 'dec_old']);
  });

  it('returns recency-ordered results with score 1 when text is empty', async () => {
    const { module } = build();
    await module.record({ id: 'dec_a', actorId: 'a', summary: 'one' });
    await module.record({ id: 'dec_b', actorId: 'a', summary: 'two' });

    const matches = await module.recall({ text: '' });
    expect(matches.map((m) => m.decision.id)).toEqual(['dec_b', 'dec_a']);
    expect(matches.every((m) => m.score === 1)).toBe(true);
  });

  it('treats whitespace/punctuation-only text as empty (recency mode)', async () => {
    const { module } = build();
    await module.record({ id: 'dec_a', actorId: 'a', summary: 'one' });
    await module.record({ id: 'dec_b', actorId: 'a', summary: 'two' });

    const matches = await module.recall({ text: '   --- !!!  ' });
    expect(matches.map((m) => m.decision.id)).toEqual(['dec_b', 'dec_a']);
  });

  it('applies the default limit of 10', async () => {
    const { module } = build();
    for (let i = 0; i < 15; i += 1) {
      await module.record({ id: `dec_${i}`, actorId: 'a', summary: 'shared topic' });
    }
    const matches = await module.recall({ text: 'shared topic' });
    expect(matches).toHaveLength(10);
  });

  it('honors an explicit limit', async () => {
    const { module } = build();
    await module.record({ id: 'dec_a', actorId: 'a', summary: 'topic' });
    await module.record({ id: 'dec_b', actorId: 'a', summary: 'topic' });
    await module.record({ id: 'dec_c', actorId: 'a', summary: 'topic' });

    const matches = await module.recall({ text: 'topic', limit: 1 });
    expect(matches).toHaveLength(1);
  });

  it('filters recall projections by ledger labels before ranking', async () => {
    const { module } = build();
    await module.record(
      { id: 'dec_alpha', actorId: 'a', summary: 'deploy service' },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    await module.record(
      { id: 'dec_beta', actorId: 'a', summary: 'deploy service' },
      { labels: { tenant: 'acme', project: 'beta' } },
    );

    const matches = await module.recall({
      text: 'deploy',
      labels: { tenant: 'acme', project: 'alpha' },
    });
    expect(matches.map((m) => m.decision.id)).toEqual(['dec_alpha']);
  });

  it('returns an empty array when nothing matches the query', async () => {
    const { module } = build();
    await module.record({ id: 'dec_a', actorId: 'a', summary: 'apples and oranges' });
    const matches = await module.recall({ text: 'spacecraft propulsion' });
    expect(matches).toEqual([]);
  });
});
