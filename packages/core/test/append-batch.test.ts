import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFileLedger,
  FileEventStore,
  FixedClock,
  HmacSigner,
  InMemoryEventStore,
  Ledger,
  SequentialIdGenerator,
} from '@veritrail/core';

const tmpFiles: string[] = [];
afterEach(async () => {
  await Promise.all(tmpFiles.splice(0).map((p) => rm(p, { force: true })));
});

function tmpPath(): string {
  const p = join(tmpdir(), `veritrail-batch-${randomUUID()}.jsonl`);
  tmpFiles.push(p);
  return p;
}

function note(text: string): unknown {
  return { type: 'note', actorId: 'agent-1', payload: { text } };
}

describe('Ledger.appendMany', () => {
  it('commits a contiguous, gap-free, verifiable chain', async () => {
    const ledger = new Ledger({
      store: new InMemoryEventStore(),
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });

    const results = await ledger.appendMany([note('one'), note('two'), note('three')]);
    expect(results.every((r) => r.ok)).toBe(true);

    const all = await ledger.readAll();
    expect(all.map((r) => r.seq)).toEqual([1, 2, 3]);
    // Each record chains to its predecessor.
    expect(all[1]!.prevHash).toBe(all[0]!.hash);
    expect(all[2]!.prevHash).toBe(all[1]!.hash);
    // The whole chain verifies as a single integrity report.
    expect((await ledger.verify()).ok).toBe(true);
  });

  it('continues a chain started by single appends', async () => {
    const ledger = new Ledger({
      store: new InMemoryEventStore(),
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });
    await ledger.append(note('first'));
    await ledger.appendMany([note('second'), note('third')]);

    const all = await ledger.readAll();
    expect(all.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(all[1]!.prevHash).toBe(all[0]!.hash);
    expect((await ledger.verify()).ok).toBe(true);
  });

  it('reports invalid inputs by position and still commits the valid ones', async () => {
    const ledger = new Ledger({
      store: new InMemoryEventStore(),
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });

    const results = await ledger.appendMany([
      note('good-1'),
      { type: 'note', actorId: 'agent-1', payload: {} }, // missing text → VALIDATION
      note('good-2'),
    ]);

    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
    if (!results[1]!.ok) expect(results[1]!.error.code).toBe('VALIDATION');
    expect(results[2]!.ok).toBe(true);

    // Only the two valid notes are committed, contiguously.
    const all = await ledger.readAll();
    expect(all.map((r) => r.seq)).toEqual([1, 2]);
    if (all[0]!.event.type === 'note') expect(all[0]!.event.payload.text).toBe('good-1');
    if (all[1]!.event.type === 'note') expect(all[1]!.event.payload.text).toBe('good-2');
    expect((await ledger.verify()).ok).toBe(true);
  });

  it('signs every record in a batch and verifies them', async () => {
    const signer = new HmacSigner('a-sufficiently-long-secret');
    const ledger = new Ledger({
      store: new InMemoryEventStore(),
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
      signer,
    });
    await ledger.appendMany([note('a'), note('b')]);
    const all = await ledger.readAll();
    expect(all.every((r) => r.signature !== undefined)).toBe(true);
    expect(all.every((r) => signer.verify(r.hash, r.signature!, r.signerKeyId))).toBe(true);
    expect((await ledger.verify()).ok).toBe(true);
  });

  it('handles an all-invalid batch without persisting anything', async () => {
    const ledger = new Ledger({
      store: new InMemoryEventStore(),
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });
    const results = await ledger.appendMany([{ type: 'nope' }, { bad: true }]);
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(await ledger.count()).toBe(0);
  });
});

describe('FileEventStore batch durability', () => {
  it('persists the whole batch as JSON Lines and survives reopen', async () => {
    const path = tmpPath();
    const ledger = await createFileLedger(path, {
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });
    await ledger.appendMany([note('one'), note('two'), note('three')]);

    // On-disk: exactly three JSON lines.
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);

    // Reopen and confirm the chain is intact and verifiable.
    const reopened = new Ledger({
      store: await FileEventStore.open(path),
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });
    const all = await reopened.readAll();
    expect(all.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect((await reopened.verify()).ok).toBe(true);
  });

  it('rejects a batch whose records are not a contiguous run', async () => {
    const store = await FileEventStore.open(tmpPath());
    const ledger = new Ledger({
      store,
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });
    const built = await ledger.appendMany([note('one')]);
    expect(built[0]!.ok).toBe(true);
    if (!built[0]!.ok) return;
    const valid = built[0]!.value;

    // Hand the store a record at the wrong seq: CONFLICT, nothing persisted.
    const bad = { ...valid, seq: 99 };
    const res = await store.appendBatch([bad]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CONFLICT');
    expect(await store.count()).toBe(1);
  });
});
