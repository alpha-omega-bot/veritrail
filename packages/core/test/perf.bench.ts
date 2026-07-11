import { bench, describe } from 'vitest';

import {
  createInMemoryLedger,
  FixedClock,
  SequentialIdGenerator,
  type Ledger,
} from '@veritrail/core';

/**
 * Build a fresh in-memory ledger seeded with the deterministic clock and id
 * generator used across the test suite. Isolated per benchmark iteration so
 * sequence state never leaks between runs.
 */
function freshLedger(): Ledger {
  return createInMemoryLedger({
    clock: new FixedClock(1_700_000_000_000),
    ids: new SequentialIdGenerator(),
  });
}

/** A minimal valid `note` event used as the canonical hot-path payload. */
function note(text: string): unknown {
  return { type: 'note', actorId: 'agent_bench', payload: { text } };
}

/** Drive a ledger to a given depth with `appendMany` for query/verify setup. */
async function seed(ledger: Ledger, count: number): Promise<void> {
  const batch: unknown[] = new Array(count);
  for (let i = 0; i < count; i += 1) batch[i] = note(`event-${i}`);
  await ledger.appendMany(batch);
}

describe('Ledger append hot path', () => {
  let ledger = freshLedger();
  bench(
    'single append',
    async () => {
      await ledger.append(note('hot'));
    },
    {
      setup: () => {
        ledger = freshLedger();
      },
    },
  );

  let batchLedger = freshLedger();
  const batch: unknown[] = Array.from({ length: 100 }, (_, i) => note(`b-${i}`));
  bench(
    'batch of 100',
    async () => {
      await batchLedger.appendMany(batch);
    },
    {
      setup: () => {
        batchLedger = freshLedger();
      },
    },
  );
});

describe('Ledger read hot path', () => {
  let seededLedger = freshLedger();
  bench(
    'queryAll over 10k records',
    async () => {
      await seededLedger.readAll();
    },
    {
      setup: async () => {
        seededLedger = freshLedger();
        await seed(seededLedger, 10_000);
      },
    },
  );

  let verifyLedger = freshLedger();
  bench(
    'verify chain over 10k records',
    async () => {
      await verifyLedger.verify();
    },
    {
      setup: async () => {
        verifyLedger = freshLedger();
        await seed(verifyLedger, 10_000);
      },
    },
  );
});
