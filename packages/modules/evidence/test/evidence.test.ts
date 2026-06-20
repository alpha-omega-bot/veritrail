import {
  FixedClock,
  SequentialIdGenerator,
  createInMemoryLedger,
  isErr,
  isOk,
  noopLogger,
  sha256Hex,
  unwrap,
  type Ledger,
  type ModuleContext,
} from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import { EvidenceModule, createEvidenceModule } from '../src/index.js';

function makeCtx(): { ctx: ModuleContext; ledger: Ledger } {
  const clock = new FixedClock(1_700_000_000_000);
  const ids = new SequentialIdGenerator();
  const ledger = createInMemoryLedger({ clock, ids });
  const ctx: ModuleContext = { ledger, clock, ids, logger: noopLogger };
  return { ctx, ledger };
}

describe('EvidenceModule.info', () => {
  it('declares the evidence capability', () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    expect(mod).toBeInstanceOf(EvidenceModule);
    expect(mod.info).toEqual({
      name: '@veritrail/evidence',
      version: '0.1.0',
      capability: 'evidence',
    });
  });
});

describe('EvidenceModule.attach', () => {
  it('attaches evidence without a contentHash, assigning an id', async () => {
    const { ctx, ledger } = makeCtx();
    const mod = createEvidenceModule(ctx);

    const res = await mod.attach({
      actorId: 'agent-1',
      kind: 'observation',
      source: 'sensor://a',
      summary: 'no hash here',
    });
    expect(isOk(res)).toBe(true);
    const record = unwrap(res);
    expect(record.event.type).toBe('evidence.attached');

    const stored = await mod.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toMatch(/^evd/);
    expect(stored[0]?.contentHash).toBeUndefined();

    // The fact is on the shared ledger, not a side store.
    const all = await ledger.readAll();
    expect(all).toHaveLength(1);
  });

  it('records optional ledger labels on the evidence fact', async () => {
    const { ctx, ledger } = makeCtx();
    const mod = createEvidenceModule(ctx);

    const res = await mod.attach(
      {
        actorId: 'agent-1',
        id: 'evd-scoped',
        kind: 'document',
        summary: 'scoped evidence',
      },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    expect(isOk(res)).toBe(true);

    const all = await ledger.query({ types: ['evidence.attached'] });
    expect(all[0]?.event.labels).toEqual({ tenant: 'acme', project: 'alpha' });
  });

  it('attaches evidence with a contentHash and a supplied id', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const hash = sha256Hex('hello world');

    const res = await mod.attach({
      actorId: 'agent-1',
      id: 'evd-custom',
      kind: 'document',
      source: 'file://doc.txt',
      summary: 'a doc',
      contentHash: hash,
    });
    expect(isOk(res)).toBe(true);

    const got = await mod.get('evd-custom');
    expect(got?.contentHash).toBe(hash);
  });

  it('rejects a non-object input', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const res = await mod.attach('nope');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('VALIDATION');
  });

  it('rejects input without an actorId', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const res = await mod.attach({ kind: 'document', summary: 'x' });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('VALIDATION');
  });

  it('rejects an invalid kind', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const res = await mod.attach({ actorId: 'a', kind: 'not-a-kind', summary: 'x' });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('VALIDATION');
  });

  it('rejects a malformed contentHash', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const res = await mod.attach({
      actorId: 'a',
      kind: 'document',
      summary: 'x',
      contentHash: 'too-short',
    });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('VALIDATION');
  });
});

describe('EvidenceModule.list pagination', () => {
  /** Attach five evidence items in a deterministic attachment order. */
  async function seedFive(mod: EvidenceModule): Promise<void> {
    for (let i = 1; i <= 5; i += 1) {
      await mod.attach({ actorId: 'a', id: `evd-${i}`, kind: 'document', summary: `e${i}` });
    }
  }

  it('returns all records in attachment order when unpaginated', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await seedFive(mod);
    expect((await mod.list()).map((e) => e.id)).toEqual([
      'evd-1',
      'evd-2',
      'evd-3',
      'evd-4',
      'evd-5',
    ]);
  });

  it('applies limit and offset to page the result', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await seedFive(mod);
    expect((await mod.list({ limit: 2 })).map((e) => e.id)).toEqual(['evd-1', 'evd-2']);
    expect((await mod.list({ offset: 2, limit: 2 })).map((e) => e.id)).toEqual(['evd-3', 'evd-4']);
    expect((await mod.list({ offset: 4, limit: 2 })).map((e) => e.id)).toEqual(['evd-5']);
  });

  it('returns the tail when only offset is given', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await seedFive(mod);
    expect((await mod.list({ offset: 3 })).map((e) => e.id)).toEqual(['evd-4', 'evd-5']);
  });

  it('clamps a negative offset to 0 and yields empty for a negative limit', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await seedFive(mod);
    expect((await mod.list({ offset: -10, limit: 1 })).map((e) => e.id)).toEqual(['evd-1']);
    expect(await mod.list({ limit: -1 })).toEqual([]);
    expect(await mod.list({ limit: 0 })).toEqual([]);
  });

  it('returns empty when the offset is past the end', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await seedFive(mod);
    expect(await mod.list({ offset: 99 })).toEqual([]);
  });

  it('paginates within a tenant-label scope', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const acme = { tenant: 'acme', project: 'alpha' };
    for (let i = 1; i <= 3; i += 1) {
      await mod.attach(
        { actorId: 'a', id: `evd-acme-${i}`, kind: 'document', summary: `a${i}` },
        { labels: acme },
      );
      await mod.attach({ actorId: 'a', id: `evd-other-${i}`, kind: 'document', summary: `o${i}` });
    }
    const page = await mod.list({ labels: acme, offset: 1, limit: 1 });
    expect(page.map((e) => e.id)).toEqual(['evd-acme-2']);
  });
});

describe('EvidenceModule.get', () => {
  it('returns null for a missing id', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    expect(await mod.get('evd-nope')).toBeNull();
  });

  it('filters list and get projections by ledger labels', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);

    await mod.attach(
      { actorId: 'a', id: 'evd-alpha', kind: 'document', summary: 'alpha' },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    await mod.attach(
      { actorId: 'a', id: 'evd-beta', kind: 'document', summary: 'beta' },
      { labels: { tenant: 'acme', project: 'beta' } },
    );

    const scoped = await mod.list({ labels: { tenant: 'acme', project: 'alpha' } });
    expect(scoped.map((evidence) => evidence.id)).toEqual(['evd-alpha']);
    expect(
      await mod.get('evd-alpha', { labels: { tenant: 'acme', project: 'alpha' } }),
    ).toMatchObject({ id: 'evd-alpha' });
    expect(await mod.get('evd-beta', { labels: { tenant: 'acme', project: 'alpha' } })).toBeNull();
  });
});

describe('EvidenceModule.evidenceForDecision', () => {
  it('returns every distinct evidence that links the decision, id-sorted', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await mod.attach({
      actorId: 'a',
      id: 'evd-b',
      kind: 'document',
      summary: 'supports dec-1',
      links: { decisionIds: ['dec-1'] },
    });
    await mod.attach({
      actorId: 'a',
      id: 'evd-a',
      kind: 'dataset',
      summary: 'also supports dec-1',
      links: { decisionIds: ['dec-1', 'dec-2'] },
    });
    await mod.attach({
      actorId: 'a',
      id: 'evd-c',
      kind: 'document',
      summary: 'supports dec-2 only',
      links: { decisionIds: ['dec-2'] },
    });

    const forDec1 = await mod.evidenceForDecision('dec-1');
    expect(forDec1.map((e) => e.id)).toEqual(['evd-a', 'evd-b']);
    const forDec2 = await mod.evidenceForDecision('dec-2');
    expect(forDec2.map((e) => e.id)).toEqual(['evd-a', 'evd-c']);
  });

  it('returns an empty list when no evidence links the decision', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await mod.attach({ actorId: 'a', id: 'evd-1', kind: 'document', summary: 'unlinked' });
    expect(await mod.evidenceForDecision('dec-x')).toEqual([]);
  });

  it('honors the latest attachment when a link is later removed', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await mod.attach({
      actorId: 'a',
      id: 'evd-1',
      kind: 'document',
      summary: 'v1 links dec-1',
      links: { decisionIds: ['dec-1'] },
    });
    // Re-attach the same id without the link: the latest version wins.
    await mod.attach({
      actorId: 'a',
      id: 'evd-1',
      kind: 'document',
      summary: 'v2 drops the link',
      links: { decisionIds: [] },
    });
    expect(await mod.evidenceForDecision('dec-1')).toEqual([]);
  });

  it('only projects evidence inside the ledger-label scope', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await mod.attach(
      {
        actorId: 'a',
        id: 'evd-acme',
        kind: 'document',
        summary: 'acme',
        links: { decisionIds: ['dec-1'] },
      },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    await mod.attach(
      {
        actorId: 'a',
        id: 'evd-other',
        kind: 'document',
        summary: 'other',
        links: { decisionIds: ['dec-1'] },
      },
      { labels: { tenant: 'other', project: 'alpha' } },
    );

    const scoped = await mod.evidenceForDecision('dec-1', {
      labels: { tenant: 'acme', project: 'alpha' },
    });
    expect(scoped.map((e) => e.id)).toEqual(['evd-acme']);
    // Unscoped sees both.
    expect((await mod.evidenceForDecision('dec-1')).map((e) => e.id)).toEqual([
      'evd-acme',
      'evd-other',
    ]);
  });
});

describe('EvidenceModule.trace', () => {
  it('walks a 3-node derived_from chain', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);

    // c <- b <- a (root is a; a derived_from b, b derived_from c).
    await mod.attach({ actorId: 'a', id: 'evd-c', kind: 'dataset', summary: 'root data' });
    await mod.attach({
      actorId: 'a',
      id: 'evd-b',
      kind: 'tool_output',
      summary: 'mid',
      links: { evidenceIds: ['evd-c'] },
    });
    await mod.attach({
      actorId: 'a',
      id: 'evd-a',
      kind: 'citation',
      summary: 'top',
      links: { evidenceIds: ['evd-b'] },
    });

    const res = await mod.trace('evd-a');
    expect(isOk(res)).toBe(true);
    const graph = unwrap(res);
    expect(graph.rootId).toBe('evd-a');

    const ids = graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['evd-a', 'evd-b', 'evd-c']);

    const edgePairs = graph.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(edgePairs).toEqual(['evd-a->evd-b', 'evd-b->evd-c']);
    expect(graph.edges.every((e) => e.relation === 'derived_from')).toBe(true);
  });

  it('does not loop forever on a cycle', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);

    // a <-> b cycle.
    await mod.attach({
      actorId: 'a',
      id: 'evd-a',
      kind: 'artifact',
      summary: 'a',
      links: { evidenceIds: ['evd-b'] },
    });
    await mod.attach({
      actorId: 'a',
      id: 'evd-b',
      kind: 'artifact',
      summary: 'b',
      links: { evidenceIds: ['evd-a'] },
    });

    const res = await mod.trace('evd-a');
    expect(isOk(res)).toBe(true);
    const graph = unwrap(res);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['evd-a', 'evd-b']);
    // Each node visited once; both edges recorded.
    expect(graph.edges).toHaveLength(2);
  });

  it('records edges to dangling upstream ids but does not create nodes for them', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await mod.attach({
      actorId: 'a',
      id: 'evd-a',
      kind: 'document',
      summary: 'a',
      links: { evidenceIds: ['evd-missing'] },
    });

    const graph = unwrap(await mod.trace('evd-a'));
    expect(graph.nodes.map((n) => n.id)).toEqual(['evd-a']);
    expect(graph.edges).toEqual([{ from: 'evd-a', to: 'evd-missing', relation: 'derived_from' }]);
  });

  it('builds traces only from evidence inside the ledger-label projection', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await mod.attach(
      { actorId: 'a', id: 'evd-source', kind: 'dataset', summary: 'source' },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    await mod.attach(
      {
        actorId: 'a',
        id: 'evd-claim',
        kind: 'citation',
        summary: 'claim',
        links: { evidenceIds: ['evd-source', 'evd-beta'] },
      },
      { labels: { tenant: 'acme', project: 'alpha' } },
    );
    await mod.attach(
      { actorId: 'a', id: 'evd-beta', kind: 'dataset', summary: 'sibling' },
      { labels: { tenant: 'acme', project: 'beta' } },
    );

    const graph = unwrap(
      await mod.trace('evd-claim', { labels: { tenant: 'acme', project: 'alpha' } }),
    );
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['evd-claim', 'evd-source']);
    expect(graph.edges.map((edge) => `${edge.from}->${edge.to}`).sort()).toEqual([
      'evd-claim->evd-beta',
      'evd-claim->evd-source',
    ]);

    const hidden = await mod.trace('evd-beta', { labels: { tenant: 'acme', project: 'alpha' } });
    expect(isErr(hidden)).toBe(true);
    if (isErr(hidden)) expect(hidden.error.code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND when the root is missing', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const res = await mod.trace('evd-nope');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('emits one edge per (from,to) even when an upstream id is repeated', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await mod.attach({ actorId: 'a', id: 'evd-b', kind: 'dataset', summary: 'b' });
    await mod.attach({
      actorId: 'a',
      id: 'evd-a',
      kind: 'citation',
      summary: 'a',
      // The same upstream id listed twice must not produce duplicate edges.
      links: { evidenceIds: ['evd-b', 'evd-b'] },
    });

    const graph = unwrap(await mod.trace('evd-a'));
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(['evd-a', 'evd-b']);
    expect(graph.edges).toEqual([{ from: 'evd-a', to: 'evd-b', relation: 'derived_from' }]);
  });

  it('keeps a convergent node and its full subtree (diamond)', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    // a -> b, a -> c, b -> d, c -> d, d -> e.  d is reached via two paths.
    await mod.attach({ actorId: 'a', id: 'evd-e', kind: 'dataset', summary: 'e' });
    await mod.attach({
      actorId: 'a',
      id: 'evd-d',
      kind: 'dataset',
      summary: 'd',
      links: { evidenceIds: ['evd-e'] },
    });
    await mod.attach({
      actorId: 'a',
      id: 'evd-b',
      kind: 'tool_output',
      summary: 'b',
      links: { evidenceIds: ['evd-d'] },
    });
    await mod.attach({
      actorId: 'a',
      id: 'evd-c',
      kind: 'tool_output',
      summary: 'c',
      links: { evidenceIds: ['evd-d'] },
    });
    await mod.attach({
      actorId: 'a',
      id: 'evd-a',
      kind: 'citation',
      summary: 'a',
      links: { evidenceIds: ['evd-b', 'evd-c'] },
    });

    const graph = unwrap(await mod.trace('evd-a'));
    // Every node present exactly once, including the convergent d and its child e.
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([
      'evd-a',
      'evd-b',
      'evd-c',
      'evd-d',
      'evd-e',
    ]);
    expect(graph.nodes).toHaveLength(5);
    // Both paths into d are recorded; d->e survives the convergence.
    expect(graph.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      'evd-a->evd-b',
      'evd-a->evd-c',
      'evd-b->evd-d',
      'evd-c->evd-d',
      'evd-d->evd-e',
    ]);
  });

  it('caps a long chain at MAX_TRACE_DEPTH without dropping shallower nodes', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    // Build a chain longer than the depth cap: c0 <- c1 <- ... <- c150 (root c150).
    const length = 150;
    await mod.attach({ actorId: 'a', id: 'evd-c0', kind: 'dataset', summary: 'c0' });
    for (let i = 1; i <= length; i += 1) {
      await mod.attach({
        actorId: 'a',
        id: `evd-c${i}`,
        kind: 'dataset',
        summary: `c${i}`,
        links: { evidenceIds: [`evd-c${i - 1}`] },
      });
    }

    const graph = unwrap(await mod.trace(`evd-c${length}`));
    // Root is depth 0; the cap admits depths 0..100 inclusive = 101 nodes.
    expect(graph.nodes).toHaveLength(101);
    expect(graph.nodes[0]?.id).toBe(`evd-c${length}`);
    // The shallow neighbours are always present (regression guard for the
    // min-depth fix: nothing within range is pruned).
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.has(`evd-c${length - 1}`)).toBe(true);
    expect(ids.has(`evd-c${length - 50}`)).toBe(true);
  });
});

describe('EvidenceModule.verifyContent', () => {
  it('returns true when content matches the stored hash', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const content = 'the quick brown fox';
    await mod.attach({
      actorId: 'a',
      id: 'evd-1',
      kind: 'document',
      summary: 'doc',
      contentHash: sha256Hex(content),
    });

    const res = await mod.verifyContent('evd-1', content);
    expect(isOk(res)).toBe(true);
    expect(unwrap(res)).toBe(true);
  });

  it('returns false when content does not match', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await mod.attach({
      actorId: 'a',
      id: 'evd-1',
      kind: 'document',
      summary: 'doc',
      contentHash: sha256Hex('original'),
    });

    const res = await mod.verifyContent('evd-1', 'tampered');
    expect(isOk(res)).toBe(true);
    expect(unwrap(res)).toBe(false);
  });

  it('returns NOT_FOUND when scoped labels hide the evidence content hash', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const content = 'scoped content';
    await mod.attach(
      {
        actorId: 'a',
        id: 'evd-1',
        kind: 'document',
        summary: 'doc',
        contentHash: sha256Hex(content),
      },
      { labels: { tenant: 'acme', project: 'beta' } },
    );

    const res = await mod.verifyContent('evd-1', content, {
      labels: { tenant: 'acme', project: 'alpha' },
    });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND when the evidence is missing', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    const res = await mod.verifyContent('evd-nope', 'x');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND when the evidence has no contentHash', async () => {
    const { ctx } = makeCtx();
    const mod = createEvidenceModule(ctx);
    await mod.attach({ actorId: 'a', id: 'evd-1', kind: 'observation', summary: 'no hash' });
    const res = await mod.verifyContent('evd-1', 'x');
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe('NOT_FOUND');
  });
});
