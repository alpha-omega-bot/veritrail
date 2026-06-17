import { describe, expect, it } from 'vitest';

import {
  computeRecordHash,
  FixedClock,
  InMemoryAnchorStore,
  InMemoryEventStore,
  Ledger,
  publishLedgerHeadAnchor,
  SequentialIdGenerator,
  verifyLedgerAgainstLatestAnchor,
  verifyChain,
  type LedgerReader,
  type LedgerRecord,
} from '@veritrail/core';

function freshLedger(clock = new FixedClock(1_700_000_000_000), ids = new SequentialIdGenerator()) {
  return new Ledger({ store: new InMemoryEventStore(), clock, ids });
}

async function appendNotes(ledger: Ledger, texts: readonly string[]): Promise<void> {
  for (const text of texts) {
    const result = await ledger.append({ type: 'note', actorId: 'agent_1', payload: { text } });
    expect(result.ok).toBe(true);
  }
}

describe('external anchoring', () => {
  it('publishes the current ledger head as an anchor', async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const ids = new SequentialIdGenerator();
    const ledger = freshLedger(clock, ids);
    const store = new InMemoryAnchorStore();
    await appendNotes(ledger, ['one', 'two']);
    const head = await ledger.head();

    clock.advance(5);
    const result = await publishLedgerHeadAnchor({ ledger, store, clock, ids });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      anchorId: 'anc_000002',
      anchoredAt: 1_700_000_000_005,
      seq: 2,
      recordId: head!.id,
      headHash: head!.hash,
      headTimestamp: head!.timestamp,
    });
    expect(await store.latest()).toEqual(result.value);
  });

  it('verifies an unchanged ledger against the latest anchor', async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const ids = new SequentialIdGenerator();
    const ledger = freshLedger(clock, ids);
    const store = new InMemoryAnchorStore();
    await appendNotes(ledger, ['one', 'two']);
    await publishLedgerHeadAnchor({ ledger, store, clock, ids });
    await appendNotes(ledger, ['after anchor']);

    const result = await verifyLedgerAgainstLatestAnchor({ ledger, store });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ok).toBe(true);
    expect(result.value.issues).toEqual([]);
    expect(result.value.anchor.seq).toBe(2);
    expect(result.value.currentSeq).toBe(3);
    expect(result.value.anchoredRecordHash).toBe(result.value.anchor.headHash);
  });

  it('detects a fully rewritten unsigned chain that is internally valid', async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const ids = new SequentialIdGenerator();
    const original = freshLedger(clock, ids);
    const store = new InMemoryAnchorStore();
    await appendNotes(original, ['one', 'two']);
    await publishLedgerHeadAnchor({ ledger: original, store, clock, ids });

    const attackerClock = new FixedClock(1_700_000_000_000);
    const attackerIds = new SequentialIdGenerator();
    const rewritten = freshLedger(attackerClock, attackerIds);
    await appendNotes(rewritten, ['tampered one', 'tampered two']);

    const internal = await rewritten.verify();
    expect(internal.ok).toBe(true);

    const result = await verifyLedgerAgainstLatestAnchor({ ledger: rewritten, store });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.integrity.ok).toBe(true);
    expect(result.value.ok).toBe(false);
    expect(result.value.issues).toEqual([
      expect.objectContaining({
        kind: 'anchor_hash_mismatch',
        seq: 2,
      }),
    ]);
  });

  it('reports a missing anchor as NOT_FOUND', async () => {
    const ledger = freshLedger();
    const store = new InMemoryAnchorStore();
    await appendNotes(ledger, ['one']);

    const result = await verifyLedgerAgainstLatestAnchor({ ledger, store });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('includes chain integrity failures in the anchor verification report', async () => {
    const clock = new FixedClock(1_700_000_000_000);
    const ids = new SequentialIdGenerator();
    const ledger = freshLedger(clock, ids);
    const store = new InMemoryAnchorStore();
    await appendNotes(ledger, ['one', 'two']);
    await publishLedgerHeadAnchor({ ledger, store, clock, ids });

    const records = await ledger.readAll();
    const tampered: LedgerRecord = {
      ...records[0]!,
      event: { type: 'note', actorId: 'agent_1', labels: {}, payload: { text: 'changed' } },
    };
    records[0] = { ...tampered, hash: computeRecordHash(tampered) };
    const brokenLedger: LedgerReader = {
      query: async () => records,
      readAll: async () => records,
      getBySeq: async (seq: number) => records[seq - 1] ?? null,
      head: async () => records.at(-1) ?? null,
      count: async () => records.length,
      verify: async () => verifyChain(records),
      replay: async (reducer, initial) => records.reduce(reducer, initial),
    };

    const result = await verifyLedgerAgainstLatestAnchor({ ledger: brokenLedger, store });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ok).toBe(false);
    expect(result.value.issues.some((issue) => issue.kind === 'chain_invalid')).toBe(true);
  });
});
