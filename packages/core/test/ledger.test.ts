import { describe, expect, it } from 'vitest';

import {
  computeRecordHash,
  createInMemoryLedger,
  Ed25519Signer,
  FixedClock,
  HmacSigner,
  InMemoryEventStore,
  Ledger,
  RemoteEd25519Signer,
  SequentialIdGenerator,
  verifyChain,
  type RemoteSignerClient,
  type LedgerRecord,
} from '@veritrail/core';

function freshLedger(signer?: HmacSigner | Ed25519Signer | RemoteEd25519Signer): Ledger {
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

  it('signs records with Ed25519 and rejects forged or wrong-key signatures', async () => {
    const signer = Ed25519Signer.generate({ keyId: 'ed-current' });
    const ledger = freshLedger(signer);
    await appendNotes(ledger, ['a', 'b']);

    const clean = await ledger.verify();
    expect(clean.ok).toBe(true);
    const head = await ledger.head();
    expect(head!.signature).toMatch(/^[0-9a-f]+$/);
    expect(head!.signerKeyId).toBe('ed-current');

    const records = structuredClone(await ledger.readAll());
    records[1] = { ...records[1]!, signature: 'deadbeef'.repeat(16) };
    const forged = verifyChain(records, { signer });
    expect(forged.ok).toBe(false);
    expect(forged.issues.some((i) => i.kind === 'signature_invalid')).toBe(true);

    const wrongKey = Ed25519Signer.generate({ keyId: 'ed-current' });
    const wrongKeyReport = verifyChain(await ledger.readAll(), { signer: wrongKey });
    expect(wrongKeyReport.ok).toBe(false);
    expect(wrongKeyReport.issues.some((i) => i.kind === 'signature_invalid')).toBe(true);
  });

  it('verifies Ed25519 records signed before key rotation', async () => {
    const previous = Ed25519Signer.generate({ keyId: 'ed-previous' });
    const previousLedger = freshLedger(previous);
    await appendNotes(previousLedger, ['before rotation']);
    const previousRecord = (await previousLedger.readAll())[0]!;

    const current = Ed25519Signer.generate({
      keyId: 'ed-current',
      trustedPublicKeys: { 'ed-previous': previous.publicKey()! },
    });
    const report = verifyChain([previousRecord], { signer: current });

    expect(report.ok).toBe(true);
  });

  it('signs through a remote Ed25519 client and verifies locally', async () => {
    const remoteKey = Ed25519Signer.generate({ keyId: 'kms-ed-current' });
    const publicKey = remoteKey.publicKey()!;
    let calls = 0;
    const client: RemoteSignerClient = {
      async sign(data) {
        calls += 1;
        return Buffer.from(remoteKey.sign(data.toString('utf8')), 'hex');
      },
    };
    const signer = new RemoteEd25519Signer({
      keyId: 'kms-ed-current',
      client,
      publicKey,
    });
    const ledger = freshLedger(signer);

    await appendNotes(ledger, ['remote']);

    expect(calls).toBe(1);
    const head = await ledger.head();
    expect(head!.signerKeyId).toBe('kms-ed-current');
    expect((await ledger.verify()).ok).toBe(true);
  });

  it('returns a STORAGE error when remote signing fails before persistence', async () => {
    const remoteKey = Ed25519Signer.generate({ keyId: 'kms-ed-current' });
    const signer = new RemoteEd25519Signer({
      keyId: 'kms-ed-current',
      publicKey: remoteKey.publicKey()!,
      client: {
        async sign() {
          throw new Error('kms unavailable');
        },
      },
    });
    const ledger = freshLedger(signer);

    const result = await ledger.append({
      type: 'note',
      actorId: 'agent_1',
      payload: { text: 'x' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('STORAGE');
    expect(await ledger.count()).toBe(0);
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
