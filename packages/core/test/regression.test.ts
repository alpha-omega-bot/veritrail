import { randomUUID } from 'node:crypto';
import { appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFileLedger,
  createInMemoryLedger,
  FileEventStore,
  FixedClock,
  HmacSigner,
  SequentialIdGenerator,
  verifyChain,
} from '@veritrail/core';

describe('HmacSigner.verify hardening', () => {
  const signer = new HmacSigner('a-sufficiently-long-secret');

  it('returns false (never throws) for a same-length non-hex signature', () => {
    const sig = signer.sign('data');
    expect(signer.verify('data', sig)).toBe(true);
    expect(() => signer.verify('data', 'z'.repeat(sig.length))).not.toThrow();
    expect(signer.verify('data', 'z'.repeat(sig.length))).toBe(false);
  });

  it('returns false for a wrong-length signature', () => {
    expect(signer.verify('data', 'abc')).toBe(false);
  });
});

describe('FileEventStore torn-trailing-line recovery', () => {
  const paths: string[] = [];
  const tempPath = (): string => {
    const p = join(tmpdir(), `veritrail-torn-${randomUUID()}.ledger.jsonl`);
    paths.push(p);
    return p;
  };
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((p) => rm(p, { force: true })));
  });

  it('recovers the committed prefix when the last line is torn', async () => {
    const path = tempPath();
    const ledger = await createFileLedger(path, {
      clock: new FixedClock(1000),
      ids: new SequentialIdGenerator(),
    });
    await ledger.append({ type: 'note', actorId: 'a', payload: { text: 'one' } });
    await ledger.append({ type: 'note', actorId: 'a', payload: { text: 'two' } });

    // Simulate a crash mid-append: a partial JSON line at the tail.
    await appendFile(path, '{"seq":3,"id":"c","time', 'utf8');

    const store = await FileEventStore.open(path);
    expect(await store.count()).toBe(2);
    const report = verifyChain(await store.readAll());
    expect(report.ok).toBe(true);
  });
});

describe('applyQuery limit boundary', () => {
  it('returns zero records for limit: 0', async () => {
    const ledger = createInMemoryLedger({
      clock: new FixedClock(1),
      ids: new SequentialIdGenerator(),
    });
    for (const text of ['a', 'b', 'c']) {
      await ledger.append({ type: 'note', actorId: 'a', payload: { text } });
    }
    expect(await ledger.query({ limit: 0 })).toHaveLength(0);
    expect(await ledger.query({ limit: 2 })).toHaveLength(2);
  });
});

describe('verifyChain with a configured signer', () => {
  it('flags a record that has no signature when signing is enabled', async () => {
    const signer = new HmacSigner('a-sufficiently-long-secret');
    const ledger = createInMemoryLedger({
      clock: new FixedClock(1),
      ids: new SequentialIdGenerator(),
      signer,
    });
    await ledger.append({ type: 'note', actorId: 'a', payload: { text: 'x' } });
    const records = structuredClone(await ledger.readAll());
    const stripped = { ...records[0]! };
    delete (stripped as { signature?: string }).signature;

    const report = verifyChain([stripped], { signer });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === 'signature_invalid')).toBe(true);
  });
});
