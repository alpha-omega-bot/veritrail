import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  isOk,
  noopLogger,
  unwrap,
  type Ledger,
  type LedgerRecord,
  type ModuleContext,
} from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import { ForensicsModule, createForensicsModule, summarize } from '../src/index.js';

const CLOCK_START = 1_700_000_000_000;

function makeCtx(): { ctx: ModuleContext; ledger: Ledger; clock: FixedClock } {
  const clock = new FixedClock(CLOCK_START);
  const ledger = createInMemoryLedger({ clock, ids: new SequentialIdGenerator() });
  const ctx: ModuleContext = {
    ledger,
    clock,
    ids: new SequentialIdGenerator(),
    logger: noopLogger,
  };
  return { ctx, ledger, clock };
}

async function append(ledger: Ledger, clock: FixedClock, input: unknown): Promise<LedgerRecord> {
  const result = await ledger.append(input);
  expect(isOk(result)).toBe(true);
  clock.advance(1000);
  return unwrap(result);
}

const action = (id: string) => ({
  id,
  actorId: 'agent-1',
  type: 'http.request',
  target: 'https://example.com',
});

describe('ForensicsModule.incident', () => {
  it('aggregates a correlated run into a seq-ordered report with counts', async () => {
    const { ctx, ledger, clock } = makeCtx();
    const correlationId = 'run-1';

    await append(ledger, clock, {
      type: 'action.proposed',
      actorId: 'agent-1',
      correlationId,
      payload: { action: action('act-1') },
    });
    await append(ledger, clock, {
      type: 'action.authorized',
      actorId: 'agent-1',
      correlationId,
      payload: { actionId: 'act-1', authorizedBy: 'user-7' },
    });
    await append(ledger, clock, {
      type: 'action.executed',
      actorId: 'agent-2',
      correlationId,
      payload: { actionId: 'act-1', outcome: 'success' },
    });
    await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-1',
      correlationId,
      payload: { actionId: 'act-2', error: 'timeout' },
    });
    await append(ledger, clock, {
      type: 'action.denied',
      actorId: 'agent-1',
      correlationId,
      payload: { actionId: 'act-3', reason: 'policy block' },
    });
    // Noise in a different correlation must be excluded.
    await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-9',
      correlationId: 'other-run',
      payload: { text: 'unrelated' },
    });

    const module = new ForensicsModule(ctx);
    const report = await module.incident(correlationId);

    expect(report.correlationId).toBe(correlationId);
    expect(report.entries).toHaveLength(5);
    expect(report.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(report.counts).toEqual({
      'action.proposed': 1,
      'action.authorized': 1,
      'action.executed': 1,
      'action.failed': 1,
      'action.denied': 1,
    });
    expect(report.failures).toBe(1);
    expect(report.denials).toBe(1);
    expect(report.rollbacks).toBe(0);
    expect(report.actors).toEqual(['agent-1', 'agent-2']);
    expect(report.firstAt).toBe(CLOCK_START);
    expect(report.lastAt).toBe(CLOCK_START + 4000);
  });

  it('returns an empty report for an unknown correlation', async () => {
    const { ctx } = makeCtx();
    const module = createForensicsModule(ctx);
    const report = await module.incident('missing');

    expect(report.entries).toEqual([]);
    expect(report.actors).toEqual([]);
    expect(report.counts).toEqual({});
    expect(report.failures).toBe(0);
    expect(report.denials).toBe(0);
    expect(report.rollbacks).toBe(0);
    expect(report.firstAt).toBeNull();
    expect(report.lastAt).toBeNull();
  });

  it('counts rollbacks', async () => {
    const { ctx, ledger, clock } = makeCtx();
    await append(ledger, clock, {
      type: 'action.rolled_back',
      actorId: 'agent-1',
      correlationId: 'run-r',
      payload: { actionId: 'act-1', reason: 'undo' },
    });
    const report = await createForensicsModule(ctx).incident('run-r');
    expect(report.rollbacks).toBe(1);
    expect(report.counts['action.rolled_back']).toBe(1);
  });
});

describe('ForensicsModule.timeline', () => {
  it('filters by event type and preserves seq order', async () => {
    const { ctx, ledger, clock } = makeCtx();
    await append(ledger, clock, {
      type: 'action.proposed',
      actorId: 'agent-1',
      payload: { action: action('act-1') },
    });
    await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-1',
      payload: { text: 'hello' },
    });
    await append(ledger, clock, {
      type: 'action.executed',
      actorId: 'agent-1',
      payload: { actionId: 'act-1', outcome: 'success' },
    });

    const module = createForensicsModule(ctx);
    const onlyActions = await module.timeline({
      types: ['action.proposed', 'action.executed'],
    });

    expect(onlyActions.map((e) => e.type)).toEqual(['action.proposed', 'action.executed']);
    expect(onlyActions[0]?.summary).toBe('proposed action act-1 (http.request)');
    expect(onlyActions[1]?.summary).toBe('executed action act-1 (success)');
  });

  it('filters by actor', async () => {
    const { ctx, ledger, clock } = makeCtx();
    await append(ledger, clock, { type: 'note', actorId: 'a', payload: { text: 'x' } });
    await append(ledger, clock, { type: 'note', actorId: 'b', payload: { text: 'y' } });

    const entries = await createForensicsModule(ctx).timeline({ actorId: 'b' });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.actorId).toBe('b');
  });
});

describe('ForensicsModule.causeChain', () => {
  it('walks a linked chain oldest -> newest', async () => {
    const { ctx, ledger, clock } = makeCtx();

    const r1 = await append(ledger, clock, {
      type: 'action.proposed',
      actorId: 'agent-1',
      payload: { action: action('act-1') },
    });
    const r2 = await append(ledger, clock, {
      type: 'action.authorized',
      actorId: 'agent-1',
      causationId: r1.id,
      payload: { actionId: 'act-1' },
    });
    const r3 = await append(ledger, clock, {
      type: 'action.executed',
      actorId: 'agent-1',
      causationId: r2.id,
      payload: { actionId: 'act-1', outcome: 'success' },
    });

    const chain = await createForensicsModule(ctx).causeChain(r3.id);
    expect(chain.map((r) => r.id)).toEqual([r1.id, r2.id, r3.id]);
  });

  it('returns an empty chain for an unknown id', async () => {
    const { ctx, ledger, clock } = makeCtx();
    await append(ledger, clock, { type: 'note', actorId: 'a', payload: { text: 'x' } });
    const chain = await createForensicsModule(ctx).causeChain('nope');
    expect(chain).toEqual([]);
  });

  it('stops at a missing link without throwing', async () => {
    const { ctx, ledger, clock } = makeCtx();
    const r = await append(ledger, clock, {
      type: 'note',
      actorId: 'a',
      causationId: 'ghost', // points at a record that does not exist
      payload: { text: 'x' },
    });
    const chain = await createForensicsModule(ctx).causeChain(r.id);
    expect(chain.map((c) => c.id)).toEqual([r.id]);
  });

  it('is cycle-safe when records reference each other in a loop', async () => {
    // Build two records, then a third that closes a cycle by pointing back.
    const { ctx, ledger, clock } = makeCtx();
    const r1 = await append(ledger, clock, {
      type: 'note',
      actorId: 'a',
      payload: { text: 'one' },
    });
    const r2 = await append(ledger, clock, {
      type: 'note',
      actorId: 'a',
      causationId: r1.id,
      payload: { text: 'two' },
    });
    // r1 cannot reference r2 (immutability), so simulate a cycle directly on the
    // in-memory record map by hand-crafting a looped pair.
    const looped: LedgerRecord[] = [{ ...r1, event: { ...r1.event, causationId: r2.id } }, r2];
    const fakeLedger = {
      readAll: async () => looped,
    } as unknown as Ledger;
    const module = createForensicsModule({
      ledger: fakeLedger,
      clock: ctx.clock,
      ids: ctx.ids,
      logger: ctx.logger,
    });
    const chain = await module.causeChain(r2.id);
    // Visits r2 then r1, then r1->r2 is already visited: stops. Two entries, no hang.
    expect(chain.map((c) => c.id)).toEqual([r1.id, r2.id]);
  });
});

describe('ForensicsModule tenant label scoping', () => {
  it('scopes incident reports to the projection labels', async () => {
    const { ctx, ledger, clock } = makeCtx();
    const acme = { tenant: 'acme', project: 'alpha' };
    const other = { tenant: 'other', project: 'alpha' };

    await append(ledger, clock, {
      type: 'action.executed',
      actorId: 'agent-1',
      correlationId: 'run-1',
      labels: acme,
      payload: { actionId: 'act-1', outcome: 'success' },
    });
    await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-9',
      correlationId: 'run-1',
      labels: other,
      payload: { actionId: 'act-2', error: 'boom' },
    });

    const module = createForensicsModule(ctx);
    const scoped = await module.incident('run-1', { labels: acme });
    expect(scoped.entries).toHaveLength(1);
    expect(scoped.failures).toBe(0);
    expect(scoped.actors).toEqual(['agent-1']);

    // Without a scope the whole correlation is visible.
    const all = await module.incident('run-1');
    expect(all.entries).toHaveLength(2);
    expect(all.failures).toBe(1);
  });

  it('truncates a cause chain at the tenant boundary', async () => {
    const { ctx, ledger, clock } = makeCtx();
    const acme = { tenant: 'acme', project: 'alpha' };
    const other = { tenant: 'other', project: 'alpha' };

    // A cross-tenant chain: other-tenant root -> acme middle -> acme tip.
    const root = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-9',
      labels: other,
      payload: { text: 'root in another tenant' },
    });
    const middle = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-1',
      labels: acme,
      causationId: root.id,
      payload: { text: 'acme middle' },
    });
    const tip = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-1',
      labels: acme,
      causationId: middle.id,
      payload: { text: 'acme tip' },
    });

    const module = createForensicsModule(ctx);
    // Scoped to acme: the walk stops when it reaches the out-of-scope root.
    const scoped = await module.causeChain(tip.id, { labels: acme });
    expect(scoped.map((r) => r.id)).toEqual([middle.id, tip.id]);

    // A chain rooted at another tenant's record is invisible (fail-closed).
    const crossRoot = await module.causeChain(root.id, { labels: acme });
    expect(crossRoot).toEqual([]);

    // Unscoped readers still see the full chain.
    const all = await module.causeChain(tip.id);
    expect(all.map((r) => r.id)).toEqual([root.id, middle.id, tip.id]);
  });
});

describe('ForensicsModule.blastRadius', () => {
  it('projects the root plus everything causally downstream', async () => {
    const { ctx, ledger, clock } = makeCtx();
    // root -> a (failed), root -> b (other correlation), a -> c (rolled_back).
    const root = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-1',
      correlationId: 'run-1',
      payload: { text: 'root cause' },
    });
    const a = await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-2',
      correlationId: 'run-1',
      causationId: root.id,
      payload: { actionId: 'act-a', error: 'boom' },
    });
    const b = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-3',
      correlationId: 'run-2',
      causationId: root.id,
      payload: { text: 'downstream in another run' },
    });
    const c = await append(ledger, clock, {
      type: 'action.rolled_back',
      actorId: 'agent-1',
      correlationId: 'run-1',
      causationId: a.id,
      payload: { actionId: 'act-a', reason: 'undo' },
    });
    // An unrelated event must NOT appear in the radius.
    await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-9',
      payload: { text: 'unrelated' },
    });

    const module = createForensicsModule(ctx);
    const res = await module.blastRadius(root.id);
    expect(isOk(res)).toBe(true);
    const report = unwrap(res);

    expect(report.entries.map((e) => e.seq)).toEqual([root.seq, a.seq, b.seq, c.seq]);
    expect(report.impactedCount).toBe(3);
    expect(report.actors).toEqual(['agent-1', 'agent-2', 'agent-3']);
    expect(report.correlations).toEqual(['run-1', 'run-2']);
    expect(report.failures).toBe(1);
    expect(report.rollbacks).toBe(1);
    expect(report.denials).toBe(0);

    // From a midpoint, only its own descendants are in the radius.
    const fromA = unwrap(await module.blastRadius(a.id));
    expect(fromA.entries.map((e) => e.seq)).toEqual([a.seq, c.seq]);
    expect(fromA.impactedCount).toBe(1);
  });

  it('returns a single-node radius for a leaf event', async () => {
    const { ctx, ledger, clock } = makeCtx();
    const leaf = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-1',
      payload: { text: 'no downstream' },
    });
    const report = unwrap(await createForensicsModule(ctx).blastRadius(leaf.id));
    expect(report.entries.map((e) => e.seq)).toEqual([leaf.seq]);
    expect(report.impactedCount).toBe(0);
  });

  it('returns NOT_FOUND for an unknown root', async () => {
    const { ctx } = makeCtx();
    const res = await createForensicsModule(ctx).blastRadius('evt-missing');
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('truncates the radius at the tenant boundary', async () => {
    const { ctx, ledger, clock } = makeCtx();
    const acme = { tenant: 'acme', project: 'alpha' };
    const other = { tenant: 'other', project: 'alpha' };
    // acme root -> acme child, and acme root -> other-tenant child.
    const root = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-1',
      labels: acme,
      payload: { text: 'root' },
    });
    const acmeChild = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-1',
      labels: acme,
      causationId: root.id,
      payload: { text: 'acme child' },
    });
    const otherChild = await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-9',
      labels: other,
      causationId: root.id,
      payload: { actionId: 'x', error: 'boom' },
    });

    const module = createForensicsModule(ctx);
    // Scoped to acme: the other-tenant child is invisible, so its failure is not counted.
    const scoped = unwrap(await module.blastRadius(root.id, { labels: acme }));
    expect(scoped.entries.map((e) => e.seq)).toEqual([root.seq, acmeChild.seq]);
    expect(scoped.failures).toBe(0);

    // A root rooted in another tenant is NOT_FOUND under this scope (fail-closed).
    const crossRoot = await module.blastRadius(otherChild.id, { labels: acme });
    expect(isOk(crossRoot)).toBe(false);

    // Unscoped sees the full fan-out including the failure.
    const all = unwrap(await module.blastRadius(root.id));
    expect(all.entries).toHaveLength(3);
    expect(all.failures).toBe(1);
  });
});

describe('ForensicsModule.rankRootCauses', () => {
  it('ranks candidate root causes by downstream blast radius, worst first', async () => {
    const { ctx, ledger, clock } = makeCtx();
    // run-1: a denial with no downstream, and a failure with two downstream events.
    const denial = await append(ledger, clock, {
      type: 'action.denied',
      actorId: 'agent-1',
      correlationId: 'run-1',
      payload: { actionId: 'act-d', reason: 'policy block' },
    });
    const failure = await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-2',
      correlationId: 'run-1',
      payload: { actionId: 'act-f', error: 'boom' },
    });
    const down1 = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-2',
      correlationId: 'run-1',
      causationId: failure.id,
      payload: { text: 'downstream 1' },
    });
    await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-2',
      correlationId: 'run-1',
      causationId: down1.id,
      payload: { text: 'downstream 2' },
    });

    const ranked = await createForensicsModule(ctx).rankRootCauses('run-1');
    // failure (impact 2) outranks the denial (impact 0).
    expect(ranked.map((c) => c.id)).toEqual([failure.id, denial.id]);
    expect(ranked[0]).toMatchObject({ type: 'action.failed', impactedCount: 2 });
    expect(ranked[1]).toMatchObject({ type: 'action.denied', impactedCount: 0 });
  });

  it('breaks impact ties toward the earliest event', async () => {
    const { ctx, ledger, clock } = makeCtx();
    const first = await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-1',
      correlationId: 'run-1',
      payload: { actionId: 'act-1', error: 'a' },
    });
    const second = await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-1',
      correlationId: 'run-1',
      payload: { actionId: 'act-2', error: 'b' },
    });

    const ranked = await createForensicsModule(ctx).rankRootCauses('run-1');
    // Equal impact (0 each): the earlier seq wins.
    expect(ranked.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(first.seq).toBeLessThan(second.seq);
  });

  it('returns an empty list when the correlation has no failure/denial/rollback events', async () => {
    const { ctx, ledger, clock } = makeCtx();
    await append(ledger, clock, {
      type: 'action.executed',
      actorId: 'agent-1',
      correlationId: 'run-1',
      payload: { actionId: 'act-1', outcome: 'success' },
    });
    await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-1',
      correlationId: 'run-1',
      payload: { text: 'all good' },
    });
    expect(await createForensicsModule(ctx).rankRootCauses('run-1')).toEqual([]);
  });

  it('scopes candidates and downstream counts to the tenant labels', async () => {
    const { ctx, ledger, clock } = makeCtx();
    const acme = { tenant: 'acme', project: 'alpha' };
    const other = { tenant: 'other', project: 'alpha' };
    // acme failure with one in-scope downstream and one out-of-scope downstream.
    const acmeFail = await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-1',
      correlationId: 'run-1',
      labels: acme,
      payload: { actionId: 'act-a', error: 'boom' },
    });
    await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-1',
      correlationId: 'run-1',
      labels: acme,
      causationId: acmeFail.id,
      payload: { text: 'acme downstream' },
    });
    await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-9',
      correlationId: 'run-1',
      labels: other,
      causationId: acmeFail.id,
      payload: { text: 'other-tenant downstream' },
    });
    // A failure belonging entirely to another tenant must not appear for acme.
    await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-9',
      correlationId: 'run-1',
      labels: other,
      payload: { actionId: 'act-o', error: 'x' },
    });

    const module = createForensicsModule(ctx);
    const scoped = await module.rankRootCauses('run-1', { labels: acme });
    expect(scoped.map((c) => c.id)).toEqual([acmeFail.id]);
    // Only the in-scope downstream note is counted.
    expect(scoped[0]?.impactedCount).toBe(1);

    // Unscoped: both failures are candidates; the acme one now counts both
    // downstream notes.
    const all = await module.rankRootCauses('run-1');
    expect(all).toHaveLength(2);
    expect(all[0]?.impactedCount).toBe(2);
  });
});

describe('ForensicsModule.incidentBundle', () => {
  it('composes incident, ranked root causes, and the top cause blast radius', async () => {
    const { ctx, ledger, clock } = makeCtx();
    // root failure -> downstream note -> downstream rollback, all in run-1.
    const failure = await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-1',
      correlationId: 'run-1',
      payload: { actionId: 'act-1', error: 'boom' },
    });
    const down1 = await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-2',
      correlationId: 'run-1',
      causationId: failure.id,
      payload: { text: 'downstream' },
    });
    await append(ledger, clock, {
      type: 'action.denied',
      actorId: 'agent-2',
      correlationId: 'run-1',
      causationId: down1.id,
      payload: { actionId: 'act-2', reason: 'blocked' },
    });

    const bundle = await createForensicsModule(ctx).incidentBundle('run-1');

    expect(bundle.correlationId).toBe('run-1');
    expect(bundle.generatedAt).toBe(clock.now());
    // Incident report covers the whole correlation.
    expect(bundle.incident.entries).toHaveLength(3);
    expect(bundle.incident.failures).toBe(1);
    expect(bundle.incident.denials).toBe(1);
    // Two candidate root causes (the failure and the denial); the failure has the
    // larger forward radius so it ranks first.
    expect(bundle.rootCauses.map((c) => c.id)).toEqual([failure.id, expect.any(String)]);
    expect(bundle.rootCauses[0]?.id).toBe(failure.id);
    // Top cause blast radius is the failure's forward reach (itself + 2 downstream).
    expect(bundle.topRootCauseBlastRadius?.rootId).toBe(failure.id);
    expect(bundle.topRootCauseBlastRadius?.impactedCount).toBe(2);
  });

  it('returns a bundle with no root cause for a clean correlation', async () => {
    const { ctx, ledger, clock } = makeCtx();
    await append(ledger, clock, {
      type: 'action.executed',
      actorId: 'agent-1',
      correlationId: 'run-ok',
      payload: { actionId: 'act-1', outcome: 'success' },
    });

    const bundle = await createForensicsModule(ctx).incidentBundle('run-ok');
    expect(bundle.incident.entries).toHaveLength(1);
    expect(bundle.rootCauses).toEqual([]);
    expect(bundle.topRootCauseBlastRadius).toBeNull();
  });

  it('returns an empty bundle for an unknown correlation', async () => {
    const { ctx } = makeCtx();
    const bundle = await createForensicsModule(ctx).incidentBundle('run-missing');
    expect(bundle.incident.entries).toEqual([]);
    expect(bundle.rootCauses).toEqual([]);
    expect(bundle.topRootCauseBlastRadius).toBeNull();
  });

  it('scopes every component to the tenant labels', async () => {
    const { ctx, ledger, clock } = makeCtx();
    const acme = { tenant: 'acme', project: 'alpha' };
    const other = { tenant: 'other', project: 'alpha' };
    const acmeFail = await append(ledger, clock, {
      type: 'action.failed',
      actorId: 'agent-1',
      correlationId: 'run-1',
      labels: acme,
      payload: { actionId: 'act-a', error: 'boom' },
    });
    await append(ledger, clock, {
      type: 'note',
      actorId: 'agent-9',
      correlationId: 'run-1',
      labels: other,
      causationId: acmeFail.id,
      payload: { text: 'other-tenant downstream' },
    });

    const bundle = await createForensicsModule(ctx).incidentBundle('run-1', { labels: acme });
    expect(bundle.incident.entries).toHaveLength(1); // only the acme failure
    expect(bundle.rootCauses.map((c) => c.id)).toEqual([acmeFail.id]);
    // The out-of-scope downstream note is not counted in the radius.
    expect(bundle.topRootCauseBlastRadius?.impactedCount).toBe(0);
  });
});

describe('summarize', () => {
  it('summarizes denials with reason', () => {
    const s = summarize({
      type: 'action.denied',
      actorId: 'a',
      labels: {},
      payload: { actionId: 'act-9', reason: 'over budget', policyId: 'pol-1' },
    });
    expect(s).toBe('denied action act-9: over budget');
  });

  it('summarizes a note', () => {
    const s = summarize({
      type: 'note',
      actorId: 'a',
      labels: {},
      payload: { text: 'hello world' },
    });
    expect(s).toBe('note: hello world');
  });

  it('summarizes admin actions', () => {
    const s = summarize({
      type: 'admin.action',
      actorId: 'operator-1',
      labels: {},
      payload: {
        action: 'policy.upserted',
        targetType: 'policy',
        targetId: 'pol-1',
        outcome: 'success',
        reason: '',
      },
    });
    expect(s).toBe('admin policy.upserted on policy pol-1 (success)');
  });
});
