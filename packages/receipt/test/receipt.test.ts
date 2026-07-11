import {
  createInMemoryLedger,
  FixedClock,
  publishLedgerHeadAnchor,
  SequentialIdGenerator,
  InMemoryAnchorStore,
} from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import { generateReceipt } from '../src/generate.js';
import { verifyReceipt } from '../src/verify.js';

async function setupLedgerWithEvents(count: number) {
  const ledger = createInMemoryLedger({
    clock: new FixedClock(1_000_000),
    ids: new SequentialIdGenerator(),
  });
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const res = await ledger.append({
      type: 'note',
      actorId: `agent-${i}`,
      payload: { text: `step-${i}` },
    });
    if (!res.ok) throw new Error(`append failed: ${res.error.message}`);
    records.push(res.value);
  }
  const ids = new SequentialIdGenerator();
  const anchorStore = new InMemoryAnchorStore();
  const anchorResult = await publishLedgerHeadAnchor({
    ledger,
    store: anchorStore,
    clock: new FixedClock(2_000_000),
    ids,
  });
  if (!anchorResult.ok) throw new Error('anchor failed');
  return { ledger, records, anchor: anchorResult.value };
}

describe('Receipt', () => {
  it('generates and verifies a receipt for the most recent event (chain empty)', async () => {
    const { ledger, anchor } = await setupLedgerWithEvents(3);
    const receipt = await generateReceipt({ ledger, anchor, seq: 3 });
    expect(receipt.chain).toHaveLength(0);
    expect(receipt.event.seq).toBe(3);
    expect(receipt.anchor.seq).toBe(3);

    const result = verifyReceipt(receipt);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('generates and verifies a receipt for an older event (chain non-empty)', async () => {
    const { ledger, anchor } = await setupLedgerWithEvents(5);
    const receipt = await generateReceipt({ ledger, anchor, seq: 2 });
    expect(receipt.chain).toHaveLength(3); // seqs 3, 4, 5
    expect(receipt.event.seq).toBe(2);

    const result = verifyReceipt(receipt);
    expect(result.ok).toBe(true);
    expect(result.anchoredHeadHash).toBe(anchor.headHash);
  });

  it('detects an altered event payload', async () => {
    const { ledger, anchor } = await setupLedgerWithEvents(4);
    const receipt = await generateReceipt({ ledger, anchor, seq: 2 });
    // Tamper: mutate the payload but leave the hash alone.
    const tampered = {
      ...receipt,
      event: { ...receipt.event, event: { ...(receipt.event.event as object), tampered: true } },
    };
    const result = verifyReceipt(tampered);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === 'event_hash_mismatch')).toBe(true);
  });

  it('detects a broken chain (prevHash altered)', async () => {
    const { ledger, anchor } = await setupLedgerWithEvents(5);
    const receipt = await generateReceipt({ ledger, anchor, seq: 1 });
    const tampered = JSON.parse(JSON.stringify(receipt));
    // Change the middle chain step's prevHash to nonsense
    tampered.chain[1].prevHash = '0'.repeat(64);
    const result = verifyReceipt(tampered);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === 'chain_break')).toBe(true);
  });

  it('rejects a receipt whose anchor headHash does not match the chain tip', async () => {
    const { ledger, anchor } = await setupLedgerWithEvents(3);
    const receipt = await generateReceipt({ ledger, anchor, seq: 1 });
    const tampered = JSON.parse(JSON.stringify(receipt));
    tampered.anchor.headHash = '1'.repeat(64);
    const result = verifyReceipt(tampered);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === 'anchor_mismatch')).toBe(true);
  });

  it('matches a trusted anchor head hash', async () => {
    const { ledger, anchor } = await setupLedgerWithEvents(3);
    const receipt = await generateReceipt({ ledger, anchor, seq: 2 });
    const result = verifyReceipt(receipt, { trustedAnchorHeadHash: anchor.headHash });
    expect(result.ok).toBe(true);
  });

  it('rejects when trusted anchor head hash differs from the receipt', async () => {
    const { ledger, anchor } = await setupLedgerWithEvents(3);
    const receipt = await generateReceipt({ ledger, anchor, seq: 1 });
    const result = verifyReceipt(receipt, { trustedAnchorHeadHash: '2'.repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.kind === 'anchor_reference_mismatch')).toBe(true);
  });

  it('throws if asked to prove an event beyond the anchor', async () => {
    const { ledger, anchor } = await setupLedgerWithEvents(2);
    await ledger.append({
      type: 'note',
      actorId: 'after-anchor',
      payload: { text: 'past-anchor' },
    });
    await expect(generateReceipt({ ledger, anchor, seq: 3 })).rejects.toThrow(/beyond anchor/);
  });

  it('rejects a structurally invalid receipt', () => {
    const result = verifyReceipt({ version: 99, garbage: true });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.kind).toBe('schema_invalid');
  });

  it('emits a stable projectId and anchorReference when supplied', async () => {
    const { ledger, anchor } = await setupLedgerWithEvents(2);
    const receipt = await generateReceipt({
      ledger,
      anchor,
      seq: 1,
      projectId: 'proj-7',
      anchorReference: 'rekor:1234567',
    });
    expect(receipt.projectId).toBe('proj-7');
    expect(receipt.anchorReference).toBe('rekor:1234567');
  });
});
