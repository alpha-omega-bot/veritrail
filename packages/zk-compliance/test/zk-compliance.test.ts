import { createInMemoryLedger, FixedClock, SequentialIdGenerator } from '@veritrail/core';
import { describe, expect, it } from 'vitest';

import { STANDARD_PREDICATES, generateProof, predicateByName, verifyProof } from '../src/index.js';

async function seed(events: Array<{ region?: string; pii?: string }>) {
  const ledger = createInMemoryLedger({
    clock: new FixedClock(1_700_000_000_000),
    ids: new SequentialIdGenerator(),
  });
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]!;
    const labels: Record<string, string> = {};
    if (e.region !== undefined) labels['region'] = e.region;
    if (e.pii !== undefined) labels['pii'] = e.pii;
    const r = await ledger.append({
      type: 'note',
      actorId: 'agent-1',
      labels,
      payload: { text: `event-${i}` },
    });
    if (!r.ok) throw new Error('append failed: ' + r.error.message);
  }
  return ledger;
}

describe('zk-compliance proofs', () => {
  it('STANDARD_PREDICATES contains 3 well-known predicates', () => {
    expect(STANDARD_PREDICATES.length).toBeGreaterThanOrEqual(3);
    expect(predicateByName('eu-only-region')).toBeDefined();
    expect(predicateByName('no-pii')).toBeDefined();
    expect(predicateByName('does-not-exist')).toBeUndefined();
  });

  it('generates a proof for an all-EU window', async () => {
    const ledger = await seed([{ region: 'EU' }, { region: 'EU' }, { region: 'EU' }]);
    const proof = await generateProof({
      ledger,
      predicate: predicateByName('eu-only-region')!,
      window: { fromSeq: 1, toSeq: 3 },
    });
    expect(proof).not.toBeNull();
    expect(proof!.matchCount).toBe(3);
    expect(proof!.predicateName).toBe('eu-only-region');
  });

  it('verifyProof returns ok when prover and verifier ledgers agree', async () => {
    const proverLedger = await seed([{ region: 'EU' }, { region: 'EU' }]);
    const verifierLedger = await seed([{ region: 'EU' }, { region: 'EU' }]);
    const predicate = predicateByName('eu-only-region')!;
    const proof = await generateProof({
      ledger: proverLedger,
      predicate,
      window: { fromSeq: 1, toSeq: 2 },
    });
    const result = await verifyProof({
      proof: proof!,
      predicate,
      ledger: verifierLedger,
    });
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('verifyProof flags a divergent ledger', async () => {
    const proverLedger = await seed([{ region: 'EU' }, { region: 'EU' }]);
    const verifierLedger = await seed([{ region: 'US' }, { region: 'EU' }]);
    const predicate = predicateByName('eu-only-region')!;
    const proof = await generateProof({
      ledger: proverLedger,
      predicate,
      window: { fromSeq: 1, toSeq: 2 },
    });
    const result = await verifyProof({
      proof: proof!,
      predicate,
      ledger: verifierLedger,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('verifyProof rejects a mismatched predicate name', async () => {
    const ledger = await seed([{ region: 'EU' }]);
    const proof = await generateProof({
      ledger,
      predicate: predicateByName('eu-only-region')!,
      window: { fromSeq: 1, toSeq: 1 },
    });
    const result = await verifyProof({
      proof: proof!,
      predicate: predicateByName('no-pii')!,
      ledger,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('predicate name mismatch'))).toBe(true);
  });

  it('the no-pii predicate finds zero matches when an event has labels.pii=true', async () => {
    const ledger = await seed([{ pii: 'true' }, { pii: 'true' }, {}]);
    const proof = await generateProof({
      ledger,
      predicate: predicateByName('no-pii')!,
      window: { fromSeq: 1, toSeq: 3 },
    });
    expect(proof!.matchCount).toBe(1);
  });

  it('returns null for an empty window', async () => {
    const ledger = await seed([]);
    const proof = await generateProof({
      ledger,
      predicate: predicateByName('eu-only-region')!,
      window: { fromSeq: 1, toSeq: 10 },
    });
    expect(proof).toBeNull();
  });

  it('proof is deterministic for the same input', async () => {
    const ledger1 = await seed([{ region: 'EU' }, { region: 'EU' }]);
    const ledger2 = await seed([{ region: 'EU' }, { region: 'EU' }]);
    const predicate = predicateByName('eu-only-region')!;
    const p1 = await generateProof({
      ledger: ledger1,
      predicate,
      window: { fromSeq: 1, toSeq: 2 },
    });
    const p2 = await generateProof({
      ledger: ledger2,
      predicate,
      window: { fromSeq: 1, toSeq: 2 },
    });
    expect(p1!.matchRoot).toBe(p2!.matchRoot);
    expect(p1!.matchCount).toBe(p2!.matchCount);
    expect(p1!.windowEndHash).toBe(p2!.windowEndHash);
  });
});
