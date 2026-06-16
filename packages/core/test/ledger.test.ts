import { describe, expect, it } from 'vitest';

import {
  computeRecordHash,
  createInMemoryLedger,
  FixedClock,
  HmacSigner,
  InMemoryEventStore,
  Ledger,
  SequentialIdGenerator,
  verifyChain,
  type LedgerRecord,
} from '@veritrail/core';

function freshLedger(signer?: HmacSigner): Ledger {
  return new Ledger({
    store: new InMemoryEventStore(),
    clock: new FixedClock(1_700_000_000_000),
    ids: new SequentialIdGenerator(),
    ...(signer ? { signer } : {}),
  });
}

async function appendNotes(ledger: Ledger, texts: string[]): Promise<void> {
  for (const text of texts) {
    const result = await ledger.append({ type: 'note', actorId: 'agent_1', payload: { text } });
    expect(result.ok).toBe(true);
  }
}

describe('Ledger append + chain', () => {
  it('assigns contiguous sequence numbers and links by hash', async () => {
    const ledger = freshLedger();
    await appendNotes(ledger, ['a', 'b', 'c']);
    const records = await ledger.readAll();

    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(records[0]!.prevHash).toBe('0'.repeat(64));
    expect(records[1]!.prevHash).toBe(records[0]!.hash);
    expect(records[2]!.prevHash).toBe(records[1]!.hash);

    const report = await ledger.verify();
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(3);
    expect(report.head).toBe(records[2]!.hash);
  });

  it('rejects an invalid event with a VALIDATION error', async () => {
    const ledger = freshLedger();
    const result = await ledger.append({ type: 'note', actorId: 'agent_1', payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION');
  });

  it('uses the injected clock for the authoritative timestamp', async () => {
    const ledger = freshLedger();
    await appendNotes(ledger, ['only']);
    const head = await ledger.head();
    expect(head!.timestamp).toBe(1_700_000_000_000);
  });
});

describe('Ledger tamper-evidence', () => {
  it('detects a mutated record and localizes it to one hash_mismatch', async () => {
    const ledger = freshLedger();
    await appendNotes(ledger, ['a', 'b', 'c']);
    const records = structuredClone(await ledger.readAll());

    // Mutate the content of record 2 without touching its hash.
    (records[1]!.event.payload as { text: string }).text = 'TAMPERED';

    const report = verifyChain(records);
    expect(report.ok).toBe(false);
    const mismatches = report.issues.filter((i) => i.kind === 'hash_mismatch');
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.seq).toBe(2);
  });

  it('detects a re-hashed record via a downstream chain break', async () => {
    const ledger = freshLedger();
    await appendNotes(ledger, ['a', 'b', 'c']);
    const records = structuredClone(await ledger.readAll());

    // Mutate record 2 AND recompute its hash, but leave record 3's prevHash stale.
    (records[1]!.event.payload as { text: string }).text = 'TAMPERED';
    const rehashed: LedgerRecord = { ...records[1]!, hash: computeRecordHash(records[1]!) };
    records[1] = rehashed;

    const report = verifyChain(records);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === 'chain_break' && i.seq === 3)).toBe(true);
  });

  it('detects a deleted record as a sequence gap', async () => {
    const ledger = freshLedger();
    await appendNotes(ledger, ['a', 'b', 'c']);
    const records = structuredClone(await ledger.readAll());
    records.splice(1, 1); // delete seq 2

    const report = verifyChain(records);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === 'seq_gap')).toBe(true);
  });
});

describe('Ledger signing', () => {
  it('signs records and verifies them; a forged signature is detected', async () => {
    const signer = new HmacSigner('a-sufficiently-long-secret');
    const ledger = freshLedger(signer);
    await appendNotes(ledger, ['a', 'b']);

    const clean = await ledger.verify();
    expect(clean.ok).toBe(true);
    const head = await ledger.head();
    expect(head!.signature).toBeDefined();
    expect(head!.signerKeyId).toBe('hmac-default');

    const records = structuredClone(await ledger.readAll());
    records[1] = { ...records[1]!, signature: 'deadbeef'.repeat(8) };
    const report = verifyChain(records, { signer });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === 'signature_invalid')).toBe(true);
  });
});

describe('createInMemoryLedger', () => {
  it('produces a working ledger', async () => {
    const ledger = createInMemoryLedger();
    const result = await ledger.append({ type: 'note', actorId: 'sys', payload: { text: 'hi' } });
    expect(result.ok).toBe(true);
    expect(await ledger.count()).toBe(1);
  });
});
