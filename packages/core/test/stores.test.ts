import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFileLedger,
  FileEventStore,
  FixedClock,
  InMemoryEventStore,
  Ledger,
  SequentialIdGenerator,
} from '@veritrail/core';

describe('InMemoryEventStore via Ledger', () => {
  it('supports query, getBySeq, head and count', async () => {
    const ledger = new Ledger({
      store: new InMemoryEventStore(),
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });
    await ledger.append({ type: 'note', actorId: 'a', payload: { text: 'one' } });
    await ledger.append({
      type: 'vendor.signal',
      actorId: 'a',
      payload: {
        signal: {
          id: 'sig_1',
          vendorId: 'ven_1',
          kind: 'incident',
          severity: 'high',
          summary: 'outage',
        },
      },
    });

    expect(await ledger.count()).toBe(2);
    const notes = await ledger.query({ types: ['note'] });
    expect(notes).toHaveLength(1);
    expect((await ledger.getBySeq(2))?.event.type).toBe('vendor.signal');
    expect((await ledger.head())?.seq).toBe(2);
  });

  it('enforces append-only sequencing at the store layer', async () => {
    const store = new InMemoryEventStore();
    const ledger = new Ledger({
      store,
      clock: new FixedClock(1),
      ids: new SequentialIdGenerator(),
    });
    const appended = await ledger.append({ type: 'note', actorId: 'a', payload: { text: 'x' } });
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    // Replaying the same record violates the append-only invariant.
    const conflict = await store.append(appended.value);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('CONFLICT');
  });
});

describe('FileEventStore durability', () => {
  const paths: string[] = [];
  const tempPath = (): string => {
    const p = join(tmpdir(), `veritrail-${randomUUID()}.ledger.jsonl`);
    paths.push(p);
    return p;
  };

  afterEach(async () => {
    await Promise.all(paths.splice(0).map((p) => rm(p, { force: true })));
  });

  it('persists records across reopen and stays integrity-clean', async () => {
    const path = tempPath();
    const first = await createFileLedger(path, {
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });
    await first.append({ type: 'note', actorId: 'a', payload: { text: 'persisted' } });
    await first.append({ type: 'note', actorId: 'a', payload: { text: 'again' } });

    // Reopen from disk.
    const reopened = await createFileLedger(path);
    expect(await reopened.count()).toBe(2);
    const report = await reopened.verify();
    expect(report.ok).toBe(true);

    // Appending after reopen continues the same chain.
    const head = await reopened.head();
    const result = await reopened.append({ type: 'note', actorId: 'a', payload: { text: 'more' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.prevHash).toBe(head!.hash);
  });

  it('opens a fresh store for a non-existent path', async () => {
    const store = await FileEventStore.open(tempPath());
    expect(await store.count()).toBe(0);
    expect(await store.head()).toBeNull();
  });
});
